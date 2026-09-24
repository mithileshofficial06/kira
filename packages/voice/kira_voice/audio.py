"""Clean-up applied to an utterance before it is transcribed.

Laptop microphone arrays often deliver quiet audio with a DC offset and fan
rumble. Both Whisper and Voxtral transcribe noticeably better when speech sits
at a normal loudness, so each utterance is high-passed and brought to a steady
level first. numpy only: the sidecar has no scipy.
"""
from __future__ import annotations

import numpy as np

from .vad import SAMPLE_RATE

#: Speech loudness Whisper and Voxtral handle best, as RMS of the loud parts (about -20 dBFS).
TARGET_RMS = 0.1
PEAK_LIMIT = 0.95
#: Never amplify more than this: a near-silent clip is noise, and boosting it only helps hallucination.
MAX_GAIN = 30.0
#: Below this (about -60 dBFS) there is no voice to bring up.
NOISE_FLOOR = 1e-3


def high_pass(audio: np.ndarray, cutoff_hz: float = 80.0, rate: int = SAMPLE_RATE) -> np.ndarray:
    """Removes DC and low rumble (below any voice) with a smooth spectral roll-off."""
    if len(audio) < 64:
        return audio.astype(np.float32)
    spec = np.fft.rfft(audio.astype(np.float64))
    freqs = np.fft.rfftfreq(len(audio), 1.0 / rate)
    ramp = np.clip((freqs - cutoff_hz / 2) / (cutoff_hz / 2), 0.0, 1.0)  # 0 below cutoff/2, 1 above cutoff
    return np.fft.irfft(spec * ramp, n=len(audio)).astype(np.float32)


def speech_rms(audio: np.ndarray, frame: int = 512) -> float:
    """RMS of the louder frames: pauses between words should not count as quiet speech."""
    n = len(audio) // frame
    if n == 0:
        return float(np.sqrt(np.mean(audio**2))) if len(audio) else 0.0
    rms = np.sqrt(np.mean(audio[: n * frame].reshape(n, frame) ** 2, axis=1))
    loud = rms[rms >= np.percentile(rms, 60)]
    return float(np.sqrt(np.mean(loud**2)))


def normalize(audio: np.ndarray) -> np.ndarray:
    """High-pass, then scale the speech to TARGET_RMS without clipping."""
    x = high_pass(audio)
    level = speech_rms(x)
    if level < NOISE_FLOOR:
        return x
    gain = min(TARGET_RMS / level, MAX_GAIN)
    peak = float(np.max(np.abs(x))) * gain
    if peak > PEAK_LIMIT:
        gain *= PEAK_LIMIT / peak
    return (x * gain).astype(np.float32)
