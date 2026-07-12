from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from google.auth.exceptions import GoogleAuthError, RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from coolcalendar.models import AppConfig, CalendarEvent
from coolcalendar.services.events import build_event_lines, event_file_path

SCOPES = ["https://www.googleapis.com/auth/calendar.events"]


class GoogleCalendarSyncError(RuntimeError):
    pass


def _http_status(error: HttpError) -> int | None:
    response = getattr(error, "resp", None)
    status = getattr(response, "status", None)
    try:
        return int(status)
    except (TypeError, ValueError):
        return None


def default_sync_map_path() -> Path:
    return Path(__file__).resolve().parents[2] / "google_sync.json"


def google_calendar_ready(config: AppConfig) -> bool:
    has_inline_oauth = bool(config.google_oauth_client_id and config.google_oauth_client_secret)
    has_credentials_file = bool(config.google_credentials_path and config.google_credentials_path.exists())
    return bool(config.google_calendar_enabled and (has_inline_oauth or has_credentials_file))


def _client_config(config: AppConfig) -> dict[str, Any] | None:
    if not config.google_oauth_client_id or not config.google_oauth_client_secret:
        return None
    return {
        "installed": {
            "client_id": config.google_oauth_client_id,
            "client_secret": config.google_oauth_client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": ["http://localhost"],
        }
    }


def _load_sync_map(path: Path | None = None) -> dict[str, str]:
    map_path = path or default_sync_map_path()
    if not map_path.exists():
        return {}
    try:
        data = json.loads(map_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): str(value) for key, value in data.items() if value}


def _save_sync_map(sync_map: dict[str, str], path: Path | None = None) -> None:
    map_path = path or default_sync_map_path()
    map_path.write_text(json.dumps(sync_map, ensure_ascii=False, indent=2), encoding="utf-8")


def _path_for_google_event(sync_map: dict[str, str], google_event_id: str) -> Path | None:
    for path_text, stored_event_id in sync_map.items():
        if stored_event_id == google_event_id:
            return Path(path_text)
    return None


def _credentials(config: AppConfig, *, interactive: bool) -> Credentials:
    token_path = config.google_token_path
    credentials_path = config.google_credentials_path
    creds: Credentials | None = None

    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    if creds is not None and creds.valid:
        return creds

    if creds is not None and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except (GoogleAuthError, RefreshError) as exc:
            if not interactive:
                raise GoogleCalendarSyncError(
                    "Google Calendar auth expired. Reconnect Google Calendar."
                ) from exc
        else:
            token_path.parent.mkdir(parents=True, exist_ok=True)
            token_path.write_text(creds.to_json(), encoding="utf-8")
            return creds

    if not interactive:
        raise GoogleCalendarSyncError("Google Calendar login is required.")

    inline_config = _client_config(config)
    if inline_config is not None:
        flow = InstalledAppFlow.from_client_config(inline_config, SCOPES)
    else:
        if not credentials_path.exists():
            raise GoogleCalendarSyncError("Google OAuth Client ID/Secret or credentials.json is required.")
        flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), SCOPES)
    creds = flow.run_local_server(port=0)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json(), encoding="utf-8")
    return creds


def connect_google_calendar(config: AppConfig) -> None:
    _credentials(config, interactive=True)


def _service(config: AppConfig, *, interactive: bool = False) -> Any:
    creds = _credentials(config, interactive=interactive)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def _event_body(event: CalendarEvent, timezone: str) -> dict[str, Any]:
    body: dict[str, Any] = {
        "summary": event.title or "New event",
        "description": event.description or "",
        "extendedProperties": {
            "private": {
                "coolcalendar_file": str(event.file_path),
            }
        },
    }

    if event.all_day or not event.time_text or event.time_text == "종일":
        end_date = event.end_date or (event.date + dt.timedelta(days=1))
        if end_date <= event.date:
            end_date = event.date + dt.timedelta(days=1)
        body["start"] = {"date": event.date.isoformat()}
        body["end"] = {"date": end_date.isoformat()}
        return body

    start_time = dt.time.fromisoformat(event.time_text)
    start_dt = dt.datetime.combine(event.date, start_time)
    if event.end_time_text:
        end_dt = dt.datetime.combine(event.end_date or event.date, dt.time.fromisoformat(event.end_time_text))
        if end_dt <= start_dt:
            end_dt = start_dt + dt.timedelta(minutes=30)
    else:
        end_dt = start_dt + dt.timedelta(minutes=30)

    body["start"] = {"dateTime": start_dt.isoformat(), "timeZone": timezone}
    body["end"] = {"dateTime": end_dt.isoformat(), "timeZone": timezone}
    return body


def sync_event(config: AppConfig, event: CalendarEvent) -> str | None:
    if not google_calendar_ready(config):
        return None

    sync_map = _load_sync_map()
    key = str(event.file_path)
    event_id = sync_map.get(key)
    service = _service(config)
    body = _event_body(event, config.google_timezone or "Asia/Seoul")

    try:
        if event_id:
            result = (
                service.events()
                .update(calendarId=config.google_calendar_id or "primary", eventId=event_id, body=body)
                .execute()
            )
        else:
            result = service.events().insert(calendarId=config.google_calendar_id or "primary", body=body).execute()
    except HttpError as exc:
        if event_id and _http_status(exc) == 404:
            result = service.events().insert(calendarId=config.google_calendar_id or "primary", body=body).execute()
        else:
            raise GoogleCalendarSyncError(f"Google Calendar sync failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise GoogleCalendarSyncError(f"Google Calendar sync failed: {exc}") from exc

    google_event_id = str(result.get("id") or "")
    if google_event_id:
        sync_map[key] = google_event_id
        _save_sync_map(sync_map)
    return google_event_id or None


def sync_event_path(config: AppConfig, events_by_date: dict[dt.date, list[CalendarEvent]], path: Path) -> str | None:
    for events in events_by_date.values():
        for event in events:
            if event.file_path == path:
                return sync_event(config, event)
    return None


def delete_synced_event(config: AppConfig, file_path: Path) -> bool:
    if not google_calendar_ready(config):
        return False

    sync_map = _load_sync_map()
    key = str(file_path)
    event_id = sync_map.get(key)
    if not event_id:
        return False

    service = _service(config)
    try:
        service.events().delete(calendarId=config.google_calendar_id or "primary", eventId=event_id).execute()
    except HttpError as exc:
        if _http_status(exc) != 404:
            raise GoogleCalendarSyncError(f"Google Calendar delete failed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise GoogleCalendarSyncError(f"Google Calendar delete failed: {exc}") from exc

    sync_map.pop(key, None)
    _save_sync_map(sync_map)
    return True


def move_sync_mapping(old_path: Path, new_path: Path) -> None:
    if old_path == new_path:
        return
    sync_map = _load_sync_map()
    event_id = sync_map.pop(str(old_path), "")
    if event_id:
        sync_map[str(new_path)] = event_id
        _save_sync_map(sync_map)


def _parse_google_datetime(value: str, timezone: str) -> dt.datetime:
    normalized = value.replace("Z", "+00:00")
    parsed = dt.datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(timezone))
    return parsed.astimezone(ZoneInfo(timezone))


def _google_event_fields(item: dict[str, Any], timezone: str) -> tuple[dt.date, str, str, bool, dt.date | None, str]:
    start = item.get("start", {})
    end = item.get("end", {})
    title = str(item.get("summary") or "Google event")
    description = str(item.get("description") or "")

    if "date" in start:
        end_date = dt.date.fromisoformat(str(end["date"])) if "date" in end else None
        return dt.date.fromisoformat(str(start["date"])), title, description, True, end_date, ""

    date_time = str(start.get("dateTime") or "")
    if not date_time:
        raise GoogleCalendarSyncError(f"Google event has no start time: {title}")

    start_dt = _parse_google_datetime(date_time, timezone)
    end_date_time = str(end.get("dateTime") or "")
    if end_date_time:
        end_dt = _parse_google_datetime(end_date_time, timezone)
        return start_dt.date(), title, description, False, end_dt.date(), end_dt.strftime("%H:%M")
    return start_dt.date(), title, description, False, None, ""


def _google_event_time_text(item: dict[str, Any], timezone: str) -> str:
    start = item.get("start", {})
    if "date" in start:
        return ""
    date_time = str(start.get("dateTime") or "")
    if not date_time:
        return ""
    return _parse_google_datetime(date_time, timezone).strftime("%H:%M")


def import_events(
    config: AppConfig,
    event_dir: Path,
    start_date: dt.date,
    end_date: dt.date,
    *,
    interactive: bool = True,
) -> list[Path]:
    if not google_calendar_ready(config):
        raise GoogleCalendarSyncError("Google Calendar is not configured.")

    timezone = config.google_timezone or "Asia/Seoul"
    zone = ZoneInfo(timezone)
    time_min = dt.datetime.combine(start_date, dt.time.min, tzinfo=zone).isoformat()
    time_max = dt.datetime.combine(end_date, dt.time.min, tzinfo=zone).isoformat()
    service = _service(config, interactive=interactive)

    imported_paths: list[Path] = []
    sync_map = _load_sync_map()
    page_token: str | None = None
    event_dir.mkdir(parents=True, exist_ok=True)

    while True:
        try:
            response = (
                service.events()
                .list(
                    calendarId=config.google_calendar_id or "primary",
                    timeMin=time_min,
                    timeMax=time_max,
                    singleEvents=True,
                    orderBy="startTime",
                    pageToken=page_token,
                )
                .execute()
            )
        except HttpError as exc:
            raise GoogleCalendarSyncError(f"Google Calendar import failed: {exc}") from exc
        except Exception as exc:  # noqa: BLE001
            raise GoogleCalendarSyncError(f"Google Calendar import failed: {exc}") from exc

        for item in response.get("items", []):
            if item.get("status") == "cancelled":
                continue

            google_event_id = str(item.get("id") or "")
            if not google_event_id:
                continue

            event_date, title, description, all_day, event_end_date, end_time_text = _google_event_fields(item, timezone)
            time_text = "" if all_day else _google_event_time_text(item, timezone)
            existing_path = _path_for_google_event(sync_map, google_event_id)
            target_path = event_file_path(event_dir, event_date, title, exclude_path=existing_path)
            target_path.write_text(
                "\r\n".join(
                    build_event_lines(
                        event_date,
                        title,
                        description,
                        all_day=all_day,
                        time_text=time_text,
                        end_date=event_end_date,
                        end_time_text=end_time_text,
                        uid=f"{google_event_id}@google.calendar",
                    )
                ),
                encoding="utf-8",
            )
            if existing_path is not None and existing_path != target_path and existing_path.exists():
                existing_path.unlink()
                sync_map.pop(str(existing_path), None)
            sync_map[str(target_path)] = google_event_id
            imported_paths.append(target_path)

        page_token = response.get("nextPageToken")
        if not page_token:
            break

    _save_sync_map(sync_map)
    return imported_paths
