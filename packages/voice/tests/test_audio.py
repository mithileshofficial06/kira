"""Audio clean-up, resampling and the Voxtral context bias: offline."""
from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from kira_voice.audio import PEAK_LIMIT, TARGET_RMS, normalize, speech_rms
from kira_voice.engine import Engine
from kira_voice.sources import StreamResampler
from kira_voice.stt import BASE_BIAS, VoxtralTranscriber, _multipart
from kira_voice.wake import split_wake


def tone(seconds: float, amp: float, hz: float = 300.0, rate: int = 16000) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return (amp * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def test_quiet_speech_is_brought_up_and_dc_removed():
    quiet = tone(1.0, 0.01) + 0.05  # a quiet voice on a DC offset
    out = normalize(quiet)
    assert abs(float(out.mean())) < 1e-3
    assert abs(speech_rms(out) - TARGET_RMS) < 0.02


def test_loud_speech_is_not_clipped():
    out = normalize(tone(1.0, 0.99))
    assert float(np.max(np.abs(out))) <= PEAK_LIMIT + 1e-6


def test_silence_is_not_amplified_into_noise():
    hiss = np.random.default_rng(0).normal(0, 1e-5, 16000).astype(np.float32)
    assert float(np.max(np.abs(normalize(hiss)))) < 1e-3


def test_stream_resampler_is_seamless_and_filters_aliases():
    rate = 48000
    t = np.arange(rate * 2) / rate
    x = (0.5 * np.sin(2 * np.pi * 440 * t) + 0.3 * np.sin(2 * np.pi * 12000 * t)).astype(np.float32)
    r = StreamResampler(rate)
    out = np.concatenate([r(x[i : i + 480]) for i in range(0, len(x), 480)])
    assert abs(len(out) - len(x) // 3) <= 1
    spec = np.abs(np.fft.rfft(out[1000:17000]))
    f = np.fft.rfftfreq(16000, 1 / 16000)
    assert spec[np.argmin(abs(f - 440))] > 100 * spec[np.argmin(abs(f - 4000))]  # 12 kHz would alias to 4 kHz
    # No clicks at chunk seams: the sample-to-sample change stays that of a 440 Hz sine.
    assert float(np.max(np.abs(np.diff(out[100:])))) < 0.1


def test_context_bias_terms_are_valid_and_capped():
    v = VoxtralTranscriber("k")
    v.set_vocabulary(["login-page.tsx", "has space", "a,b", "Kira", "dayjs"] + [f"w{i}" for i in range(200)])
    assert v.bias[: len(BASE_BIAS)] == list(BASE_BIAS)
    assert "login-page.tsx" in v.bias and "dayjs" in v.bias
    assert "has space" not in v.bias and "a,b" not in v.bias
    assert len(v.bias) == 100 and len({w.lower() for w in v.bias}) == 100


def test_multipart_repeats_fields():
    body, _ = _multipart([("context_bias", "Kira"), ("context_bias", "npm")], ("file", "a.wav", "audio/wav", b"x"))
    assert body.count(b'name="context_bias"') == 2


def test_common_mishearings_of_the_name_still_wake():
    for said in ("Hira, where did we leave off?", "Kyrah, stop.", "Keara build it"):
        assert split_wake(said)[0], said


def test_engine_meter_and_vocab_commands():
    events: list[dict] = []
    cloud = VoxtralTranscriber("k")
    seg = SimpleNamespace(level=0.2, in_speech=True, feed=lambda f: None)
    e = Engine(segmenter=seg, local=SimpleNamespace(transcribe=lambda a: ""), cloud=cloud, speaker=SimpleNamespace(), emit=events.append)  # type: ignore[arg-type]
    try:
        for _ in range(6):
            e.feed(np.zeros(512, dtype=np.float32))
        assert not events  # meter off by default
        e.command({"type": "meter", "on": True})
        for _ in range(6):
            e.feed(np.zeros(512, dtype=np.float32))
        assert [ev["type"] for ev in events] == ["level", "level"] and events[0]["speech"] is True
        e.command({"type": "vocab", "words": ["dayjs"]})
        assert "dayjs" in cloud.bias
    finally:
        e.close()
