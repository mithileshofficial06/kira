"""Engine rules with fake audio, transcribers and speaker: fast and offline."""
from __future__ import annotations

import numpy as np
import pytest

from kira_voice.engine import Engine
from kira_voice.vad import Utterance
from kira_voice.wake import is_stop, speakable, split_wake


class Script:
    """A transcriber that returns scripted text and counts calls."""

    def __init__(self, *texts: str, fail: bool = False) -> None:
        self.texts, self.calls, self.fail = list(texts), 0, fail

    def transcribe(self, audio: np.ndarray) -> str:
        self.calls += 1
        if self.fail:
            raise RuntimeError("capacity")
        return self.texts.pop(0) if self.texts else ""


class FakeSpeaker:
    def __init__(self) -> None:
        self.said: list[str] = []
        self.hushed = 0
        self.playing = False

    def say_cached(self, phrase, on_first_audio=None):
        self.said.append(phrase)
        if on_first_audio:
            on_first_audio(1.0)
        return True

    def say(self, text, speech_id):
        self.said.append(text)

    def hush(self):
        self.hushed += 1


class Clock:
    t = 0.0

    def __call__(self) -> float:
        return self.t


def make(local: Script, cloud: Script | None = None):
    events: list[dict] = []
    clock = Clock()
    speaker = FakeSpeaker()
    engine = Engine(segmenter=None, local=local, cloud=cloud, speaker=speaker, emit=events.append, clock=clock)  # type: ignore[arg-type]
    return engine, speaker, events, clock


def utt(seconds: float = 1.5) -> Utterance:
    return Utterance(audio=np.zeros(int(16000 * seconds), dtype=np.float32), end_of_speech=0.9)


def types(events: list[dict]) -> list[str]:
    return [e["type"] for e in events if e["type"] != "latency"]


def test_wake_word_parsing():
    assert split_wake("Kira, build a login system.") == (True, "build a login system.")
    assert split_wake("Hey Keira build it") == (True, "build it")
    assert split_wake("Kiera.") == (True, "")
    assert split_wake("I told Kira about it") == (False, "I told Kira about it")
    assert split_wake("Cardboard boxes") == (False, "Cardboard boxes")
    assert is_stop("Stop!") and is_stop("please cancel that") and not is_stop("stopwatch app")
    assert speakable("Kira finished the build. Ask Kira anything.") == "I finished the build. Ask I anything."


def test_one_breath_command_acks_instantly_then_sends_the_accurate_transcript():
    local, cloud = Script("Kira build a log in system"), Script("Kira, build a login system.")
    e, sp, ev, _ = make(local, cloud)
    e.handle(utt())
    assert types(ev) == ["wake", "utterance"]
    assert ev[-1]["text"] == "build a login system." and ev[-1]["source"] == "voxtral"
    assert sp.said == ["On it."]
    assert any(x["type"] == "latency" and x["kind"] == "ack" for x in ev)


def test_speech_without_the_wake_word_goes_nowhere():
    local, cloud = Script("so I was telling Sam about the login page"), Script()
    e, sp, ev, _ = make(local, cloud)
    e.handle(utt())
    assert ev == [] and sp.said == []
    assert cloud.calls == 0  # nothing leaves the machine before the wake word


def test_bare_wake_word_listens_for_the_next_sentence():
    local, cloud = Script("Kira.", "fix the failing test in billing"), Script("fix the failing test in billing.")
    e, sp, ev, clock = make(local, cloud)
    e.handle(utt(0.6))
    assert sp.said == ["Yes?"] and types(ev) == ["wake"]
    clock.t = 3.0
    e.handle(utt())
    assert types(ev) == ["wake", "utterance"] and ev[-1]["text"] == "fix the failing test in billing."


def test_listening_window_expires():
    local = Script("Kira.", "fix the failing test")
    e, sp, ev, clock = make(local, Script())
    e.handle(utt(0.6))
    clock.t = 30.0
    e.handle(utt())
    assert types(ev) == ["wake"]


@pytest.mark.parametrize("heard", ["Stop.", "Kira, stop!", "cancel", "wait"])
def test_stop_during_a_run(heard):
    e, sp, ev, _ = make(Script(heard))
    e.running = True
    e.handle(utt(0.7))
    assert types(ev) == ["stop"] and sp.said == ["Stopping."] and sp.hushed == 1


def test_bare_stop_is_ignored_when_nothing_is_running():
    e, sp, ev, _ = make(Script("stop"))
    e.handle(utt(0.7))
    assert ev == []


def test_while_speaking_only_the_wake_word_can_interrupt():
    # Kira's own voice (or the room) during playback: ignored, even "stop" without the wake word.
    e, sp, ev, _ = make(Script("the build passed and the server is up", "stop", "Kira, stop"))
    e.running, sp.playing = True, True
    e.handle(utt())
    e.handle(utt(0.7))
    assert ev == []
    e.handle(utt(0.7))
    assert types(ev) == ["stop"] and sp.hushed == 1


def test_cloud_failure_falls_back_to_the_local_transcript():
    e, sp, ev, _ = make(Script("Kira add a dark mode toggle"), Script(fail=True))
    e.handle(utt())
    assert ev[-1]["type"] == "utterance" and ev[-1]["text"] == "add a dark mode toggle" and ev[-1]["source"] == "local"


def test_very_short_noise_is_dropped():
    local = Script("Kira")
    e, sp, ev, _ = make(local)
    e.handle(utt(0.1))
    assert local.calls == 0 and ev == []


def test_say_never_speaks_its_own_name():
    e, sp, ev, _ = make(Script())
    e.command({"type": "say", "id": "1", "text": "Kira finished: the build passed."})
    assert sp.said == ["I finished: the build passed."]
