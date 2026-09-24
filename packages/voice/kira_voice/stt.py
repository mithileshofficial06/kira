"""Speech to text: local Whisper for wake/stop spotting, Voxtral for commands.

Both get the utterance after audio.normalize(), and Voxtral gets a context bias:
Kira's name plus the project's own words (file names, packages), so "Kira",
"Next.js" or "useEffect" come back spelled right.
"""
from __future__ import annotations

import io
import json
import re
import time
import urllib.error
import urllib.request
import uuid
import wave

import numpy as np

from .vad import SAMPLE_RATE

MISTRAL_API = "https://api.mistral.ai/v1"


class LocalWhisper:
    """faster-whisper on the CPU. Private (audio never leaves the machine) and fast on short clips."""

    def __init__(self, model: str = "base.en", threads: int = 4) -> None:
        from faster_whisper import WhisperModel

        self.name = model
        self.model = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=threads)

    def transcribe(self, audio: np.ndarray, max_tokens: int = 120) -> str:
        segments, _ = self.model.transcribe(
            audio.astype(np.float32),
            language="en",
            beam_size=1,
            best_of=1,
            temperature=0.0,
            without_timestamps=True,
            condition_on_previous_text=False,
            vad_filter=False,
            # Noisy clips can send Whisper into a loop ("t t t t ..."); cap it so latency stays bounded.
            max_new_tokens=max_tokens,
            # Biases short clips toward spelling the wake word the way the matcher expects.
            initial_prompt="Kira, stop. Kira, build it.",
        )
        return " ".join(s.text.strip() for s in segments).strip()


def to_wav(audio: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


#: Always biased toward: the wake word, and words people say to a coding agent that STT tends to mangle.
BASE_BIAS = (
    "Kira", "npm", "npx", "Node.js", "TypeScript", "JavaScript", "React", "Next.js", "Vite", "Tailwind", "JWT", "OAuth",
    "API", "JSON", "README", "localhost", "useEffect", "useState", "Python", "pytest", "Git", "GitHub", "VSCode", "CSS",
    "HTML", "SQL", "Postgres", "SQLite", "Express", "Supabase", "Vercel", "Docker", "env", "login", "signup", "navbar",
)
MAX_BIAS = 100
_BAD_TERM = re.compile(r"[\s,]")


class TranscriptionError(Exception):
    pass


class VoxtralTranscriber:
    """Mistral's Voxtral transcription for the command itself: much more accurate than tiny Whisper."""

    def __init__(self, api_key: str, model: str = "voxtral-mini-latest", timeout_s: float = 20.0) -> None:
        self.api_key, self.model, self.timeout_s = api_key, model, timeout_s
        self.bias: list[str] = list(BASE_BIAS)

    def set_vocabulary(self, words: list[str]) -> None:
        """Project words to spell right. Voxtral takes up to 100 terms, each without spaces or commas."""
        seen, out = set(), []
        for w in [*BASE_BIAS, *words]:
            w = str(w).strip()
            if w and not _BAD_TERM.search(w) and len(w) <= 40 and w.lower() not in seen:
                seen.add(w.lower())
                out.append(w)
        self.bias = out[:MAX_BIAS]

    def transcribe(self, audio: np.ndarray, retries: int = 2) -> str:
        fields = [("model", self.model), ("language", "en"), *(("context_bias", w) for w in self.bias)]
        body, ctype = _multipart(fields, ("file", "speech.wav", "audio/wav", to_wav(audio)))
        last: Exception | None = None
        for attempt in range(retries + 1):
            req = urllib.request.Request(
                f"{MISTRAL_API}/audio/transcriptions",
                data=body,
                method="POST",
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": ctype},
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
                    return str(json.loads(r.read().decode("utf-8")).get("text", "")).strip()
            except urllib.error.HTTPError as e:
                last = TranscriptionError(f"HTTP {e.code}: {e.read()[:200]!r}")
                if e.code not in (429, 500, 502, 503, 504):
                    break
            except (urllib.error.URLError, TimeoutError) as e:
                last = TranscriptionError(str(e))
            time.sleep(0.4 * (attempt + 1))
        raise last or TranscriptionError("transcription failed")


def _multipart(fields: list[tuple[str, str]], file: tuple[str, str, str, bytes]) -> tuple[bytes, str]:
    """Fields may repeat (context_bias is one field per term)."""
    boundary = uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields:
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    name, filename, ctype, data = file
    out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: {ctype}\r\n\r\n'.encode())
    out.write(data)
    out.write(f"\r\n--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"
