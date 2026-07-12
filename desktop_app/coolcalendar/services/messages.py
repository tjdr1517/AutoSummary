from __future__ import annotations

import datetime as dt
import re
import shutil
import sqlite3
import tempfile
from pathlib import Path

from coolcalendar.models import Message


DATE_RE = re.compile(r"(\d{4})/(\d{2})/(\d{2})")
TIME_RE = re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?!\d)")
KOREAN_DATE_RE = re.compile(r"(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일?")
HINT_PATTERNS = [
    r"\d{1,2}\s*월\s*\d{1,2}\s*일?",
    r"\d{4}/\d{2}/\d{2}",
    r"\d{1,2}:\d{2}",
    r"오늘",
    r"내일",
    r"모레",
    r"오전\s*\d{1,2}시",
    r"오후\s*\d{1,2}시",
    r"까지",
]
KEYWORD_TAGS: list[tuple[str, str]] = [
    ("긴급", "긴급"),
    ("마감", "마감"),
    ("까지", "기한"),
    ("공지", "공지"),
    ("안내", "안내"),
    ("요청", "요청"),
    ("회의", "회의"),
    ("첨부", "첨부"),
]


def normalize_text(value: str) -> str:
    text = (value or "").replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    lines = [" ".join(line.split()) for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def detect_default_db() -> Path:
    memo_dir = Path.home() / "AppData" / "Local" / "CoolMessenger" / "Memo"
    candidates = [path for path in memo_dir.glob("*.udb") if path.is_file() and path.stat().st_size > 0]
    if not candidates:
        raise FileNotFoundError(f"No UDB file found in {memo_dir}")
    return max(candidates, key=lambda item: item.stat().st_size)


def snapshot_db(src_db: Path) -> tuple[Path, Path]:
    temp_dir = Path(tempfile.mkdtemp(prefix="coolcalendar_udb_"))
    dst_db = temp_dir / "memo.udb"
    shutil.copy2(src_db, dst_db)
    for ext in ("-wal", "-shm"):
        src = Path(str(src_db) + ext)
        if src.exists():
            shutil.copy2(src, Path(str(dst_db) + ext))
    return dst_db, temp_dir


class MessageService:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def read_recent(self, limit: int = 250, include_sent: bool = False) -> list[Message]:
        snapshot_path, temp_dir = snapshot_db(self.db_path)
        try:
            conn = sqlite3.connect(snapshot_path)
            conn.row_factory = sqlite3.Row
            messages = self._read_recent(conn, "tbl_recv", limit)
            if include_sent:
                messages.extend(self._read_recent(conn, "tbl_send", limit))
            messages.sort(key=lambda item: item.key)
            conn.close()
            return messages
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def _read_recent(self, conn: sqlite3.Connection, table_name: str, limit: int) -> list[Message]:
        if table_name == "tbl_recv":
            direction = "recv"
            person_col = "Sender"
            date_col = "ReceiveDate"
        else:
            direction = "send"
            person_col = "Receiver"
            date_col = "SendDate"
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
                key=int(row[0]),
                direction=direction,
                peer=(row[1] or "").strip(),
                title=(row[2] or "").strip(),
                when_text=(row[3] or "").strip(),
                body=row[4] or "",
                file_path=(row[5] or "").strip(),
                link_url=(row[6] or "").strip(),
            )
            for row in rows
        ]


def message_base_date(message: Message) -> dt.date:
    match = DATE_RE.search(message.when_text)
    if not match:
        return dt.date.today()
    return dt.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))


def guess_event_date(message: Message) -> dt.date:
    source = normalize_text(f"{message.title}\n{message.body}")
    base_date = message_base_date(message)

    full_match = DATE_RE.search(source)
    if full_match:
        return dt.date(int(full_match.group(1)), int(full_match.group(2)), int(full_match.group(3)))

    korean_match = KOREAN_DATE_RE.search(source)
    if korean_match:
        month = int(korean_match.group(1))
        day = int(korean_match.group(2))
        year = base_date.year
        candidate = dt.date(year, month, day)
        if candidate < base_date - dt.timedelta(days=180):
            candidate = dt.date(year + 1, month, day)
        return candidate

    if "모레" in source:
        return base_date + dt.timedelta(days=2)
    if "내일" in source:
        return base_date + dt.timedelta(days=1)
    return base_date


def guess_event_time(message: Message) -> str:
    source = normalize_text(f"{message.title}\n{message.body}")
    match = TIME_RE.search(source)
    if not match:
        return ""
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23 or minute > 59:
        return ""
    return f"{hour:02d}:{minute:02d}"


def extract_hints(message: Message) -> str:
    source = normalize_text(f"{message.title}\n{message.body}")
    hits: list[str] = []
    for pattern in HINT_PATTERNS:
        for item in re.findall(pattern, source):
            if item not in hits:
                hits.append(item)
        if len(hits) >= 2:
            break
    return ", ".join(hits[:2])


def summarize_message(message: Message) -> str:
    body = normalize_text(message.body)
    core = body or message.title or "(내용 없음)"
    if len(core) > 120:
        core = core[:120].rstrip() + "..."
    tags: list[str] = []
    source = f"{message.title}\n{body}"
    for key, tag in KEYWORD_TAGS:
        if key in source and tag not in tags:
            tags.append(tag)
    if not tags:
        tags.append("일반")
    hints = extract_hints(message)
    if hints:
        return f"[{', '.join(tags)}] {core} (기한/일시: {hints})"
    return f"[{', '.join(tags)}] {core}"


def build_event_description(message: Message) -> str:
    lines = [
        f"상대: {message.peer}",
        f"원본 일시: {message.when_text}",
        "",
        summarize_message(message),
        "",
        normalize_text(message.body),
    ]
    if message.file_path:
        lines.extend(["", f"첨부: {message.file_path}"])
    if message.link_url:
        lines.extend(["", f"링크: {message.link_url}"])
    return "\n".join(lines).strip()
