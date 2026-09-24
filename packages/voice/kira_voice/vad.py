"""Silero VAD (ONNX, local) and an utterance segmenter on top of it.

The Silero model ships inside faster-whisper, so there is nothing extra to
download. It scores 512-sample frames (32 ms at 16 kHz). An utterance ends
after 300 ms of silence: the spec's VAD endpoint budget (§9.2).
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

import numpy as np

SAMPLE_RATE = 16_000
FRAME = 512  # samples per VAD frame (32 ms)
_CONTEXT = 64


def silero_model_path() -> str:
    import faster_whisper

    assets = os.path.join(os.path.dirname(faster_whisper.__file__), "assets")
    names = sorted(n for n in os.listdir(assets) if n.startswith("silero") and n.endswith(".onnx"))
    if not names:
        raise FileNotFoundError(f"no Silero VAD model in {assets}")
    return os.path.join(assets, names[-1])


class SileroVAD:
    """Streaming speech probability, one 512-sample frame at a time."""

    def __init__(self, path: str | None = None) -> None:
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(path or silero_model_path(), providers=["CPUExecutionProvider"], sess_options=opts)
        self.inputs = {i.name: i for i in self.session.get_inputs()}
        self.reset()

    def reset(self) -> None:
        # Two exports exist: the official one (state [2,1,128] + sr) and the one bundled
        # with faster-whisper (separate h and c [1,1,128], no sr).
        self.split_state = "c" in self.inputs
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, _CONTEXT), dtype=np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        x = np.concatenate([self.context, frame.reshape(1, -1).astype(np.float32)], axis=1)
        self.context = x[:, -_CONTEXT:]
        if self.split_state:
            prob, self.h, self.c = self.session.run(None, {"input": x, "h": self.h, "c": self.c})
        else:
            prob, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": np.array(SAMPLE_RATE, dtype=np.int64)})
        return float(np.asarray(prob).reshape(-1)[0])


@dataclass
class Utterance:
    audio: np.ndarray  # float32, 16 kHz, mono
    #: time.monotonic() when the last speech frame arrived: "end of speech" for latency.
    end_of_speech: float
    duration_s: float = field(init=False)

    def __post_init__(self) -> None:
        self.duration_s = len(self.audio) / SAMPLE_RATE


class Segmenter:
    """Turns a stream of frames into utterances: speech start, then 300 ms of silence."""

    def __init__(
        self,
        vad: SileroVAD,
        start_prob: float = 0.5,
        end_prob: float = 0.35,
        min_speech_ms: int = 96,
        end_silence_ms: int = 300,
        preroll_ms: int = 300,
        max_ms: int = 15_000,
        clock=time.monotonic,
    ) -> None:
        self.vad = vad
        self.start_prob, self.end_prob = start_prob, end_prob
        ms = lambda v: max(1, int(v / 1000 * SAMPLE_RATE / FRAME))  # noqa: E731
        self.min_speech, self.end_silence, self.preroll, self.max_frames = ms(min_speech_ms), ms(end_silence_ms), ms(preroll_ms), ms(max_ms)
        self.clock = clock
        self._pre: list[np.ndarray] = []
        self._buf: list[np.ndarray] = []
        self._speech_run = 0
        self._silence_run = 0
        self._in_speech = False
        self._last_speech_at = 0.0
        self.level = 0.0

    def feed(self, frame: np.ndarray) -> Utterance | None:
        p = self.vad(frame)
        self.level = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))
        now = self.clock()
        if not self._in_speech:
            self._pre = (self._pre + [frame])[-self.preroll :]
            self._speech_run = self._speech_run + 1 if p >= self.start_prob else 0
            if self._speech_run >= self.min_speech:
                self._in_speech = True
                self._buf = list(self._pre)
                self._silence_run = 0
                self._last_speech_at = now
            return None
        self._buf.append(frame)
        if p >= self.end_prob:
            self._silence_run = 0
            self._last_speech_at = now
        else:
            self._silence_run += 1
        if self._silence_run >= self.end_silence or len(self._buf) >= self.max_frames:
            audio = np.concatenate(self._buf).astype(np.float32)
            self._in_speech, self._buf, self._pre, self._speech_run = False, [], [], 0
            self.vad.reset()
            return Utterance(audio=audio, end_of_speech=self._last_speech_at)
        return None

    @property
    def in_speech(self) -> bool:
        return self._in_speech
