"""JSON-lines protocol between the voice sidecar and the Kira daemon.

The sidecar is a child process of the daemon and talks over its own stdin and
stdout, so there is no listening socket at all (spec §7 asks for a localhost
WebSocket with a session token; a pipe to the parent is strictly narrower).

Sidecar -> daemon (stdout):
    {"type": "ready", "input": str, "output": str, "wake": str, "voice": str}
    {"type": "wake", "at": float}
    {"type": "utterance", "text": str, "heard": str, "source": "voxtral"|"local", "endOfSpeechAt": float}
    {"type": "stop", "heard": str, "endOfSpeechAt": float}
    {"type": "speaking", "state": "start"|"end", "id": str}
    {"type": "latency", "kind": "ack"|"stop", "ms": float}
    {"type": "log", "level": "info"|"warn"|"error", "msg": str}

Daemon -> sidecar (stdin):
    {"type": "say", "id": str, "text": str, "listen"?: bool}   # listen: the next sentence needs no wake word
    {"type": "hush"}
    {"type": "state", "running": bool, "awaiting"?: bool}      # awaiting: an approval wants yes or no
    {"type": "hear", "text": str}   # only with --source inject: speak this into the "mic" (tests)
    {"type": "shutdown"}
"""
from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any, Callable

_lock = threading.Lock()


def now() -> float:
    """Epoch milliseconds, comparable with the daemon's Date.now()."""
    return time.time() * 1000.0


def emit(msg: dict[str, Any], out=None) -> None:
    line = json.dumps(msg, ensure_ascii=False)
    with _lock:
        stream = out or sys.stdout
        stream.write(line + "\n")
        stream.flush()


def log(msg: str, level: str = "info") -> None:
    emit({"type": "log", "level": level, "msg": msg})


def read_commands(on_command: Callable[[dict[str, Any]], None], stream=None) -> threading.Thread:
    """Reads JSON lines from stdin on a daemon thread. EOF means the parent is gone: shut down."""

    def run() -> None:
        src = stream or sys.stdin
        for raw in src:
            raw = raw.strip()
            if not raw:
                continue
            try:
                on_command(json.loads(raw))
            except json.JSONDecodeError:
                log(f"bad command line: {raw[:120]}", "warn")
        on_command({"type": "shutdown", "reason": "stdin closed"})

    t = threading.Thread(target=run, name="kira-voice-stdin", daemon=True)
    t.start()
    return t
