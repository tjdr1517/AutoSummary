from __future__ import annotations

import json
from pathlib import Path

from coolcalendar.models import AppConfig
from coolcalendar.services.events import desktop_event_dir
from coolcalendar.services.messages import detect_default_db


def default_config_path() -> Path:
    return Path(__file__).resolve().parents[2] / "config.json"


def _default_google_credentials_path() -> Path:
    return default_config_path().with_name("google_credentials.json")


def _default_google_token_path() -> Path:
    return default_config_path().with_name("google_token.json")


def load_config(path: Path | None = None) -> AppConfig:
    config_path = path or default_config_path()
    if not config_path.exists():
        return AppConfig(
            db_path=detect_default_db(),
            event_dir=desktop_event_dir(),
            google_credentials_path=_default_google_credentials_path(),
            google_token_path=_default_google_token_path(),
        )

    data = json.loads(config_path.read_text(encoding="utf-8"))
    return AppConfig(
        db_path=Path(data.get("db_path") or detect_default_db()),
        event_dir=Path(data.get("event_dir") or desktop_event_dir()),
        refresh_seconds=int(data.get("refresh_seconds", 15)),
        recent_limit=int(data.get("recent_limit", 250)),
        main_geometry=str(data.get("main_geometry", "")),
        overlay_geometry=str(data.get("overlay_geometry", "")),
        overlay_theme=str(data.get("overlay_theme") or "navy"),
        overlay_opacity=int(data.get("overlay_opacity", 94)),
        overlay_font_scale=int(data.get("overlay_font_scale", 100)),
        openai_api_key=str(data.get("openai_api_key", "")),
        openai_model=str(data.get("openai_model") or "gpt-5.4-mini"),
        ai_auto_enabled=bool(data.get("ai_auto_enabled", False)),
        ai_auto_create_events=bool(data.get("ai_auto_create_events", True)),
        ai_last_processed_message_key=int(data.get("ai_last_processed_message_key", 0)),
        google_calendar_enabled=bool(data.get("google_calendar_enabled", False)),
        google_calendar_id=str(data.get("google_calendar_id") or "primary"),
        google_credentials_path=Path(data.get("google_credentials_path") or _default_google_credentials_path()),
        google_oauth_client_id=str(data.get("google_oauth_client_id", "")),
        google_oauth_client_secret=str(data.get("google_oauth_client_secret", "")),
        google_token_path=Path(data.get("google_token_path") or _default_google_token_path()),
        google_timezone=str(data.get("google_timezone") or "Asia/Seoul"),
    )


def save_config(config: AppConfig, path: Path | None = None) -> None:
    config_path = path or default_config_path()
    config_path.write_text(
        json.dumps(
            {
                "db_path": str(config.db_path),
                "event_dir": str(config.event_dir),
                "refresh_seconds": config.refresh_seconds,
                "recent_limit": config.recent_limit,
                "main_geometry": config.main_geometry,
                "overlay_geometry": config.overlay_geometry,
                "overlay_theme": config.overlay_theme,
                "overlay_opacity": config.overlay_opacity,
                "overlay_font_scale": config.overlay_font_scale,
                "openai_api_key": config.openai_api_key,
                "openai_model": config.openai_model,
                "ai_auto_enabled": config.ai_auto_enabled,
                "ai_auto_create_events": config.ai_auto_create_events,
                "ai_last_processed_message_key": config.ai_last_processed_message_key,
                "google_calendar_enabled": config.google_calendar_enabled,
                "google_calendar_id": config.google_calendar_id,
                "google_credentials_path": str(config.google_credentials_path or _default_google_credentials_path()),
                "google_oauth_client_id": config.google_oauth_client_id,
                "google_oauth_client_secret": config.google_oauth_client_secret,
                "google_token_path": str(config.google_token_path or _default_google_token_path()),
                "google_timezone": config.google_timezone,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
