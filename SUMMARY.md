# Kira: where we left off (2026-09-24)

Spec: `docs/PROJECT-REPORT.md` (v2, authoritative; the root `PROJECT-REPORT.md` is an identical copy, and `PROJECT-REPORT.v1-claude-sdk.md` is history only).

## Status by phase

| Phase | State | Evidence |
|---|---|---|
| 0 Loop spike | **Done** | Live exit test on both providers (`npm run spike -- --preset vite-typo --yes --executor …`). NIM (Nemotron) recovered from `npm install dayjss` → 404 → used `dayjs` → verified. Mistral (Codestral) pre-corrected the typo itself, and recovered from a stuck interactive prompt instead. Abort mid-stream cancels in ~1 ms live (limit 200 ms). |
| 1 Control plane | **Done** | Chaos test (10 random interrupts, no orphans, clean tree); 429-storm test; state machine, budgets, audit log, autonomy levels 0–4 with downgrade triggers |
| 2 VS Code shell | **Done** | Daemon over a named pipe plus a token; Flight Deck webview; browser test plus a real VS Code run (`npm run test:vscode -w kira-agent`, `KIRA_VSCODE_DOWNLOAD=1`) |
| 3 Verification ladder | **Done** | Blank page fails at L4; planted stub fails at L5; a live GLM-5.3 critic caught Codestral swapping a requested package |
| 4 Memory | **Done** | 3-days-later recall test; recall probe 20/20 at hit@5 (offline and with real Mistral embeddings plus the NIM reranker) |
| 5 Voice | **In progress, mostly built** | Live tests passed: ack p50 ≈ 0.70 s (limit 2.0 s), "stop" ≈ 0.66 s, 0 self-triggers on 8 narration clips |
| 6 Polish | Not started | |

Rough completion: about 75/100.

## Exactly where I stopped (Phase 5)

1. **Bug found by the live test:** a pause after "Kira," split one command into two utterances, so Kira said "Yes?" mid-sentence (11 acks for 6 commands).
   **Fix written, not yet verified live:** `packages/voice/kira_voice/engine.py` now waits `YES_GRACE_S = 0.7` before "Yes?". The unit tests pass (15/15).
   **Next:** re-run the live test, which now asserts exactly one "On it." per command:
   ```
   cd packages/voice
   %LOCALAPPDATA%\kira\voice-venv\Scripts\python.exe -m pytest tests/test_live.py -s -q -p no:warnings
   ```
2. **Try it for real with the microphone.** This has not been run with a live mic yet:
   ```
   npm run kira -- --voice --workspace C:\path\to\some\project
   ```
   Say "Kira, build …", "Kira, status", "stop", or "Kira, where did we leave off?".
3. **Still to do for Phase 5:**
   - add voice to the VS Code extension (a "Kira: Start Voice" command that calls the `voice/start` RPC; the daemon side already exists)
   - run the 30-minute speaker-playback self-trigger check (the current test uses 8 clips)
   - train an openWakeWord "Hey Kira" model (the current wake word is local Whisper spotting "Kira")
   - consider Voxtral *realtime* streaming STT (currently batch transcription of the finished utterance)

## Setup facts

- Keys are in `.env` (gitignored). **Rotate all three keys:** they were pasted into chat.
- The Mistral key only covers **Codestral** (`mistral-medium`/`small` report a limit of 0/min). Embeddings and Voxtral STT/TTS work. When the plan is upgraded, put `mistral-medium-latest` first in `kira.models.json`.
- NIM models that work: `z-ai/glm-5.3`, `nvidia/nemotron-3-super-120b-a12b`, reranker `nvidia/llama-nemotron-rerank-vl-1b-v2`. The old qwen3-coder, kimi-k2, llama-3.1-8b and old reranker are end of life. `kimi-k3` and `gpt-oss-20b` time out.
- Voice Python environment: `%LOCALAPPDATA%\kira\voice-venv`, kept outside OneDrive on purpose. Kira's voice is `gb_jane_confident`.
- Check models any time: `npm run check-models`.

## Useful commands

```
npm run typecheck && npm test          # all packages (daemon ~2 min)
npm run spike -- "goal" --workspace DIR # headless run
npm run kira -- --voice --workspace DIR # voice, no VS Code
npm run recall-probe                    # memory quality
```

## Bugs found and fixed via live runs (context for the code)

- a mid-stream socket drop crashed the run
- an aborted stream reported "done"
- NIM's in-stream "overloaded" error crashed the run
- agent commands could read API keys from the environment
- interactive prompts hung for 300 s (now killed after 8 s)
- a missing working directory gave an unreadable error
- the lockfile filled the critic's diff budget
- the private-index lock raced between checkpoint managers
- `axois` turned out to be a real npm package, so it was replaced with `dayjss` in the Phase 0 preset
