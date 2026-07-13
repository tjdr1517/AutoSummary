from __future__ import annotations

import json
from pathlib import Path


def default_event_state_path() -> Path:
    return Path(__file__).resolve().parents[2] / "data" / "event_completion.json"


def load_completed_event_keys(path: Path | None = None) -> set[str]:
    state_path = path or default_event_state_path()
    if not state_path.exists():
        return set()
    try:
        payload = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    if not isinstance(payload, list):
        return set()
    return {str(value) for value in payload if isinstance(value, str) and value}


def set_event_completed(event_path: Path, completed: bool, path: Path | None = None) -> None:
    completed_keys = load_completed_event_keys(path)
    key = event_key(event_path)
    if completed:
        completed_keys.add(key)
    else:
        completed_keys.discard(key)
    _save_completed_event_keys(completed_keys, path)


def move_event_completion(old_path: Path, new_path: Path, path: Path | None = None) -> None:
    completed_keys = load_completed_event_keys(path)
    if event_key(old_path) not in completed_keys:
        return
    completed_keys.discard(event_key(old_path))
    completed_keys.add(event_key(new_path))
    _save_completed_event_keys(completed_keys, path)


def clear_event_completion(event_path: Path, path: Path | None = None) -> None:
    completed_keys = load_completed_event_keys(path)
    if event_key(event_path) in completed_keys:
        completed_keys.discard(event_key(event_path))
        _save_completed_event_keys(completed_keys, path)


def event_key(event_path: Path) -> str:
    return str(event_path.resolve()).casefold()


def _save_completed_event_keys(keys: set[str], path: Path | None = None) -> None:
    state_path = path or default_event_state_path()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = state_path.with_suffix(state_path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(sorted(keys), ensure_ascii=False, indent=2), encoding="utf-8")
    temporary_path.replace(state_path)
