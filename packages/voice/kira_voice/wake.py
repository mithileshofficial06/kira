"""Wake word and fast-path intents, matched on the local transcript.

openWakeWord has no pretrained "Kira" model, so the first wake detector is
transcript-based: a local Whisper transcribes each short utterance on this
machine, and only an utterance that starts with "Kira" goes any further.
Nothing is sent to a cloud service until the wake word has been heard.
A trained openWakeWord model can replace this later (see engine.WakeDetector).
"""
from __future__ import annotations

import re

# How Whisper tends to spell "Kira" (and "Hey Kira") in short, noisy clips.
_NAMES = r"kira|keira|kiera|kyra|kiara|kirra|kera|keera|kearra|kiran?|chiara|ciara|cara|kara|keyra|kirah"
WAKE = re.compile(rf"^\W*(?:(?:hey|hi|ok|okay|yo)\W+)?(?:{_NAMES})\b[\s,.!?:;\-]*", re.IGNORECASE)

STOP = re.compile(
    r"^\W*(?:please\W+)?(stop|cancel|abort|halt|hold on|wait|pause|enough|shut up|kill it|freeze)\b",
    re.IGNORECASE,
)

# Work Kira should start on ("On it."); anything else is conversation ("Mm-hm.") and the daemon decides.
# The daemon's intents.ts has the same list: keep them in step.
TASK = re.compile(
    r"^\W*(?:(?:please|now|and|then|so|okay|ok|also)\W+)*"
    r"(?:(?:can|could|would|will) you\W+(?:please\W+)?|i (?:want|need) you to\W+|let'?s\W+|go ahead and\W+)?"
    r"(?:build|create|make|add|fix|write|implement|refactor|update|change|remove|delete|rename|move|install|set ?up|"
    r"run|test|deploy|generate|scaffold|convert|migrate|upgrade|improve|optimi[sz]e|clean ?up|debug|replace|edit|modify|"
    r"style|design|init(?:ialize)?|start|put|hook up|wire|connect|integrate|document|translate|bump|configure|port|split|"
    r"merge|extract|commit|revert|undo|finish|continue|redo|polish|speed up|restructure|rewrite)\b",
    re.IGNORECASE,
)

YES_NO = re.compile(r"^\W*(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|do it|no|nope|nah|don'?t|deny|allow( it)?)\b", re.IGNORECASE)

# Kira must never say its own name: its voice would wake it.
_SELF_NAME = re.compile(rf"\b(?:{_NAMES})\b", re.IGNORECASE)


def split_wake(text: str) -> tuple[bool, str]:
    """(woke, rest). "Kira, build a login page" -> (True, "build a login page")."""
    m = WAKE.match(text or "")
    if not m:
        return False, (text or "").strip()
    return True, text[m.end():].strip()


def is_stop(text: str) -> bool:
    return bool(STOP.match(text or ""))


def looks_like_task(text: str) -> bool:
    return bool(TASK.match(text or ""))


def is_yes_no(text: str) -> bool:
    return bool(YES_NO.match(text or ""))


def similar(a: str, b: str) -> float:
    """Share of a's words that also appear in b: catches Kira hearing its own last sentence."""
    wa = re.findall(r"[a-z0-9']+", (a or "").lower())
    wb = set(re.findall(r"[a-z0-9']+", (b or "").lower()))
    return sum(w in wb for w in wa) / len(wa) if wa else 0.0


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", text or ""))


def speakable(text: str) -> str:
    """Text safe to speak: Kira's own name is replaced so playback cannot trigger the wake word."""
    return _SELF_NAME.sub("I", text or "").strip()
