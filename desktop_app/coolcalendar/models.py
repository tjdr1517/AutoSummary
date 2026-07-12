from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class Message:
    key: int
    direction: str
    peer: str
    title: str
    when_text: str
    body: str
    file_path: str = ""
    link_url: str = ""

    @property
    def preview(self) -> str:
        source = " ".join(part for part in [self.title, self.body] if part).strip()
        source = " ".join(source.split())
        return source[:120] + ("..." if len(source) > 120 else "")


@dataclass(slots=True)
class CalendarEvent:
    file_path: Path
    date: dt.date
    title: str
    description: str
    time_text: str = ""
    all_day: bool = False
    end_date: dt.date | None = None
    end_time_text: str = ""


@dataclass(slots=True)
class MessageAnalysis:
    message_key: int
    summary: str = ""
    has_action_item: bool = False
    should_create_event: bool = False
    event_title: str = ""
    due_date: str = ""
    due_time: str = ""
    all_day: bool = True
    reason: str = ""
    auto_created_event_path: str = ""
    analyzed_at: str = ""
    model: str = ""
    error: str = ""


@dataclass(slots=True)
class AppConfig:
    db_path: Path
    event_dir: Path
    refresh_seconds: int = 15
    recent_limit: int = 250
    main_geometry: str = ""
    overlay_geometry: str = ""
    overlay_theme: str = "navy"
    overlay_opacity: int = 94
    overlay_font_scale: int = 100
    openai_api_key: str = ""
    openai_model: str = "gpt-5.4-mini"
    ai_auto_enabled: bool = False
    ai_auto_create_events: bool = True
    ai_last_processed_message_key: int = 0
    google_calendar_enabled: bool = False
    google_calendar_id: str = "primary"
    google_credentials_path: Path = Path("")
    google_oauth_client_id: str = ""
    google_oauth_client_secret: str = ""
    google_token_path: Path = Path("")
    google_timezone: str = "Asia/Seoul"
