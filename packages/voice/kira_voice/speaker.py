from __future__ import annotations

import re
import threading
import time
from typing import Any, Callable

from . import protocol
from .tts import PhraseCache, Player, VoxtralTTS


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p]


class VoiceSpeaker:
    """Cached acks play instantly; everything else streams from Voxtral, one sentence at a time."""

    def __init__(self, tts: VoxtralTTS, cache: PhraseCache, player: Player, emit: Callable[[dict[str, Any]], None] = protocol.emit) -> None:
        self.tts, self.cache, self.player, self.emit = tts, cache, player, emit
        self._generation = 0
        self._lock = threading.Lock()

    @property
    def playing(self) -> bool:
        return self.player.playing

    def say_cached(self, phrase: str, on_first_audio: Callable[[float], None] | None = None) -> bool:
        clip = self.cache.get(phrase)
        if clip is None:
            self.say(phrase, "")
            return False
        self.player.play(clip, on_first_audio)
        return True

    def hush(self) -> None:
        with self._lock:
            self._generation += 1
        self.player.hush()

    def say(self, text: str, speech_id: str) -> None:
        if not text.strip():
            return
        with self._lock:
            gen = self._generation
        threading.Thread(target=self._speak, args=(text, speech_id, gen), name="kira-voice-tts", daemon=True).start()

    def _speak(self, text: str, speech_id: str, gen: int) -> None:
        cancelled = lambda: gen != self._generation  # noqa: E731
        self.emit({"type": "speaking", "state": "start", "id": speech_id})
        try:
            for s in sentences(text):
                if cancelled():
                    break
                for chunk in self.tts.stream(s, cancelled):
                    if cancelled():
                        break
                    self.player.play(chunk)
            while self.player.playing and not cancelled():
                time.sleep(0.05)
        except Exception as e:
            self.emit({"type": "log", "level": "warn", "msg": f"speech failed: {e}"})
        finally:
            self.emit({"type": "speaking", "state": "end", "id": speech_id})
