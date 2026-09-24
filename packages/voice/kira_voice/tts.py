"""Text to speech: Voxtral TTS streamed into the speakers, with instant cached acknowledgements.

Latency (spec §9.2): the first audible word must come ≤2.0 s after the user
stops talking. Short fixed replies ("On it.", "Yes?", "Stopping.") are
synthesized once and cached, so they play the moment an utterance ends; real
answers stream sentence by sentence as the audio arrives.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import queue
import threading
import time
import urllib.request
import wave
from typing import Callable, Iterator

import numpy as np

MISTRAL_API = "https://api.mistral.ai/v1"
CACHED_PHRASES = ("On it.", "Mm-hm.", "Yes?", "Stopping.", "Sorry, I didn't catch that.")


def cache_dir() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.cache")
    d = os.path.join(base, "kira", "voice-cache")
    os.makedirs(d, exist_ok=True)
    return d


class VoxtralTTS:
    def __init__(self, api_key: str, voice: str = "gb_jane_confident", model: str = "voxtral-mini-tts-latest") -> None:
        self.api_key, self.voice, self.model = api_key, voice, model
        self.sample_rate = 24_000  # corrected from the first WAV we receive

    def _request(self, text: str, fmt: str, stream: bool) -> urllib.request.Request:
        return urllib.request.Request(
            f"{MISTRAL_API}/audio/speech",
            data=json.dumps({"model": self.model, "input": text, "voice": self.voice, "response_format": fmt, "stream": stream}).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )

    def synth(self, text: str) -> np.ndarray:
        """Whole clip as float32 mono (used for cached phrases)."""
        with urllib.request.urlopen(self._request(text, "wav", False), timeout=30) as r:
            wav_bytes = base64.b64decode(json.loads(r.read().decode())["audio_data"])
        with wave.open(io.BytesIO(wav_bytes)) as w:
            self.sample_rate = w.getframerate()
            width, frames = w.getsampwidth(), w.readframes(w.getnframes())
        if width == 2:
            return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
        if width == 4:
            return np.frombuffer(frames, dtype="<f4").astype(np.float32)
        raise ValueError(f"unsupported WAV sample width {width}")

    def stream(self, text: str, cancelled: Callable[[], bool] = lambda: False) -> Iterator[np.ndarray]:
        """Float32 PCM chunks as they arrive (SSE "speech.audio.delta" events)."""
        with urllib.request.urlopen(self._request(text, "pcm", True), timeout=30) as r:
            for raw in r:
                if cancelled():
                    return
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload in ("", "[DONE]"):
                    continue
                ev = json.loads(payload)
                data = ev.get("audio_data")
                if data:
                    yield np.frombuffer(base64.b64decode(data), dtype="<f4").astype(np.float32)


class PhraseCache:
    """Cached clips on disk, keyed by voice and text."""

    def __init__(self, tts: VoxtralTTS) -> None:
        self.tts = tts
        self.clips: dict[str, np.ndarray] = {}

    def path(self, text: str) -> str:
        h = hashlib.sha256(f"{self.tts.model}|{self.tts.voice}|{text}".encode()).hexdigest()[:16]
        return os.path.join(cache_dir(), f"{h}.npz")

    def warm(self, phrases=CACHED_PHRASES) -> None:
        for p in phrases:
            f = self.path(p)
            if os.path.exists(f):
                z = np.load(f)
                self.clips[p], self.tts.sample_rate = z["audio"], int(z["rate"])
                continue
            audio = self.tts.synth(p)
            np.savez(f, audio=audio, rate=self.tts.sample_rate)
            self.clips[p] = audio

    def get(self, text: str) -> np.ndarray | None:
        return self.clips.get(text)


class Player:
    """One output stream. play() queues audio; hush() drops everything queued (barge-in)."""

    def __init__(self, sample_rate: int, device: int | None = None) -> None:
        import sounddevice as sd

        self.sample_rate = sample_rate
        self._q: queue.Queue[np.ndarray] = queue.Queue()
        self._cur = np.zeros(0, dtype=np.float32)
        self._lock = threading.Lock()
        self._first_audio_cb: Callable[[float], None] | None = None
        self.playing_until = 0.0
        #: When the last audio (plus the device tail) stops being audible; unlike playing_until, hush() keeps it.
        self.audible_until = 0.0
        self.stream = sd.OutputStream(samplerate=sample_rate, channels=1, dtype="float32", device=device, callback=self._callback, blocksize=0, latency="low")
        self.stream.start()

    def _callback(self, out, frames, _time, _status) -> None:
        filled = 0
        with self._lock:
            while filled < frames:
                if len(self._cur) == 0:
                    try:
                        self._cur = self._q.get_nowait()
                    except queue.Empty:
                        break
                    if self._first_audio_cb:
                        cb, self._first_audio_cb = self._first_audio_cb, None
                        cb(time.monotonic())
                n = min(frames - filled, len(self._cur))
                out[filled : filled + n, 0] = self._cur[:n]
                self._cur = self._cur[n:]
                filled += n
        if filled < frames:
            out[filled:, 0] = 0.0

    def play(self, audio: np.ndarray, on_first_audio: Callable[[float], None] | None = None) -> None:
        if on_first_audio:
            self._first_audio_cb = on_first_audio
        self._q.put(audio.astype(np.float32))
        self.playing_until = max(self.playing_until, time.monotonic()) + len(audio) / self.sample_rate
        self.audible_until = self.playing_until + 0.35

    def hush(self) -> None:
        with self._lock:
            while not self._q.empty():
                self._q.get_nowait()
            self._cur = np.zeros(0, dtype=np.float32)
        self.playing_until = 0.0
        self.audible_until = min(self.audible_until, time.monotonic() + 0.35)

    @property
    def playing(self) -> bool:
        # A short tail covers device buffering: the mic still hears the last word.
        return time.monotonic() < self.playing_until + 0.35

    def close(self) -> None:
        self.stream.stop()
        self.stream.close()


class RemoteOut:
    """Kira's voice for a remote device (the phone): audio goes to the daemon instead of a sound card.

    Same interface as Player. Timing is estimated from the audio's length, so
    the engine's "is Kira still talking" rules keep working.
    """

    def __init__(self, rate: Callable[[], int], emit: Callable[[dict], None]) -> None:
        self.rate, self.emit = rate, emit
        self.playing_until = 0.0
        self.audible_until = 0.0

    def play(self, audio: np.ndarray, on_first_audio: Callable[[float], None] | None = None) -> None:
        now = time.monotonic()
        rate = self.rate()
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        self.emit({"type": "audio_out", "rate": rate, "pcm": base64.b64encode(pcm).decode("ascii")})
        if on_first_audio:
            on_first_audio(now)
        self.playing_until = max(self.playing_until, now) + len(audio) / rate
        self.audible_until = self.playing_until + 0.35

    def hush(self) -> None:
        self.emit({"type": "audio_hush"})
        self.playing_until = 0.0
        self.audible_until = min(self.audible_until, time.monotonic() + 0.35)

    @property
    def playing(self) -> bool:
        return time.monotonic() < self.playing_until

    def close(self) -> None:
        pass


class OutputRouter:
    """Sends Kira's voice to the laptop, the remote device, or both; the daemon switches it when a phone connects."""

    TARGETS = ("laptop", "remote", "both")

    def __init__(self, laptop, remote: RemoteOut, target: str = "laptop") -> None:
        self.laptop, self.remote = laptop, remote
        self.target = target

    def set_target(self, target: str) -> None:
        if target in self.TARGETS and target != self.target:
            self.hush()
            self.target = target

    def _outs(self) -> list:
        return {"laptop": [self.laptop], "remote": [self.remote], "both": [self.laptop, self.remote]}[self.target]

    def play(self, audio: np.ndarray, on_first_audio: Callable[[float], None] | None = None) -> None:
        for i, o in enumerate(self._outs()):
            o.play(audio, on_first_audio if i == 0 else None)

    def hush(self) -> None:
        for o in (self.laptop, self.remote):
            o.hush()

    @property
    def playing(self) -> bool:
        return any(o.playing for o in self._outs())

    @property
    def audible_until(self) -> float:
        return max(o.audible_until for o in self._outs())

    def close(self) -> None:
        self.laptop.close()
