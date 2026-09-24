"""The voice loop (spec §9.2):

    mic -> VAD (local) -> wake word (local) -> Voxtral STT -> daemon
    speaker <- Voxtral TTS <- daemon

Rules:
- Nothing leaves the machine until "Kira" is heard at the start of an utterance.
- "Kira, <task>" in one breath works; a bare "Kira" answers "Yes?" and listens.
- While a run is going, "stop" (with or without the wake word) cancels it at once.
- While Kira is speaking, only a wake-prefixed utterance counts (barge-in),
  so its own voice cannot trigger it; spoken text never contains its name.
- A conversation: after a reply that expects an answer (the daemon marks it
  "listen"), and all the while an approval is waiting, the next sentence needs
  no wake word. Speech that began while Kira was still audible, or that repeats
  what Kira just said, is its own echo and is ignored.
- With require_wake=False ("always listen") every sentence counts.

Accuracy: every utterance is cleaned up (audio.normalize) before it is
transcribed. The local model only needs the first few seconds (wake word,
"stop", and the first words that decide the acknowledgement); Voxtral hears
the whole sentence, biased toward the project's vocabulary.
"""
from __future__ import annotations

import os
import queue
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol

import numpy as np

from . import protocol
from .audio import normalize
from .stt import to_wav
from .vad import SAMPLE_RATE, Segmenter, Utterance
from .wake import is_stop, is_yes_no, looks_like_task, similar, speakable, split_wake, word_count

LISTEN_WINDOW_S = 8.0
#: After a reply that expects an answer, how long the next sentence needs no wake word.
FOLLOW_UP_S = 10.0
#: Slack for the VAD's pre-roll when deciding whether speech began while Kira was audible.
ECHO_SLACK_S = 0.25
#: People pause after "Kira," before the task. Wait this long before answering "Yes?",
#: so "Kira, ... build the login page" gets one acknowledgement, not a "Yes?" mid-sentence.
YES_GRACE_S = 0.7
#: After a sentence ends, how long to wait for more of it before acting on it.
CONTINUE_GRACE_S = 1.2
#: The local model transcribes only this much of an utterance: enough for the wake word and the first words.
HEAD_S = 4.0
#: With the meter on, send the mic level every this many frames (3 x 32 ms, about 10 Hz).
METER_EVERY = 3


class Transcriber(Protocol):
    def transcribe(self, audio: np.ndarray) -> str: ...


class Speaker(Protocol):
    """What the engine needs from TTS + playback."""

    def say_cached(self, phrase: str, on_first_audio: Callable[[float], None] | None = None) -> bool: ...
    def say(self, text: str, speech_id: str, on_done: Callable[[], None] | None = None) -> None: ...
    def hush(self) -> None: ...
    @property
    def playing(self) -> bool: ...
    @property
    def audible_until(self) -> float: ...


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
        require_wake: bool = True,
        save_dir: str | None = None,
    ) -> None:
        self.segmenter, self.local, self.cloud, self.speaker, self.emit, self.clock = segmenter, local, cloud, speaker, emit, clock
        self.require_wake = require_wake
        self.save_dir = save_dir
        self.meter = False  # send "level" events (the VS Code assistant's orb follows the voice)
        self._frames = 0
        self.running = False  # a Kira run is in progress (set by the daemon)
        self.awaiting = False  # an approval is waiting for "yes" or "no" (set by the daemon)
        self.listening_until = 0.0
        self.last_said = ""
        self._utterance_seq = 0
        self._stt_ms = 0.0
        self.stats = EngineStats()
        self._work: queue.Queue[Utterance | None] = queue.Queue()
        self._worker = threading.Thread(target=self._drain, name="kira-voice-stt", daemon=True)
        self._worker.start()

    # ---- from the daemon ---------------------------------------------------------
    def command(self, cmd: dict[str, Any]) -> None:
        t = cmd.get("type")
        if t == "say":
            text = speakable(str(cmd.get("text", "")))
            self.last_said = text
            on_done = self._follow_up if cmd.get("listen") else None
            self.speaker.say(text, str(cmd.get("id", "")), on_done)
        elif t == "hush":
            self.speaker.hush()
        elif t == "state":
            self.running = bool(cmd.get("running"))
            self.awaiting = bool(cmd.get("awaiting"))
        elif t == "vocab":
            if self.cloud is not None and hasattr(self.cloud, "set_vocabulary"):
                self.cloud.set_vocabulary([str(w) for w in cmd.get("words", [])])
        elif t == "meter":
            self.meter = bool(cmd.get("on"))

    def _follow_up(self) -> None:
        self.listening_until = self.clock() + FOLLOW_UP_S

    # ---- audio -------------------------------------------------------------------
    def feed(self, frame: np.ndarray) -> None:
        u = self.segmenter.feed(frame)
        if u is not None:
            self._work.put(u)
        if self.meter:
            self._frames += 1
            if self._frames % METER_EVERY == 0:
                self.emit({"type": "level", "rms": round(self.segmenter.level, 4), "speech": self.segmenter.in_speech})

    def _hear(self, audio: np.ndarray) -> str:
        """The local transcript of the start of an utterance: fast, private, good enough to route."""
        return self.local.transcribe(normalize(audio[: int(HEAD_S * SAMPLE_RATE)]))

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
        stt_ms = self._stt_ms

        def done(first_audio_at: float) -> None:
            self.emit({"type": "latency", "kind": kind, "ms": round((first_audio_at - end_of_speech) * 1000.0, 1), "sttMs": round(stt_ms, 1)})

        return done

    def _yes_after_grace(self, seq: int, end_of_speech: float) -> None:
        """Answer a bare "Kira" with "Yes?" only if nothing else was said in the meantime."""

        def fire() -> None:
            if seq == self._utterance_seq and not self.segmenter.in_speech and self.clock() < self.listening_until:
                self.speaker.say_cached("Yes?", self._latency("ack", end_of_speech))

        t = threading.Timer(YES_GRACE_S, fire)
        t.daemon = True
        t.start()

    def _own_ack(self, u: Utterance) -> bool:
        """Speech that overlapped Kira's audio and sounds like its acknowledgement is its echo."""
        if u.end_of_speech - u.duration_s + ECHO_SLACK_S >= self.speaker.audible_until:
            return False
        return similar(self._hear(u.audio), "On it. Mm-hm. Yes?") >= 0.5

    def _continuation(self, u: Utterance) -> tuple[np.ndarray, bool]:
        """People pause mid-sentence ("create hello.txt ... that says hi"). Wait briefly after the end of
        speech; if they keep talking, join the pieces so the task arrives whole. Timed on the real
        monotonic clock, like the VAD's end_of_speech."""
        audio, more, end = u.audio, False, u.end_of_speech
        gap = np.zeros(int(0.2 * 16000), dtype=np.float32)
        while True:
            try:
                nxt = self._work.get_nowait()
            except queue.Empty:
                nxt = None
            if nxt is None and (self.segmenter.in_speech or time.monotonic() < end + CONTINUE_GRACE_S):
                time.sleep(0.05)
                continue
            if nxt is None:
                return audio, more
            if nxt.duration_s >= 0.25 and not self._own_ack(nxt):  # a real continuation, not a click or our "On it."
                audio, more, end = np.concatenate([audio, gap, nxt.audio]), True, nxt.end_of_speech
            if self._work.empty() and not self.segmenter.in_speech and time.monotonic() >= end + CONTINUE_GRACE_S:
                return audio, more

    # ---- one utterance -----------------------------------------------------------
    def handle(self, u: Utterance) -> None:
        if u.duration_s < 0.25:
            return
        self._utterance_seq += 1
        speaking = self.speaker.playing
        t0 = time.perf_counter()
        heard = self._hear(u.audio)
        self._stt_ms = (time.perf_counter() - t0) * 1000.0
        woke, rest = split_wake(heard)
        eos_epoch = protocol.now() - (self.clock() - u.end_of_speech) * 1000.0

        # Stop: during a run, a bare "stop" works; while Kira is talking, it needs the wake word.
        if (woke and is_stop(rest)) or (self.running and not speaking and is_stop(heard)):
            self.stats.stops += 1
            self.speaker.hush()
            self.emit({"type": "stop", "heard": heard, "endOfSpeechAt": eos_epoch})
            self.speaker.say_cached("Stopping.", self._latency("stop", u.end_of_speech))
            return

        if not woke:
            listening = self.clock() < self.listening_until or self.awaiting or not self.require_wake
            if speaking or not listening:
                self.stats.ignored += 1
                return  # not addressed to Kira: it goes nowhere
            # Without the wake word, make sure this is not Kira hearing itself.
            began = u.end_of_speech - u.duration_s
            if began + ECHO_SLACK_S < self.speaker.audible_until or (self.last_said and word_count(heard) >= 3 and similar(heard, self.last_said) >= 0.6):
                self.stats.ignored += 1
                return

        if woke:
            self.stats.wakes += 1
            self.speaker.hush()  # barge-in
            self.emit({"type": "wake", "at": eos_epoch})
            if word_count(rest) == 0:  # "Kira, status" is a command; a bare "Kira" waits for one
                self.listening_until = self.clock() + LISTEN_WINDOW_S
                self._yes_after_grace(self._utterance_seq, u.end_of_speech)
                return

        self.listening_until = 0.0
        said = rest if woke else heard
        # Work gets "On it."; a question or a remark gets "Mm-hm." while the daemon thinks of an answer.
        # A yes/no to a waiting approval needs no ack: the daemon answers it at once.
        if not (self.awaiting and is_yes_no(said)):
            self.speaker.say_cached("On it." if looks_like_task(said) else "Mm-hm.", self._latency("ack", u.end_of_speech))
        audio, more = self._continuation(u)
        if more:
            heard = self._hear(audio)
            woke2, rest2 = split_wake(heard)
            said = rest2 if woke2 else heard
        text, source = said, "local"
        # A lone "no" to a waiting approval: the cloud model tends to write a sound-alike ("know"). Trust the local one.
        short_answer = self.awaiting and is_yes_no(said) and word_count(said) <= 3
        clean = normalize(audio)
        if self.cloud is not None and not short_answer:
            try:
                accurate = self.cloud.transcribe(clean)
                a_woke, a_rest = split_wake(accurate)
                text, source = (a_rest if a_woke else accurate) or text, "voxtral"
            except Exception as e:
                self.emit({"type": "log", "level": "warn", "msg": f"Voxtral transcription failed, using the local transcript: {e}"})
                if len(audio) > HEAD_S * SAMPLE_RATE:  # the head alone would cut the sentence short
                    full = self.local.transcribe(clean)
                    f_woke, f_rest = split_wake(full)
                    text = (f_rest if f_woke else full) or text
        self._save(clean, heard, text)
        if word_count(text) == 0:
            self.speaker.say_cached("Sorry, I didn't catch that.")
            return
        self.stats.utterances += 1
        self.emit({"type": "utterance", "text": text, "heard": heard, "source": source, "endOfSpeechAt": eos_epoch})

    def _save(self, audio: np.ndarray, heard: str, text: str) -> None:
        """--save-audio: keep each utterance with both transcripts, to tune recognition on a real voice."""
        if not self.save_dir:
            return
        try:
            os.makedirs(self.save_dir, exist_ok=True)
            stem = os.path.join(self.save_dir, time.strftime("%Y%m%d-%H%M%S") + f"-{self._utterance_seq:03d}")
            with open(stem + ".wav", "wb") as f:
                f.write(to_wav(audio))
            with open(stem + ".txt", "w", encoding="utf-8") as f:
                f.write(f"local: {heard}\nfinal: {text}\n")
        except OSError as e:
            self.emit({"type": "log", "level": "warn", "msg": f"could not save audio: {e}"})
