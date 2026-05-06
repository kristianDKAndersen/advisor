"""Session state I/O for browser daemon."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def session_dir(session_id: str) -> Path:
    return Path.home() / ".advisor" / "browser-sessions" / session_id


def read_state(sid: str) -> dict[str, Any]:
    p = session_dir(sid) / "state.json"
    with open(p) as f:
        return json.load(f)


def write_state(sid: str, data: dict[str, Any]) -> None:
    d = session_dir(sid)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "state.json.tmp"
    tmp.write_text(json.dumps(data, indent=2))
    tmp.rename(d / "state.json")


def update_last_action(sid: str) -> None:
    state = read_state(sid)
    state["last_action_at"] = datetime.now(timezone.utc).isoformat()
    write_state(sid, state)
