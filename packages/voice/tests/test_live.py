"""Phase 5 exit criteria, measured with real speech through the real pipeline.

"The user" is a Voxtral voice (Paul) different from Kira's (Jane). Clips are
fed at real-time pace, 32 ms per frame, so the 300 ms VAD endpoint is part of
every latency number. Playback is measured when the reply is handed to the
audio device; the device's own output latency (~20-60 ms with WASAPI) is not.

Needs MISTRAL_API_KEY (repo .env). Run: python -m pytest tests/test_live.py -s
"""
from __future__ import annotations

import os
import statistics
import time
from pathlib import Path

import numpy as np
import pytest

from kira_voice.engine import Engine
from kira_voice.sources import resample
from kira_voice.stt import LocalWhisper, VoxtralTranscriber
from kira_voice.tts import PhraseCache, VoxtralTTS
from kira_voice.vad import FRAME, SAMPLE_RATE, Segmenter, SileroVAD
from kira_voice.wake import speakable


def _key() -> str | None:
    if os.environ.get("MISTRAL_API_KEY"):
        return os.environ["MISTRAL_API_KEY"]
    env = Path(__file__).resolve().parents[3] / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("MISTRAL_API_KEY="):
                return line.split("=", 1)[1].strip() or None
    return None


KEY = _key()
pytestmark = pytest.mark.skipif(not KEY, reason="needs MISTRAL_API_KEY")

USER_VOICE = "en_paul_neutral"
KIRA_VOICE = "gb_jane_confident"


@pytest.fixture(scope="module")
def whisper() -> LocalWhisper:
    return LocalWhisper(os.environ.get("KIRA_WHISPER", "base.en"))  # the sidecar's default


def clip(text: str, voice: str = USER_VOICE) -> np.ndarray:
    """Speech for `text`, 16 kHz, cached on disk between runs."""
    tts = VoxtralTTS(KEY, voice=voice)  # type: ignore[arg-type]
    cache = PhraseCache(tts)
    cache.warm((text,))
    return resample(cache.clips[text], tts.sample_rate)


class RecordingSpeaker:
    def __init__(self) -> None:
        self.said: list[str] = []
        self.playing = False
        self.audible_until = float("-inf")  # nothing played yet

    def say_cached(self, phrase, on_first_audio=None):
        self.said.append(phrase)
        if on_first_audio:
            on_first_audio(time.monotonic())
        return True

    def say(self, text, speech_id, on_done=None):
        self.said.append(text)
        if on_done:
            on_done()

    def hush(self):
        pass


def run(engine: Engine, audio: np.ndarray, realtime: bool = True) -> None:
    padded = np.concatenate([np.zeros(SAMPLE_RATE // 2, np.float32), audio, np.zeros(SAMPLE_RATE, np.float32)])
    start = time.monotonic()
    for i in range(0, len(padded) - FRAME + 1, FRAME):
        if realtime:
            delay = start + (i + FRAME) / SAMPLE_RATE - time.monotonic()
            if delay > 0:
                time.sleep(delay)
        engine.feed(padded[i : i + FRAME])
    # Let the worker finish the last utterance (cloud transcription included).
    deadline = time.monotonic() + 20
    while not engine._work.empty() and time.monotonic() < deadline:  # noqa: SLF001
        time.sleep(0.05)
    time.sleep(0.3)


def make(whisper: LocalWhisper, cloud: bool = True):
    events: list[dict] = []
    speaker = RecordingSpeaker()
    engine = Engine(Segmenter(SileroVAD()), whisper, VoxtralTranscriber(KEY) if cloud else None, speaker, emit=events.append)  # type: ignore[arg-type]
    return engine, speaker, events


COMMANDS = [
    "Kira, build a login system with email and password.",
    "Kira, fix the failing test in billing.",
    "Kira, add a dark mode toggle to the settings page.",
    "Kira, where did we leave off?",
    "Kira, write unit tests for the money helpers.",
    "Kira, what is the status?",
]


def test_wake_and_command_with_latency_under_two_seconds(whisper):
    engine, speaker, events = make(whisper)
    for text in COMMANDS:
        run(engine, clip(text))
    engine.close()
    utterances = [e for e in events if e["type"] == "utterance"]
    acks = [e for e in events if e["type"] == "latency" and e["kind"] == "ack"]
    lat = [e["ms"] for e in acks]
    heard = [u["text"] for u in utterances]
    print(f"\nheard: {heard}\nack latency ms: {lat} p50={statistics.median(lat):.0f}; local STT ms: {[e['sttMs'] for e in acks]}")
    assert len(utterances) == len(COMMANDS), heard
    # One acknowledgement per command, no "Yes?" in the middle of a sentence: work gets "On it.", questions "Mm-hm.".
    assert speaker.said == ["On it.", "On it.", "On it.", "Mm-hm.", "On it.", "Mm-hm."], speaker.said
    assert "login" in heard[0].lower() and "billing" in heard[1].lower() and "dark mode" in heard[2].lower()
    assert all(u["source"] == "voxtral" for u in utterances)
    # Spec §10 Phase 5: p50 end of speech -> first audible word <= 2.0 s.
    assert statistics.median(lat) <= 2000


@pytest.mark.parametrize("text", ["Stop.", "Kira, stop!", "Cancel that."])
def test_stop_mid_run(whisper, text):
    engine, speaker, events = make(whisper, cloud=False)
    engine.running = True  # an install is in progress
    run(engine, clip(text))
    engine.close()
    stops = [e for e in events if e["type"] == "stop"]
    lat = [e["ms"] for e in events if e["type"] == "latency" and e["kind"] == "stop"]
    print(f"\n{text!r}: stop latency {lat}")
    assert len(stops) == 1 and speaker.said[-1] == "Stopping."
    assert lat and lat[0] <= 2000


NARRATION = [
    "On it. I'm creating the project and installing its dependencies.",
    "I need your OK to install a dependency: npm install react-dropzone. Say yes or no.",
    "Done. The login page works and the tests pass. One open concern in the report.",
    "Heads up: I've lowered my autonomy to step, because the same error appeared twice.",
    "Stopped. I rolled back step four, and nothing is left running.",
    "Last session, three days ago: the expense tracker. Auth is done and tested.",
    "The model provider is throttling me. Pausing for about thirty seconds.",
    "I couldn't finish. The build fails because a module is missing.",
]


def test_kira_does_not_trigger_on_its_own_voice(whisper):
    """Kira's own replies, played back into the mic, must never wake it or send anything anywhere."""
    engine, speaker, events = make(whisper)
    engine.running = True
    for i, line in enumerate(NARRATION):
        # Half of it arrives while playback is marked as running (echo), half after it (room reverb, late echo).
        speaker.playing = i % 2 == 0
        run(engine, clip(speakable(line), voice=KIRA_VOICE), realtime=False)
    engine.close()
    fired = [e for e in events if e["type"] in ("wake", "utterance", "stop")]
    print(f"\nnarration clips: {len(NARRATION)}, triggers: {fired}, ignored: {engine.stats.ignored}")
    assert fired == []


def test_a_conversation_needs_the_wake_word_only_once(whisper):
    """"Kira, are you listening?" -> Kira answers and keeps listening -> a follow-up without "Kira" is heard,
    while Kira's own answer echoing back through the room is not."""
    reply = "Yes, I'm listening. What should we build today?"
    # Synthesize first: generating a new clip mid-test takes longer than the follow-up window.
    ask, echo, follow = clip("Kira, are you listening to me?"), clip(reply, voice=KIRA_VOICE), clip("What kinds of projects can you build?")
    engine, speaker, events = make(whisper)
    run(engine, ask)
    # Like the daemon: the reply comes only once the question has arrived (a slow machine may still be transcribing).
    end = time.time() + 20
    while not any(e["type"] == "utterance" for e in events) and time.time() < end:
        time.sleep(0.05)
    engine.command({"type": "say", "id": "s1", "text": reply, "listen": True})  # the fake speaker finishes at once
    run(engine, echo, realtime=False)  # its own voice, late, through the room
    run(engine, follow)
    engine.close()
    heard = [e["text"] for e in events if e["type"] == "utterance"]
    print(f"\nheard: {heard}; said: {speaker.said}; ignored: {engine.stats.ignored}")
    assert len(heard) == 2 and "listening" in heard[0].lower() and "projects" in heard[1].lower(), heard
    assert speaker.said[0] == "Mm-hm." and speaker.said[-1] == "Mm-hm."
    assert engine.stats.ignored == 1


def test_an_approval_takes_a_plain_spoken_yes(whisper):
    engine, speaker, events = make(whisper)
    engine.command({"type": "state", "running": True, "awaiting": True})
    run(engine, clip("Yes, go ahead."))
    engine.close()
    heard = [e["text"].lower() for e in events if e["type"] == "utterance"]
    print(f"\nheard: {heard}; said: {speaker.said}")
    assert len(heard) == 1 and heard[0].startswith("yes")
    assert speaker.said == []  # no ack: the daemon answers it


def test_a_pause_in_the_middle_of_a_sentence_does_not_cut_the_task(whisper):
    first, second = clip("Kira, create a file named notes.txt"), clip("that contains the word banana.")
    engine, speaker, events = make(whisper)
    run(engine, np.concatenate([first, np.zeros(int(SAMPLE_RATE * 0.6), np.float32), second]))
    engine.close()
    heard = [e["text"] for e in events if e["type"] == "utterance"]
    print(f"\nheard: {heard}; said: {speaker.said}")
    assert len(heard) == 1 and "notes" in heard[0].lower() and "banana" in heard[0].lower(), heard
    assert speaker.said == ["On it."]
