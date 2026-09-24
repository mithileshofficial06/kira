"""Audio in: the microphone, or WAV files (for tests and the self-trigger check)."""
from __future__ import annotations

import queue
import time
import wave
from typing import Iterator

import numpy as np

from .vad import FRAME, SAMPLE_RATE


def _lowpass_kernel(ratio: float, taps: int = 63) -> np.ndarray:
    """Windowed-sinc low-pass at the new Nyquist, so downsampling does not fold hiss into the speech band."""
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(ratio * n) * ratio * np.hamming(taps)
    return (h / h.sum()).astype(np.float32)


def resample(audio: np.ndarray, src_rate: int, dst_rate: int = SAMPLE_RATE) -> np.ndarray:
    if src_rate == dst_rate or len(audio) == 0:
        return audio.astype(np.float32)
    if dst_rate < src_rate:
        audio = np.convolve(audio.astype(np.float32), _lowpass_kernel(dst_rate / src_rate), mode="same")
    n = int(round(len(audio) * dst_rate / src_rate))
    x_old = np.linspace(0.0, 1.0, num=len(audio), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, audio).astype(np.float32)


class StreamResampler:
    """Resamples a live stream chunk by chunk without seams: the filter and the sample clock carry over."""

    def __init__(self, src_rate: int, dst_rate: int = SAMPLE_RATE) -> None:
        self.step = src_rate / dst_rate
        self.kernel = _lowpass_kernel(dst_rate / src_rate) if dst_rate < src_rate else np.ones(1, dtype=np.float32)
        self._tail = np.zeros(len(self.kernel) - 1, dtype=np.float32)
        self._pos = 0.0  # next output sample, in input samples from the start of the filtered buffer
        self._prev = np.zeros(0, dtype=np.float32)

    def __call__(self, chunk: np.ndarray) -> np.ndarray:
        x = np.concatenate([self._tail, chunk.astype(np.float32)])
        y = np.convolve(x, self.kernel, mode="valid")  # one filtered sample per input sample
        if len(self.kernel) > 1:
            self._tail = x[len(x) - (len(self.kernel) - 1) :]
        y = np.concatenate([self._prev, y])  # the previous chunk's last sample, to interpolate across the seam
        idx = np.arange(self._pos, len(y) - 1, self.step)
        out = np.interp(idx, np.arange(len(y)), y) if len(idx) else np.zeros(0, dtype=np.float32)
        nxt = idx[-1] + self.step if len(idx) else self._pos
        self._prev = y[-1:]
        self._pos = nxt - (len(y) - 1)  # y[-1] becomes index 0 next time
        return out.astype(np.float32)


def frames_of(audio: np.ndarray) -> Iterator[np.ndarray]:
    for i in range(0, len(audio) - FRAME + 1, FRAME):
        yield audio[i : i + FRAME]


class MicSource:
    """Default (or chosen) microphone, 16 kHz mono float32, in 512-sample frames."""

    def __init__(self, device: int | None = None) -> None:
        import sounddevice as sd

        self._q: queue.Queue[np.ndarray] = queue.Queue(maxsize=400)
        self._rest = np.zeros(0, dtype=np.float32)
        info = sd.query_devices(device, "input")
        self.name = str(info["name"])
        self.rate = SAMPLE_RATE
        try:
            self.stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32", device=device, blocksize=FRAME, callback=self._cb)
        except Exception:  # device cannot do 16 kHz: capture natively and resample
            self.rate = int(info["default_samplerate"])
            self.stream = sd.InputStream(samplerate=self.rate, channels=1, dtype="float32", device=device, callback=self._cb)
        self._resample = StreamResampler(self.rate) if self.rate != SAMPLE_RATE else None
        self.stream.start()
        self.closed = False

    def _cb(self, indata, _frames, _time, _status) -> None:
        try:
            self._q.put_nowait(indata[:, 0].copy())
        except queue.Full:
            pass  # the engine is behind; dropping audio beats unbounded latency

    def frames(self) -> Iterator[np.ndarray]:
        while not self.closed:
            try:
                chunk = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            if self._resample is not None:
                chunk = self._resample(chunk)
            self._rest = np.concatenate([self._rest, chunk])
            while len(self._rest) >= FRAME:
                yield self._rest[:FRAME]
                self._rest = self._rest[FRAME:]

    def close(self) -> None:
        self.closed = True
        self.stream.stop()
        self.stream.close()


class InjectSource:
    """Real-time silence, with speech mixed in on demand (end-to-end tests drive a whole session this way)."""

    name = "injected speech"

    def __init__(self) -> None:
        self._q: queue.Queue[np.ndarray] = queue.Queue()
        self.closed = False

    def hear(self, audio: np.ndarray) -> None:
        self._q.put(audio.astype(np.float32))

    def frames(self) -> Iterator[np.ndarray]:
        silence = np.zeros(FRAME, dtype=np.float32)
        pending = np.zeros(0, dtype=np.float32)
        start, i = time.monotonic(), 0
        while not self.closed:
            if len(pending) < FRAME:
                try:
                    pending = np.concatenate([pending, self._q.get_nowait()])
                except queue.Empty:
                    pass
            if len(pending) >= FRAME:
                f, pending = pending[:FRAME], pending[FRAME:]
            else:
                f, pending = (np.concatenate([pending, silence[: FRAME - len(pending)]]) if len(pending) else silence), np.zeros(0, dtype=np.float32)
            i += 1
            delay = start + i * FRAME / SAMPLE_RATE - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            yield f

    def close(self) -> None:
        self.closed = True


def read_wav(path: str) -> np.ndarray:
    with wave.open(path) as w:
        rate, width, ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
        raw = w.readframes(w.getnframes())
    if width == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        a = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width {width}")
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return resample(a, rate)


class FileSource:
    """Plays WAV files into the engine, optionally in real time, with silence between them."""

    def __init__(self, paths: list[str], realtime: bool = True, gap_s: float = 1.0) -> None:
        self.paths, self.realtime, self.gap_s = paths, realtime, gap_s
        self.name = f"files: {', '.join(paths)}"
        self.closed = False

    def frames(self) -> Iterator[np.ndarray]:
        silence = np.zeros(int(self.gap_s * SAMPLE_RATE), dtype=np.float32)
        audio = np.concatenate([silence] + [np.concatenate([read_wav(p), silence]) for p in self.paths])
        start = time.monotonic()
        for i, f in enumerate(frames_of(audio)):
            if self.closed:
                return
            if self.realtime:
                due = start + (i + 1) * FRAME / SAMPLE_RATE
                delay = due - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
            yield f

    def close(self) -> None:
        self.closed = True
