from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path

from openai import OpenAI

from coolcalendar.models import Message, MessageAnalysis
from coolcalendar.services.events import create_event
from coolcalendar.services.messages import build_event_description, message_base_date, normalize_text


DEFAULT_OPENAI_MODEL = "gpt-5.4-mini"

ANALYSIS_SCHEMA = {
    "type": "json_schema",
    "name": "coolmessenger_task_analysis",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "has_action_item": {"type": "boolean"},
            "should_create_event": {"type": "boolean"},
            "event_title": {"type": "string"},
            "due_date": {"type": "string"},
            "due_time": {"type": "string"},
            "all_day": {"type": "boolean"},
            "reason": {"type": "string"},
        },
        "required": [
            "summary",
            "has_action_item",
            "should_create_event",
            "event_title",
            "due_date",
            "due_time",
            "all_day",
            "reason",
        ],
        "additionalProperties": False,
    },
}


def default_analysis_store_path(db_path: Path | None = None) -> Path:
    base_dir = Path(__file__).resolve().parents[2] / "data" / "ai_analyses"
    key_source = str((db_path or Path("default")).resolve()) if db_path is not None else "default"
    digest = hashlib.sha1(key_source.encode("utf-8")).hexdigest()[:12]
    return base_dir / f"{digest}.json"


def resolved_api_key(config_key: str) -> str:
    return (config_key or "").strip() or os.getenv("OPENAI_API_KEY", "").strip()


def sanitize_model_name(value: str) -> str:
    return (value or "").strip() or DEFAULT_OPENAI_MODEL


def _normalize_iso_date(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    try:
        return dt.date.fromisoformat(raw).isoformat()
    except ValueError:
        return ""


def _normalize_hhmm(value: str) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    try:
        parsed = dt.time.fromisoformat(raw)
    except ValueError:
        return ""
    return parsed.strftime("%H:%M")


def _response_text(response) -> str:
    output_text = getattr(response, "output_text", "") or ""
    if output_text:
        return output_text

    output_items = getattr(response, "output", []) or []
    for item in output_items:
        if getattr(item, "type", "") != "message":
            continue
        for content in getattr(item, "content", []) or []:
            if getattr(content, "type", "") == "output_text":
                text_value = getattr(content, "text", "") or ""
                if text_value:
                    return text_value
    return ""


def format_analysis_for_display(analysis: MessageAnalysis) -> str:
    if analysis.error:
        return f"분석 실패: {analysis.error}"

    lines = [
        f"요약: {analysis.summary or '(비어 있음)'}",
        f"업무/요청 감지: {'예' if analysis.has_action_item else '아니오'}",
        f"자동 일정 추천: {'예' if analysis.should_create_event else '아니오'}",
    ]
    if analysis.event_title:
        lines.append(f"추천 제목: {analysis.event_title}")
    if analysis.due_date:
        due_text = analysis.due_date
        if analysis.due_time:
            due_text = f"{due_text} {analysis.due_time}"
        lines.append(f"감지된 기한: {due_text}")
    if analysis.reason:
        lines.extend(["", "AI 판단 근거", analysis.reason])
    if analysis.auto_created_event_path:
        lines.append(f"\n자동 생성 일정 파일: {analysis.auto_created_event_path}")
    if analysis.model:
        lines.append(f"\n사용 모델: {analysis.model}")
    return "\n".join(lines).strip()


def build_ai_event_description(message: Message, analysis: MessageAnalysis) -> str:
    parts = [
        "[AI 자동 정리]",
        f"요약: {analysis.summary or '요약 없음'}",
        f"판단 근거: {analysis.reason or '메시지에서 일정/마감 맥락을 감지했습니다.'}",
        "",
        "[원본 메시지]",
        build_event_description(message),
    ]
    return "\n".join(parts).strip()


def create_ai_event_from_analysis(message: Message, analysis: MessageAnalysis, event_dir: Path) -> Path | None:
    event_date_text = _normalize_iso_date(analysis.due_date)
    if not analysis.should_create_event or not event_date_text:
        return None

    event_date = dt.date.fromisoformat(event_date_text)
    event_time = _normalize_hhmm(analysis.due_time)
    all_day = analysis.all_day or event_time == ""
    title = (analysis.event_title or message.title or message.preview or "메시지 일정").strip()
    description = build_ai_event_description(message, analysis)
    return create_event(
        event_date,
        event_dir,
        title,
        description,
        all_day=all_day,
        time_text="" if all_day else event_time,
    )


class AIAnalysisStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or default_analysis_store_path()
        self._analyses: dict[int, MessageAnalysis] = {}
        self.reload()

    def reload(self) -> None:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self._analyses = {}
            return
        except json.JSONDecodeError:
            self._analyses = {}
            return

        analyses: dict[int, MessageAnalysis] = {}
        items = raw.get("analyses", []) if isinstance(raw, dict) else []
        for item in items:
            if not isinstance(item, dict):
                continue
            try:
                analysis = MessageAnalysis(
                    message_key=int(item.get("message_key", 0)),
                    summary=str(item.get("summary", "")),
                    has_action_item=bool(item.get("has_action_item", False)),
                    should_create_event=bool(item.get("should_create_event", False)),
                    event_title=str(item.get("event_title", "")),
                    due_date=str(item.get("due_date", "")),
                    due_time=str(item.get("due_time", "")),
                    all_day=bool(item.get("all_day", True)),
                    reason=str(item.get("reason", "")),
                    auto_created_event_path=str(item.get("auto_created_event_path", "")),
                    analyzed_at=str(item.get("analyzed_at", "")),
                    model=str(item.get("model", "")),
                    error=str(item.get("error", "")),
                )
            except (TypeError, ValueError):
                continue
            if analysis.message_key > 0:
                analyses[analysis.message_key] = analysis
        self._analyses = analyses

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "analyses": [asdict(item) for item in sorted(self._analyses.values(), key=lambda entry: entry.message_key)],
        }
        self.path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def get(self, message_key: int) -> MessageAnalysis | None:
        return self._analyses.get(int(message_key))

    def upsert(self, analysis: MessageAnalysis) -> None:
        self._analyses[int(analysis.message_key)] = analysis
        self.save()

    def values(self) -> dict[int, MessageAnalysis]:
        return dict(self._analyses)


class OpenAIMessageAnalyzer:
    def __init__(self, api_key: str, model: str = DEFAULT_OPENAI_MODEL) -> None:
        cleaned_key = resolved_api_key(api_key)
        if not cleaned_key:
            raise ValueError("OpenAI API 키가 설정되지 않았습니다.")
        self.client = OpenAI(api_key=cleaned_key)
        self.model = sanitize_model_name(model)

    def analyze_message(self, message: Message) -> MessageAnalysis:
        base_date = message_base_date(message)
        prompt = self._build_prompt(message, base_date)
        response = self.client.responses.create(
            model=self.model,
            store=False,
            input=[
                {
                    "role": "developer",
                    "content": (
                        "너는 한국어 메신저 메시지를 캘린더 업무로 정리하는 비서다. "
                        "메시지를 짧게 요약하고, 실제로 캘린더에 넣을 만큼 구체적인 기한/일정/제출/회의/요청이 있는지 판단해라. "
                        "날짜가 불명확하면 억지로 만들지 말고 should_create_event를 false로 둬라."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            text={"format": ANALYSIS_SCHEMA},
        )

        raw_text = _response_text(response).strip()
        if not raw_text:
            raise ValueError("OpenAI 응답이 비어 있습니다.")
        payload = json.loads(raw_text)

        due_date = _normalize_iso_date(str(payload.get("due_date", "")))
        due_time = _normalize_hhmm(str(payload.get("due_time", "")))
        should_create_event = bool(payload.get("should_create_event", False)) and bool(due_date)
        has_action_item = bool(payload.get("has_action_item", False))
        all_day = bool(payload.get("all_day", True)) or due_time == ""

        return MessageAnalysis(
            message_key=message.key,
            summary=str(payload.get("summary", "")).strip(),
            has_action_item=has_action_item,
            should_create_event=should_create_event,
            event_title=str(payload.get("event_title", "")).strip(),
            due_date=due_date,
            due_time="" if all_day else due_time,
            all_day=all_day,
            reason=str(payload.get("reason", "")).strip(),
            analyzed_at=dt.datetime.now().isoformat(timespec="seconds"),
            model=self.model,
        )

    def _build_prompt(self, message: Message, base_date: dt.date) -> str:
        parts = [
            f"기준 날짜: {base_date.isoformat()}",
            "상대 날짜 표현(오늘/내일/이번 주 금요일 등)은 반드시 기준 날짜를 기준으로 해석해라.",
            "캘린더에 넣어야 할 경우는 제출 마감, 회의, 행사, 검사, 준비 요청, 확인 요청처럼 실제 행동이 필요한 경우다.",
            "단순 공지나 일반 홍보는 일정으로 만들지 말아라.",
            "due_date는 YYYY-MM-DD 형식 또는 빈 문자열로만 반환해라.",
            "due_time은 HH:MM 형식 또는 빈 문자열로만 반환해라.",
            "",
            f"보낸이/상대: {message.peer or '(이름 없음)'}",
            f"원본 시각: {message.when_text}",
            f"제목: {message.title}",
            f"첨부 경로: {message.file_path}",
            f"링크: {message.link_url}",
            "본문:",
            normalize_text(message.body),
        ]
        return "\n".join(parts).strip()
