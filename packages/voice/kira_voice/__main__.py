"""Kira voice sidecar.

    python -m kira_voice                     # microphone, speaks through the default output
    python -m kira_voice --source a.wav,b.wav --fast
    python -m kira_voice --list-devices

The Mistral key comes from the KIRA_MISTRAL_API_KEY (or MISTRAL_API_KEY) environment variable.
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
import threading

from . import protocol


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kira_voice")
    ap.add_argument("--source", default="mic", help='"mic" or comma-separated WAV files')
    ap.add_argument("--fast", action="store_true", help="feed files faster than real time")
    ap.add_argument("--input-device", type=int, default=None)
    ap.add_argument("--output-device", type=int, default=None)
    ap.add_argument("--voice", default=os.environ.get("KIRA_VOICE", "gb_jane_confident"))
    ap.add_argument("--whisper", default="tiny.en", help="local model for wake and stop spotting")
    ap.add_argument("--no-cloud-stt", action="store_true", help="use only the local transcript")
    ap.add_argument("--list-devices", action="store_true")
    args = ap.parse_args(argv)

    import sounddevice as sd

    if args.list_devices:
        print(sd.query_devices())
        return 0

    key = os.environ.get("KIRA_MISTRAL_API_KEY") or os.environ.get("MISTRAL_API_KEY")
    if not key:
        protocol.log("no Mistral API key: set KIRA_MISTRAL_API_KEY", "error")
        return 2

    from .engine import Engine
    from .sources import FileSource, MicSource
    from .speaker import VoiceSpeaker
    from .stt import LocalWhisper, VoxtralTranscriber
    from .tts import PhraseCache, Player, VoxtralTTS
    from .vad import Segmenter, SileroVAD

    tts = VoxtralTTS(key, voice=args.voice)
    cache = PhraseCache(tts)
    cache.warm()
    player = Player(tts.sample_rate, device=args.output_device)
    speaker = VoiceSpeaker(tts, cache, player)
    local = LocalWhisper(args.whisper)
    cloud = None if args.no_cloud_stt else VoxtralTranscriber(key)
    engine = Engine(Segmenter(SileroVAD()), local, cloud, speaker)

    source = MicSource(args.input_device) if args.source == "mic" else FileSource(args.source.split(","), realtime=not args.fast)
    out_name = sd.query_devices(args.output_device, "output")["name"]
    stop = threading.Event()

    def on_command(cmd: dict) -> None:
        if cmd.get("type") == "shutdown":
            stop.set()
            source.close()
        else:
            engine.command(cmd)

    protocol.read_commands(on_command)
    signal.signal(signal.SIGINT, lambda *_: (stop.set(), source.close()))
    protocol.emit({"type": "ready", "input": source.name, "output": str(out_name), "wake": f"transcript ({args.whisper})", "voice": args.voice})

    try:
        for frame in source.frames():
            if stop.is_set():
                break
            engine.feed(frame)
    finally:
        engine.close()
        # Let the last reply finish before closing the device.
        while player.playing and not stop.is_set():
            stop.wait(0.05)
        player.close()
        protocol.emit({"type": "log", "level": "info", "msg": f"stats {engine.stats}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
