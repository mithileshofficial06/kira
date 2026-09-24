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
| 5 Voice | **In progress, mostly built** | Live tests passed: one ack per command, ack p50 ≈ 0.56 s (limit 2.0 s), "stop" ≈ 0.55 s, 0 self-triggers on 8 narration clips; conversation mode; Start/Stop Voice in VS Code; voice-e2e 6/7 (the 7th blocked by a provider timeout, since fixed) |
| 6 Polish | Not started | |

Rough completion: about 75/100.

## Exactly where I stopped (Phase 5)

Voice is now a conversation, not one-shot commands (from the first real-mic try, 2026-09-24):
- **Questions get answers, not runs.** Only sentences that start like work ("build…", "can you fix…", "let's add…") start a run. Anything else goes to the utility model (`daemon/src/voice/converse.ts`), which answers out loud or, for work asked in other words ("I need a login page"), replies `TASK: …` and starts it.
- **No wake word needed to answer.** After a reply that expects an answer (chat replies, status, left-off, approvals, the final report), the next sentence needs no "Kira" for 10 s. While an approval waits, a plain "yes"/"no" works. Echo guards: speech that began while Kira was audible, or that repeats Kira's last sentence (3+ words), is ignored.
- **Acks:** "On it." for work, "Mm-hm." for questions, none for a yes/no to an approval.
- **Mid-sentence pauses:** the engine waits 1.2 s after a sentence for more of it, so "create hello.txt … that says hello world" arrives whole (the ack still plays at once).
- **One-word commands:** "Kira, status" is a command, not a bare wake.
- **Short answers:** the local transcript is trusted for a lone yes/no during an approval (Voxtral wrote "No." as "know."); sound-alikes are accepted only while an approval waits; anything unclear then gets "Sorry, was that a yes or a no?".
- **Always-listen mode:** `npm run kira -- --voice --always-listen --workspace DIR` (no wake word at all).
- **Agent loop:** a model that only rewrites its plan is nudged after 3 turns and stopped as "stalled" after 6. A "Request timed out." from a provider now waits/falls back instead of failing the run.
- VS Code: **Kira: Start Voice** / **Kira: Stop Voice**, with a mic item in the status bar.

Tests:
- `packages/voice`: 31 tests (unit plus live speech: conversation follow-up, echo rejected, spoken yes, paused sentence joined).
- `npm run voice-e2e`: the whole loop with no mic. Real sidecar, daemon, models and runs in a scratch repo, with a second Voxtral voice injected as "the human" (`--source inject`). Session 3 passed 6/7 (question, follow-up, spoken task verified, follow-up after the result, status + left off, spoken stop). The approval check failed only because of the provider timeout fixed above.

Next:
1. **Try it with the microphone** (needs you): `npm run kira -- --voice --workspace C:\Users\anish\kira-playground`
2. Remaining Phase 5 items:
   - the 30-minute speaker-playback self-trigger check (the current test uses 8 clips)
   - train an openWakeWord "Hey Kira" model (the current wake word is local Whisper spotting "Kira")
   - consider Voxtral *realtime* streaming STT (currently batch transcription of the finished utterance)
3. NVIDIA NIM was unreachable ("Connection error") on 2026-09-24 evening, so the critic fell back to the stub scan. Re-check with `npm run check-models`.

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
