"""The voice loop (spec §9.2):

    mic -> VAD (local) -> wake word (local) -> Voxtral STT -> daemon
    speaker <- Voxtral TTS <- daemon

Rules:
- Nothing leaves the machine until "Kira" is heard at the start of an utterance.
- "Kira, <task>" in one breath works; a bare "Kira" answers "Yes?" and listens.
- While a run is going, "stop" (with or without the wake word) cancels it at once.
- While Kira is speaking, only a wake-prefixed utterance counts (barge-in),
  so its own voice cannot trigger it; spoken text never contains its name.
"""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol

import numpy as np

from . import protocol
from .vad import Segmenter, Utterance
from .wake import is_stop, speakable, split_wake, word_count

LISTEN_WINDOW_S = 8.0


class Transcriber(Protocol):
    def transcribe(self, audio: np.ndarray) -> str: ...


class Speaker(Protocol):
    """What the engine needs from TTS + playback."""

    def say_cached(self, phrase: str, on_first_audio: Callable[[float], None] | None = None) -> bool: ...
    def say(self, text: str, speech_id: str) -> None: ...
    def hush(self) -> None: ...
    @property
    def playing(self) -> bool: ...


@dataclass
class EngineStats:
    wakes: int = 0
    utterances: int = 0
    stops: int = 0
    ignored: int = 0


class Engine:
    def __init__(
        self,
        segmenter: Segmenter,
        local: Transcriber,
        cloud: Transcriber | None,
        speaker: Speaker,
        emit: Callable[[dict[str, Any]], None] = protocol.emit,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.segmenter, self.local, self.cloud, self.speaker, self.emit, self.clock = segmenter, local, cloud, speaker, emit, clock
        self.running = False  # a Kira run is in progress (set by the daemon)
        self.listening_until = 0.0
        self.stats = EngineStats()
        self._work: queue.Queue[Utterance | None] = queue.Queue()
        self._worker = threading.Thread(target=self._drain, name="kira-voice-stt", daemon=True)
        self._worker.start()

    # ---- from the daemon ---------------------------------------------------------
    def command(self, cmd: dict[str, Any]) -> None:
        t = cmd.get("type")
        if t == "say":
            self.speaker.say(speakable(str(cmd.get("text", ""))), str(cmd.get("id", "")))
        elif t == "hush":
            self.speaker.hush()
        elif t == "state":
            self.running = bool(cmd.get("running"))

    # ---- audio -------------------------------------------------------------------
    def feed(self, frame: np.ndarray) -> None:
        u = self.segmenter.feed(frame)
        if u is not None:
            self._work.put(u)

    def close(self) -> None:
        self._work.put(None)
        self._worker.join(timeout=5)

    def _drain(self) -> None:
        while True:
            u = self._work.get()
            if u is None:
                return
            try:
                self.handle(u)
            except Exception as e:  # never let one bad clip kill the loop
                self.emit({"type": "log", "level": "error", "msg": f"utterance failed: {e!r}"})

    def _latency(self, kind: str, end_of_speech: float) -> Callable[[float], None]:
        def done(first_audio_at: float) -> None:
            self.emit({"type": "latency", "kind": kind, "ms": round((first_audio_at - end_of_speech) * 1000.0, 1)})

        return done

    # ---- one utterance -----------------------------------------------------------
    def handle(self, u: Utterance) -> None:
        if u.duration_s < 0.25:
            return
        speaking = self.speaker.playing
        heard = self.local.transcribe(u.audio)
        woke, rest = split_wake(heard)
        eos_epoch = protocol.now() - (self.clock() - u.end_of_speech) * 1000.0

        # Stop: during a run, a bare "stop" works; while Kira is talking, it needs the wake word.
        if (woke and is_stop(rest)) or (self.running and not speaking and is_stop(heard)):
            self.stats.stops += 1
            self.speaker.hush()
            self.emit({"type": "stop", "heard": heard, "endOfSpeechAt": eos_epoch})
            self.speaker.say_cached("Stopping.", self._latency("stop", u.end_of_speech))
            return

        listening = self.clock() < self.listening_until
        if not woke and (speaking or not listening):
            self.stats.ignored += 1
            return  # not addressed to Kira: it goes nowhere

        if woke:
            self.stats.wakes += 1
            self.speaker.hush()  # barge-in
            self.emit({"type": "wake", "at": eos_epoch})
            if word_count(rest) < 2:
                self.listening_until = self.clock() + LISTEN_WINDOW_S
                self.speaker.say_cached("Yes?", self._latency("ack", u.end_of_speech))
                return

        self.listening_until = 0.0
        self.speaker.say_cached("On it.", self._latency("ack", u.end_of_speech))
        text, source = rest if woke else heard, "local"
        if self.cloud is not None:
            try:
                accurate = self.cloud.transcribe(u.audio)
                a_woke, a_rest = split_wake(accurate)
                text, source = (a_rest if a_woke else accurate) or text, "voxtral"
            except Exception as e:
                self.emit({"type": "log", "level": "warn", "msg": f"Voxtral transcription failed, using the local transcript: {e}"})
        if word_count(text) == 0:
            self.speaker.say_cached("Sorry, I didn't catch that.")
            return
        self.stats.utterances += 1
        self.emit({"type": "utterance", "text": text, "heard": heard, "source": source, "endOfSpeechAt": eos_epoch})
