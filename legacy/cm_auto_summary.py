#!/usr/bin/env python3
"""CoolMessenger UDB auto summarizer.

Reads CoolMessenger SQLite UDB files, summarizes new messages, and writes
daily markdown summaries. This module is also used by the GUI app.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


DATE_RE = re.compile(r"(\d{4})/(\d{2})/(\d{2})")
TIME_RE = re.compile(r"(\d{2}:\d{2}:\d{2})")
KOREAN_DATE_RE = re.compile(r"(?<!\d)(\d{1,2})\s*\uc6d4\s*(\d{1,2})\s*\uc77c")
TIME_HINT_RE = re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?!\d)")

KEYWORD_TAGS: list[tuple[str, str]] = [
    ("\uae34\uae09", "\uae34\uae09"),
    ("\ub9c8\uac10", "\ub9c8\uac10"),
    ("\uae4c\uc9c0", "\uae30\ud55c"),
    ("\uacf5\uc9c0", "\uacf5\uc9c0"),
    ("\uc548\ub0b4", "\uc548\ub0b4"),
    ("\uc694\uccad", "\uc694\uccad"),
    ("\ud68c\uc758", "\ud68c\uc758"),
    ("\ucca8\ubd80", "\ucca8\ubd80"),
]

HINT_PATTERNS = [
    r"\d{1,2}\uc6d4\s*\d{1,2}\uc77c",
    r"\d{4}/\d{2}/\d{2}",
    r"\d{1,2}:\d{2}",
    r"\uc624\ub298",
    r"\ub0b4\uc77c",
    r"\uc810\uc2ec\uc2dc\uac04\uae4c\uc9c0",
    r"\uc885\ub840\s*\uc804\uae4c\uc9c0",
    r"[^\s]{1,24}\uae4c\uc9c0",
]


@dataclass
class Message:
    direction: str
    key: int
    peer: str
    title: str
    when_text: str
    body: str
    file_path: str
    link_url: str


def parse_args() -> argparse.Namespace:
    default_output = Path.home() / "Documents" / "CoolMessenger Files" / "AutoSummary"
    parser = argparse.ArgumentParser(description="CoolMessenger message auto summarizer")
    parser.add_argument("--db-path", default="", help="Path to .udb file. Empty = auto-detect")
    parser.add_argument("--output-dir", default=str(default_output), help="Summary output directory")
    parser.add_argument("--state-file", default="", help="State file path. Empty = output_dir/state.json")
    parser.add_argument("--interval", type=float, default=5.0, help="Polling interval seconds")
    parser.add_argument(
        "--bootstrap",
        choices=["latest", "all"],
        default="latest",
        help="latest: start from current newest key, all: summarize existing history once",
    )
    parser.add_argument(
        "--force-bootstrap",
        action="store_true",
        help="Ignore existing state and apply current bootstrap mode again",
    )
    parser.add_argument("--include-sent", action="store_true", help="Also summarize tbl_send")
    parser.add_argument("--max-new-per-cycle", type=int, default=200, help="Read cap per table per cycle")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    return parser.parse_args()


def now_iso() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


def normalize_text(value: str) -> str:
    text = (value or "").replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.split("\n")]
    lines = [line for line in lines if line]
    return "\n".join(lines)


def preview_text(value: str, limit: int = 180) -> str:
    flat = re.sub(r"\s+", " ", normalize_text(value)).strip()
    if len(flat) <= limit:
        return flat
    return flat[:limit].rstrip() + "..."


def _message_base_date(msg: Message) -> dt.date:
    match = DATE_RE.search(msg.when_text)
    if not match:
        return dt.date.today()
    return dt.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))


def infer_tags(title: str, body: str) -> list[str]:
    source = f"{title}\n{body}"
    tags: list[str] = []
    for key, tag in KEYWORD_TAGS:
        if key in source and tag not in tags:
            tags.append(tag)
    if not tags:
        tags.append("\uc77c\ubc18")
    return tags


def extract_hint(text: str) -> str:
    hits: list[str] = []
    for pattern in HINT_PATTERNS:
        found = re.findall(pattern, text)
        for item in found:
            if item not in hits:
                hits.append(item)
        if len(hits) >= 2:
            break
    return ", ".join(hits[:2])


def summarize_message(msg: Message) -> str:
    title = msg.title.strip()
    body = normalize_text(msg.body)
    core = body or title or "(\ube44\uc5b4 \uc788\uc74c)"
    if len(core) > 120:
        core = core[:120].rstrip() + "..."
    tags = ", ".join(infer_tags(title, body))
    hint = extract_hint(f"{title}\n{body}")
    if hint:
        return f"[{tags}] {core} (\uae30\ud55c/\uc77c\uc2dc: {hint})"
    return f"[{tags}] {core}"


def direction_label(direction: str) -> str:
    return "\uc218\uc2e0" if direction == "recv" else "\ubc1c\uc2e0"


def guess_event_date(msg: Message) -> str:
    source = normalize_text(f"{msg.title}\n{msg.body}")
    base_date = _message_base_date(msg)

    full_match = DATE_RE.search(source)
    if full_match:
        return f"{full_match.group(1)}-{full_match.group(2)}-{full_match.group(3)}"

    korean_match = KOREAN_DATE_RE.search(source)
    if korean_match:
        month = int(korean_match.group(1))
        day = int(korean_match.group(2))
        year = base_date.year
        try:
            candidate = dt.date(year, month, day)
        except ValueError:
            candidate = base_date
        if candidate < base_date - dt.timedelta(days=180):
            candidate = dt.date(year + 1, month, day)
        return candidate.isoformat()

    if "\ubaa8\ub808" in source:
        return (base_date + dt.timedelta(days=2)).isoformat()
    if "\ub0b4\uc77c" in source:
        return (base_date + dt.timedelta(days=1)).isoformat()
    if "\uc624\ub298" in source:
        return base_date.isoformat()

    return base_date.isoformat()


def guess_event_time(msg: Message) -> str:
    source = normalize_text(f"{msg.title}\n{msg.body}")
    match = TIME_HINT_RE.search(source)
    if not match:
        return ""
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23 or minute > 59:
        return ""
    return f"{hour:02d}:{minute:02d}"


def is_all_day_message(msg: Message) -> bool:
    return guess_event_time(msg) == ""


def build_calendar_title(msg: Message) -> str:
    title = msg.title.strip()
    if title:
        return title
    return preview_text(msg.body, 40) or "\ucfe8\uba54\uc2e0\uc800 \uc77c\uc815"


def build_calendar_description(msg: Message) -> str:
    parts = [
        f"\uad6c\ubd84: {direction_label(msg.direction)}",
        f"\uc0c1\ub300: {msg.peer}",
        f"\uc77c\uc2dc: {msg.when_text}",
        "",
        normalize_text(msg.body),
    ]
    if msg.file_path:
        parts.extend(["", f"\ucca8\ubd80: {msg.file_path}"])
    if msg.link_url:
        parts.extend(["", f"\ub9c1\ud06c: {msg.link_url}"])
    return "\n".join(part for part in parts if part is not None).strip()


def desktop_calendar_drop_dir() -> Path:
    return Path.home() / "Desktop" / "CoolMessenger Calendar Drop"


def _ics_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[<>:\"/\\\\|?*]+", "_", value).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:80] or "event"


def create_ics_file(
    output_dir: Path,
    msg: Message,
    event_date: str,
    event_time: str = "",
    duration_minutes: int = 30,
    all_day: bool = False,
    title: str = "",
    description: str = "",
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)

    event_title = title.strip() or build_calendar_title(msg)
    event_desc = description.strip() or build_calendar_description(msg)
    start_date = dt.date.fromisoformat(event_date)
    uid = f"{uuid.uuid4()}@coolmessenger-autosummary"
    dtstamp = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Codex//CoolMessenger Auto Summary//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTAMP:{dtstamp}",
        f"SUMMARY:{_ics_escape(event_title)}",
        f"DESCRIPTION:{_ics_escape(event_desc)}",
    ]

    if all_day or not event_time:
        end_date = start_date + dt.timedelta(days=1)
        lines.extend(
            [
                f"DTSTART;VALUE=DATE:{start_date.strftime('%Y%m%d')}",
                f"DTEND;VALUE=DATE:{end_date.strftime('%Y%m%d')}",
                "X-MICROSOFT-CDO-ALLDAYEVENT:TRUE",
            ]
        )
    else:
        start_time = dt.time.fromisoformat(event_time)
        start_dt = dt.datetime.combine(start_date, start_time)
        end_dt = start_dt + dt.timedelta(minutes=duration_minutes)
        lines.extend(
            [
                f"DTSTART:{start_dt.strftime('%Y%m%dT%H%M%S')}",
                f"DTEND:{end_dt.strftime('%Y%m%dT%H%M%S')}",
            ]
        )

    lines.extend(["END:VEVENT", "END:VCALENDAR", ""])

    filename = f"{event_date}-{_safe_filename(event_title)}.ics"
    out_path = output_dir / filename
    out_path.write_text("\r\n".join(lines), encoding="utf-8")
    return out_path


def find_default_db() -> Path:
    memo_dir = Path.home() / "AppData" / "Local" / "CoolMessenger" / "Memo"
    if not memo_dir.exists():
        raise FileNotFoundError(f"Memo folder not found: {memo_dir}")
    candidates = [p for p in memo_dir.glob("*.udb") if p.is_file() and p.stat().st_size > 0]
    if not candidates:
        raise FileNotFoundError(f"No non-empty .udb found in: {memo_dir}")
    return max(candidates, key=lambda p: p.stat().st_size)


def snapshot_db(src_db: Path) -> tuple[Path, Path]:
    temp_dir = Path(tempfile.mkdtemp(prefix="cm_udb_snapshot_"))
    dst_db = temp_dir / "memo.udb"
    shutil.copy2(src_db, dst_db)
    for ext in ("-wal", "-shm"):
        src = Path(str(src_db) + ext)
        if src.exists():
            shutil.copy2(src, Path(str(dst_db) + ext))
    return dst_db, temp_dir


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;",
        (table_name,),
    )
    return cur.fetchone() is not None


def max_key(conn: sqlite3.Connection, table_name: str) -> int:
    if not table_exists(conn, table_name):
        return 0
    cur = conn.execute(f"SELECT COALESCE(MAX(MessageKey), 0) FROM {table_name};")
    row = cur.fetchone()
    if not row:
        return 0
    return int(row[0] or 0)


def fetch_messages_since(
    conn: sqlite3.Connection,
    table_name: str,
    since_key: int,
    limit: int,
) -> list[Message]:
    if table_name == "tbl_recv":
        direction = "recv"
        person_col = "Sender"
        date_col = "ReceiveDate"
    elif table_name == "tbl_send":
        direction = "send"
        person_col = "Receiver"
        date_col = "SendDate"
    else:
        return []

    if not table_exists(conn, table_name):
        return []

    sql = f"""
        SELECT
            MessageKey,
            COALESCE({person_col}, ''),
            COALESCE(Title, ''),
            COALESCE({date_col}, ''),
            COALESCE(MessageText, ''),
            COALESCE(FilePath, ''),
            COALESCE(LinkURL, '')
        FROM {table_name}
        WHERE MessageKey > ?
        ORDER BY MessageKey ASC
        LIMIT ?;
    """
    rows = conn.execute(sql, (since_key, limit)).fetchall()
    return [
        Message(
            direction=direction,
            key=int(row[0]),
            peer=(row[1] or "").strip(),
            title=(row[2] or "").strip(),
            when_text=(row[3] or "").strip(),
            body=row[4] or "",
            file_path=(row[5] or "").strip(),
            link_url=(row[6] or "").strip(),
        )
        for row in rows
    ]


def fetch_recent_messages(
    conn: sqlite3.Connection,
    table_name: str,
    limit: int,
) -> list[Message]:
    if table_name == "tbl_recv":
        direction = "recv"
        person_col = "Sender"
        date_col = "ReceiveDate"
    elif table_name == "tbl_send":
        direction = "send"
        person_col = "Receiver"
        date_col = "SendDate"
    else:
        return []

    if not table_exists(conn, table_name):
        return []

    sql = f"""
        SELECT
            MessageKey,
            COALESCE({person_col}, ''),
            COALESCE(Title, ''),
            COALESCE({date_col}, ''),
            COALESCE(MessageText, ''),
            COALESCE(FilePath, ''),
            COALESCE(LinkURL, '')
        FROM {table_name}
        ORDER BY MessageKey DESC
        LIMIT ?;
    """
    rows = conn.execute(sql, (limit,)).fetchall()
    rows.reverse()
    return [
        Message(
            direction=direction,
            key=int(row[0]),
            peer=(row[1] or "").strip(),
            title=(row[2] or "").strip(),
            when_text=(row[3] or "").strip(),
            body=row[4] or "",
            file_path=(row[5] or "").strip(),
            link_url=(row[6] or "").strip(),
        )
        for row in rows
    ]


def read_recent_from_db(db_path: Path, include_sent: bool, limit: int) -> list[Message]:
    snapshot_path, temp_dir = snapshot_db(db_path)
    try:
        conn = sqlite3.connect(snapshot_path)
        conn.row_factory = sqlite3.Row
        messages = fetch_recent_messages(conn, "tbl_recv", limit)
        if include_sent:
            messages.extend(fetch_recent_messages(conn, "tbl_send", limit))
        messages.sort(key=lambda m: m.key)
        conn.close()
        return messages
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def date_from_when_text(when_text: str) -> str:
    match = DATE_RE.search(when_text)
    if not match:
        return dt.date.today().isoformat()
    return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"


def time_from_when_text(when_text: str) -> str:
    match = TIME_RE.search(when_text)
    if not match:
        return dt.datetime.now().strftime("%H:%M:%S")
    return match.group(1)


def ensure_daily_file(output_dir: Path, date_text: str) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"summary-{date_text}.md"
    if not out_path.exists():
        header = [
            "# CoolMessenger Auto Summary",
            "",
            f"- Created: {now_iso()}",
            "",
        ]
        out_path.write_text("\n".join(header), encoding="utf-8-sig")
    return out_path


def append_summaries(output_dir: Path, messages: Iterable[Message]) -> int:
    written = 0
    for msg in messages:
        date_text = date_from_when_text(msg.when_text)
        out_path = ensure_daily_file(output_dir, date_text)
        time_text = time_from_when_text(msg.when_text)
        summary = summarize_message(msg)
        title = msg.title or "(no title)"
        peer = msg.peer or "(unknown)"
        preview = preview_text(msg.body, 220)
        lines = [
            f"## [{time_text}] {msg.direction} | {peer}",
            f"- key: {msg.key}",
            f"- title: {title}",
            f"- summary: {summary}",
        ]
        if preview:
            lines.append(f"- preview: {preview}")
        if msg.file_path:
            lines.append(f"- file_path: {msg.file_path}")
        if msg.link_url:
            lines.append(f"- link: {msg.link_url}")
        lines.append("")
        with out_path.open("a", encoding="utf-8") as f:
            f.write("\n".join(lines))
        written += 1
    return written


def load_state(state_path: Path) -> dict:
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(state_path: Path, state: dict) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8-sig")


def bootstrap_state(
    conn: sqlite3.Connection,
    state: dict,
    db_path: Path,
    bootstrap: str,
    include_sent: bool,
    force_bootstrap: bool,
) -> dict:
    if force_bootstrap:
        state = {}
    if state.get("db_path") != str(db_path):
        state = {}
    if state:
        state.setdefault("last_recv_key", 0)
        state.setdefault("last_send_key", 0)
        return state

    if bootstrap == "latest":
        state["last_recv_key"] = max_key(conn, "tbl_recv")
        state["last_send_key"] = max_key(conn, "tbl_send") if include_sent else 0
    else:
        state["last_recv_key"] = 0
        state["last_send_key"] = 0
    state["db_path"] = str(db_path)
    state["updated_at"] = now_iso()
    return state


def run_cycle(
    db_path: Path,
    output_dir: Path,
    state_path: Path,
    include_sent: bool,
    bootstrap: str,
    force_bootstrap: bool,
    max_new_per_cycle: int,
) -> tuple[int, dict]:
    snapshot_path, temp_dir = snapshot_db(db_path)
    try:
        conn = sqlite3.connect(snapshot_path)
        conn.row_factory = sqlite3.Row
        state = load_state(state_path)
        state = bootstrap_state(conn, state, db_path, bootstrap, include_sent, force_bootstrap)

        last_recv = int(state.get("last_recv_key", 0))
        last_send = int(state.get("last_send_key", 0))

        recv_messages = fetch_messages_since(conn, "tbl_recv", last_recv, max_new_per_cycle)
        send_messages: list[Message] = []
        if include_sent:
            send_messages = fetch_messages_since(conn, "tbl_send", last_send, max_new_per_cycle)

        written = append_summaries(output_dir, recv_messages + send_messages)

        if recv_messages:
            state["last_recv_key"] = recv_messages[-1].key
        if send_messages:
            state["last_send_key"] = send_messages[-1].key
        state["updated_at"] = now_iso()

        save_state(state_path, state)
        conn.close()
        return written, state
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    state_path = Path(args.state_file) if args.state_file else output_dir / "state.json"

    db_path = Path(args.db_path) if args.db_path else find_default_db()
    if not db_path.exists():
        print(f"[ERROR] DB not found: {db_path}")
        return 2

    print(f"[INFO] DB: {db_path}")
    print(f"[INFO] Output: {output_dir}")
    print(f"[INFO] State: {state_path}")
    print(f"[INFO] Bootstrap: {args.bootstrap}")
    print(f"[INFO] Include sent: {args.include_sent}")

    while True:
        try:
            written, state = run_cycle(
                db_path=db_path,
                output_dir=output_dir,
                state_path=state_path,
                include_sent=args.include_sent,
                bootstrap=args.bootstrap,
                force_bootstrap=args.force_bootstrap,
                max_new_per_cycle=args.max_new_per_cycle,
            )
            print(
                "[INFO] cycle done | "
                f"new summaries={written} "
                f"(last_recv_key={state.get('last_recv_key', 0)}, "
                f"last_send_key={state.get('last_send_key', 0)})"
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] cycle failed: {exc}", file=sys.stderr)

        if args.once:
            break
        time.sleep(max(args.interval, 1.0))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
