"""Engine rules with fake audio, transcribers and speaker: fast and offline."""
from __future__ import annotations

import time
from types import SimpleNamespace

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
        self.audible_until = float("-inf")  # nothing played yet

    def say_cached(self, phrase, on_first_audio=None):
        self.said.append(phrase)
        if on_first_audio:
            on_first_audio(1.0)
        return True

    def say(self, text, speech_id, on_done=None):
        self.said.append(text)
        if on_done:
            on_done()

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
    engine = Engine(segmenter=SimpleNamespace(in_speech=False), local=local, cloud=cloud, speaker=speaker, emit=events.append, clock=clock)  # type: ignore[arg-type]
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
    assert sp.said == [] and types(ev) == ["wake"]
    time.sleep(0.9)  # nobody kept talking: now it asks
    assert sp.said == ["Yes?"]
    clock.t = 3.0
    e.handle(utt())
    assert types(ev) == ["wake", "utterance"] and ev[-1]["text"] == "fix the failing test in billing."


def test_a_pause_after_the_wake_word_gets_one_acknowledgement_not_two():
    # "Kira, ... build the login page": the pause splits it into two utterances.
    local, cloud = Script("Kira,", "build the login page"), Script("build the login page.")
    e, sp, ev, clock = make(local, cloud)
    e.handle(utt(0.5))
    clock.t = 0.5
    e.handle(utt())
    time.sleep(0.9)
    assert sp.said == ["On it."]
    assert types(ev) == ["wake", "utterance"] and ev[-1]["text"] == "build the login page."


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


# ---- conversation --------------------------------------------------------------------


def test_questions_get_mm_hm_and_tasks_get_on_it():
    local = Script("Kira, are you listening to me?", "Kira, can you add a dark mode toggle")
    e, sp, ev, _ = make(local)
    e.handle(utt())
    e.handle(utt())
    assert sp.said == ["Mm-hm.", "On it."]
    assert [x["text"] for x in ev if x["type"] == "utterance"] == ["are you listening to me?", "can you add a dark mode toggle"]


def test_a_reply_that_expects_an_answer_opens_a_follow_up_without_the_wake_word():
    local = Script("what can you do", "and what about tests")
    e, sp, ev, clock = make(local)
    e.command({"type": "say", "id": "s1", "text": "I build and fix code. What should we work on?", "listen": True})
    clock.t = 3.0
    e.handle(utt())
    assert [x["text"] for x in ev if x["type"] == "utterance"] == ["what can you do"]
    clock.t = 30.0  # the follow-up window has closed
    e.handle(utt())
    assert len([x for x in ev if x["type"] == "utterance"]) == 1


def test_a_plain_announcement_does_not_open_a_follow_up():
    e, sp, ev, clock = make(Script("so anyway about lunch"))
    e.command({"type": "say", "id": "s1", "text": "Heads up: I lowered my autonomy."})
    clock.t = 2.0
    e.handle(utt())
    assert ev == []


def test_a_waiting_approval_takes_a_plain_yes_with_no_ack():
    e, sp, ev, _ = make(Script("yes go ahead"))
    e.command({"type": "state", "running": True, "awaiting": True})
    e.handle(utt())
    assert [x["text"] for x in ev if x["type"] == "utterance"] == ["yes go ahead"]
    assert sp.said == []


def test_kira_hearing_its_own_reply_in_the_follow_up_is_ignored():
    local = Script("I build and fix code what should we work on", "what can you do")
    e, sp, ev, clock = make(local)
    e.command({"type": "say", "id": "s1", "text": "I build and fix code. What should we work on?", "listen": True})
    clock.t = 3.0
    e.handle(utt())  # its own words, heard late through the room
    assert ev == [] and e.stats.ignored == 1
    sp.audible_until = 5.0  # speech that began while Kira was still audible
    e.handle(Utterance(audio=np.zeros(16000, dtype=np.float32), end_of_speech=5.5))
    assert ev == [] and e.stats.ignored == 2


def test_always_listen_needs_no_wake_word():
    events: list[dict] = []
    e = Engine(segmenter=SimpleNamespace(in_speech=False), local=Script("build a todo app"), cloud=None, speaker=FakeSpeaker(), emit=events.append, clock=Clock(), require_wake=False)  # type: ignore[arg-type]
    e.handle(utt())
    assert [x["text"] for x in events if x["type"] == "utterance"] == ["build a todo app"]


def test_one_word_after_the_wake_word_is_a_command_not_a_bare_wake():
    e, sp, ev, _ = make(Script("Kira, status."))
    e.handle(utt())
    assert [x["text"] for x in ev if x["type"] == "utterance"] == ["status."]
    assert sp.said == ["Mm-hm."]


def test_a_short_answer_is_not_mistaken_for_an_echo_of_the_question():
    e, sp, ev, _ = make(Script("No."))
    e.command({"type": "state", "running": True, "awaiting": True})
    e.command({"type": "say", "id": "s1", "text": "I need your OK to install left-pad. Say yes or no.", "listen": True})
    e.handle(utt())
    assert [x["text"] for x in ev if x["type"] == "utterance"] == ["No."]


def test_a_short_yes_or_no_to_an_approval_skips_the_cloud_transcript():
    local, cloud = Script("No."), Script("know.")
    e, sp, ev, _ = make(local, cloud)
    e.command({"type": "state", "running": True, "awaiting": True})
    e.handle(utt())
    assert [(x["text"], x["source"]) for x in ev if x["type"] == "utterance"] == [("No.", "local")]
    assert cloud.calls == 0
