from __future__ import annotations

import datetime as dt
import uuid
from pathlib import Path

from coolcalendar.models import CalendarEvent, Message
from coolcalendar.services.event_state import clear_event_completion, move_event_completion
from coolcalendar.services.messages import build_event_description, guess_event_time


def desktop_event_dir() -> Path:
    return Path.home() / "Desktop" / "CoolMessenger Calendar Drop"


def escape_ics(value: str) -> str:
    return value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def unescape_ics(value: str) -> str:
    return value.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def safe_filename(value: str) -> str:
    bad = '<>:"/\\|?*'
    cleaned = "".join("_" if char in bad else char for char in value).strip()
    cleaned = " ".join(cleaned.split())
    return cleaned[:80] or "event"


def unique_event_path(event_dir: Path, event_date: dt.date, title_text: str) -> Path:
    base = event_dir / f"{event_date.isoformat()}-{safe_filename(title_text)}.ics"
    if not base.exists():
        return base

    index = 2
    while True:
        candidate = event_dir / f"{event_date.isoformat()}-{safe_filename(title_text)} ({index}).ics"
        if not candidate.exists():
            return candidate
        index += 1


def event_file_path(
    event_dir: Path,
    event_date: dt.date,
    title_text: str,
    *,
    exclude_path: Path | None = None,
) -> Path:
    base = event_dir / f"{event_date.isoformat()}-{safe_filename(title_text)}.ics"
    if exclude_path is not None and base == exclude_path:
        return base
    if not base.exists():
        return base

    index = 2
    while True:
        candidate = event_dir / f"{event_date.isoformat()}-{safe_filename(title_text)} ({index}).ics"
        if exclude_path is not None and candidate == exclude_path:
            return candidate
        if not candidate.exists():
            return candidate
        index += 1


def build_event_lines(
    event_date: dt.date,
    title_text: str,
    description: str,
    *,
    all_day: bool,
    time_text: str,
    end_date: dt.date | None = None,
    end_time_text: str = "",
    uid: str | None = None,
) -> list[str]:
    event_uid = uid or f"{uuid.uuid4()}@coolcalendar"
    dtstamp = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//CoolCalendar//Desktop App//KO",
        "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT",
        f"UID:{event_uid}",
        f"DTSTAMP:{dtstamp}",
        f"SUMMARY:{escape_ics(title_text)}",
        f"DESCRIPTION:{escape_ics(description)}",
    ]

    if all_day or not time_text:
        use_end_date = end_date or (event_date + dt.timedelta(days=1))
        if use_end_date <= event_date:
            use_end_date = event_date + dt.timedelta(days=1)
        lines.extend(
            [
                f"DTSTART;VALUE=DATE:{event_date.strftime('%Y%m%d')}",
                f"DTEND;VALUE=DATE:{use_end_date.strftime('%Y%m%d')}",
                "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE",
            ]
        )
    else:
        start_time = dt.time.fromisoformat(time_text)
        start_dt = dt.datetime.combine(event_date, start_time)
        if end_time_text:
            use_end_date = end_date or event_date
            end_dt = dt.datetime.combine(use_end_date, dt.time.fromisoformat(end_time_text))
            if end_dt <= start_dt:
                end_dt = start_dt + dt.timedelta(minutes=30)
        else:
            end_dt = start_dt + dt.timedelta(minutes=30)
        lines.extend(
            [
                f"DTSTART:{start_dt.strftime('%Y%m%dT%H%M%S')}",
                f"DTEND:{end_dt.strftime('%Y%m%dT%H%M%S')}",
            ]
        )

    lines.extend(["END:VEVENT", "END:VCALENDAR", ""])
    return lines


def create_event(
    event_date: dt.date,
    event_dir: Path,
    title: str,
    description: str,
    *,
    all_day: bool = False,
    time_text: str = "",
) -> Path:
    event_dir.mkdir(parents=True, exist_ok=True)
    title_text = title.strip() or "새 일정"
    file_path = event_file_path(event_dir, event_date, title_text)
    file_path.write_text(
        "\r\n".join(
            build_event_lines(
                event_date,
                title_text,
                description,
                all_day=all_day or time_text == "",
                time_text=time_text,
            )
        ),
        encoding="utf-8",
    )
    return file_path


def update_event(
    file_path: Path,
    *,
    event_date: dt.date,
    title: str,
    description: str,
    all_day: bool = False,
    time_text: str = "",
) -> Path:
    event_dir = file_path.parent
    event_dir.mkdir(parents=True, exist_ok=True)
    title_text = title.strip() or "새 일정"
    target_path = event_file_path(event_dir, event_date, title_text, exclude_path=file_path)
    target_path.write_text(
        "\r\n".join(
            build_event_lines(
                event_date,
                title_text,
                description,
                all_day=all_day or time_text == "",
                time_text=time_text,
            )
        ),
        encoding="utf-8",
    )
    if target_path != file_path and file_path.exists():
        file_path.unlink()
        move_event_completion(file_path, target_path)
    return target_path


def create_event_from_message(
    message: Message,
    event_date: dt.date,
    event_dir: Path,
    title: str | None = None,
    all_day: bool | None = None,
    time_text: str | None = None,
) -> Path:
    event_dir.mkdir(parents=True, exist_ok=True)
    title_text = title or message.title or message.preview or "메시지 일정"
    description = build_event_description(message)
    use_time = time_text if time_text is not None else guess_event_time(message)
    use_all_day = all_day if all_day is not None else (use_time == "")
    file_path = unique_event_path(event_dir, event_date, title_text)
    file_path.write_text(
        "\r\n".join(
            build_event_lines(
                event_date,
                title_text,
                description,
                all_day=use_all_day,
                time_text=use_time,
            )
        ),
        encoding="utf-8",
    )
    return file_path


def delete_event(file_path: Path) -> bool:
    try:
        file_path.unlink()
        clear_event_completion(file_path)
        return True
    except FileNotFoundError:
        return False


def parse_ics_file(path: Path) -> CalendarEvent | None:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return None

    title = ""
    description = ""
    event_date: dt.date | None = None
    end_date: dt.date | None = None
    time_text = ""
    end_time_text = ""
    all_day = False

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("SUMMARY:"):
            title = unescape_ics(line.partition(":")[2])
        elif line.startswith("DESCRIPTION:"):
            description = unescape_ics(line.partition(":")[2])
        elif line.startswith("X-MICROSOFT-CDO-ALLDAYEVENT:TRUE"):
            all_day = True
            time_text = "종일"
        elif line.startswith("DTSTART;VALUE=DATE:"):
            event_date = dt.datetime.strptime(line.partition(":")[2], "%Y%m%d").date()
            all_day = True
            time_text = "종일"
        elif line.startswith("DTEND;VALUE=DATE:"):
            end_date = dt.datetime.strptime(line.partition(":")[2], "%Y%m%d").date()
        elif line.startswith("DTSTART:"):
            start_dt = dt.datetime.strptime(line.partition(":")[2].rstrip("Z"), "%Y%m%dT%H%M%S")
            event_date = start_dt.date()
            time_text = start_dt.strftime("%H:%M")
        elif line.startswith("DTEND:"):
            end_dt = dt.datetime.strptime(line.partition(":")[2].rstrip("Z"), "%Y%m%dT%H%M%S")
            end_date = end_dt.date()
            end_time_text = end_dt.strftime("%H:%M")

    if event_date is None:
        return None

    return CalendarEvent(
        file_path=path,
        date=event_date,
        title=title or path.stem,
        description=description,
        time_text=time_text,
        all_day=all_day,
        end_date=end_date,
        end_time_text=end_time_text,
    )


def load_events(event_dir: Path) -> dict[dt.date, list[CalendarEvent]]:
    event_dir.mkdir(parents=True, exist_ok=True)
    grouped: dict[dt.date, list[CalendarEvent]] = {}
    for path in sorted(event_dir.glob("*.ics")):
        event = parse_ics_file(path)
        if event is None:
            continue

        if event.end_date is None or event.end_date <= event.date:
            grouped.setdefault(event.date, []).append(event)
            continue

        if event.all_day:
            visible_until = event.end_date - dt.timedelta(days=1)
        else:
            visible_until = event.end_date
        if visible_until < event.date:
            visible_until = event.date

        day = event.date
        while day <= visible_until:
            grouped.setdefault(day, []).append(event)
            day += dt.timedelta(days=1)

    for items in grouped.values():
        items.sort(key=lambda item: (item.time_text != "종일", item.time_text, item.title))
    return grouped
