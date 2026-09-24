# Kira — Project Report (v2: Mistral + NVIDIA NIM)

**Name:** Kira (wake word: "Kira", or "Hey Kira" if false triggers are a problem)
**One-line pitch:** A voice-driven autonomous engineering agent that lives inside VS Code, works unattended for long stretches, remembers your project across sessions, and can be interrupted, rewound, and redirected mid-task.
**Author:** Anish
**Date:** 2026-09-24
**Status:** Pre-implementation design
**Model providers:** Mistral AI (primary) · NVIDIA NIM hosted API (secondary / specialist)
**Supersedes:** v1 (Claude Agent SDK), kept as `PROJECT-REPORT.v1-claude-sdk.md`
**Document purpose:** Build specification. Opinionated on purpose. Where a choice is genuinely open, it is listed in §18, not hedged inline.

---

## 0. What changed from v1

| Area | v1 | v2 |
|---|---|---|
| Agent loop | Claude Agent SDK (library) | **Custom loop, owned by Kira** (§6) |
| Models | Opus / Sonnet | Mistral Medium 3.5 · Devstral 2 · Mistral Small 4, plus NIM Qwen3-Coder / Kimi K2 as a cross-family critic |
| STT / TTS | Deepgram / ElevenLabs | **Voxtral Realtime / Voxtral TTS** (Mistral), NIM Parakeet / Magpie as fallback |
| Embeddings | unspecified | **Codestral Embed** (code) + **Mistral Embed** (text), NIM reranker |
| Prompt-injection defence | not addressed | **Mistral Moderation 2** screen on untrusted content (§13) |
| Novelty claims | "nobody does this" | Corrected. Credits existing checkpoint/rewind features and pitches the *combination* (§1) |
| Rewind scope | "total" | **File state only**. Out-of-repo side effects are gated (§4.1) |
| Autonomy downgrade | included self-reported confidence | **Objective triggers only** (§4.5) |
| Timeline | 3–5 weekends to slice | **5–7 weekends to slice**, 4–6 months to full vision |

Owning the loop costs one or two extra weekends. In exchange, cancellation, turn-boundary truncation, the autonomy gate and the PTY all sit inside Kira rather than being negotiated with someone else's runtime. That was the biggest unregistered risk in v1, and it is gone.

---

## 1. Executive summary

Code generation is a commodity. Claude Code, Cursor, Copilot, Windsurf and Devin all write competent code. Several already have pieces of what this project wants: Claude Code and Cursor have checkpoints and rewind, interrupt keys, permission modes and project memory files.

**What none of them combine** is the following, and that combination is the project:

| Already solved (integrate) | Kira's target (build) |
|---|---|
| LLM writes code, calls tools | **Unattended supervision**: a 20-minute run you do not watch, with a clean report at the end |
| File-level checkpoints | **Decision journal**: *why* Postgres beat SQLite three weeks ago, retrieved automatically |
| Interrupt with a key | **Voice barge-in** mid-install, with a clean process-tree kill and no debris |
| "Tests pass" | **Verification ladder**: knows the difference between *done* and *not erroring* (L4 semantic checks) |
| Static rules | **Procedural memory**: stops making the same machine-specific mistake twice |

The deliverable is a VS Code extension plus a local agent daemon. The model layer is **Mistral** (primary, pay-as-you-go, fine for continued use) and **NVIDIA NIM's hosted catalog** (free for development, used for specialist roles and a cross-family critic). Both expose OpenAI-compatible chat APIs with tool calling. The agent loop is custom.

**Timeline:** a working vertical slice (Phases 0–3) in **5–7 weekends**. The full vision including memory and voice in **4–6 months part-time**.

> **Naming note:** "Kira" is a common personal name, so there is no single IP owner (unlike "JARVIS", which is Marvel/Disney). Two things to know: Kira Systems is an existing legal-AI product (now part of Litera), so check that the npm, GitHub and VS Code Marketplace names are free, or use a qualified name such as `kira-agent`. And as a wake word, a two-syllable personal name can trigger on conversations or media. Train openWakeWord on "Hey Kira" if bare "Kira" false-triggers. The wake word stays configurable.

---

## 2. The core insight

Current AI coding tools are **stateless transaction machines**. Every session begins at amnesia. Three properties follow from fixing that.

### 2.1 Continuity
A durable model of the project: not just an embedding index (that is search), but a **decision journal** of what was chosen, what was rejected, what constraint forced it, and what failed when tried. Code tells you *what*. Git tells you *when*. Nothing tells you *why*.

### 2.2 Supervisability
Long runs are only useful if you can leave them alone. The agent must be:
- **Narratable**: says what it is about to do, in one sentence, before doing it
- **Interruptible**: stops at any depth, cleanly
- **Reversible**: every step is a checkpoint

### 2.3 Calibrated autonomy
A dial, not a switch, with automatic downgrade on **objective** evidence of trouble.

**Voice is the interface these properties enable, not the product.** It only becomes worth having once the agent can run unattended.

### 2.4 Why a non-frontier model stack is a feature here
Open and mid-tier models are strong at single steps and weaker over 20+ step runs: malformed tool calls, premature "done", loops. That makes Kira's control plane *more* valuable, not less. The verification ladder, loop detection and gates are what turn a less reliable model into a trustworthy system. For a portfolio, that is the stronger story: **the reliability comes from the engineering, not from the model.**

---

## 3. Product vision: a day in the life

```
09:14  You:    "Kira, where did we leave off?"
       Kira:   "Expense tracker. Auth is done and tested. Receipt upload is
                half built: the S3 presign endpoint works, the client
                uploader doesn't. One failing test in billing.spec.ts that
                I left because it needs a decision from you."

09:15  You:    "What's the decision?"
       Kira:   "Whether a refund reopens the billing period. No precedent,
                and it changes the schema."
       You:    "Refunds don't reopen. Keep the period closed."
       Kira:   "Recorded. That contradicts the comment in ledger.ts line 40.
                Fix it?"
       You:    "Yes. Then finish the uploader. Go."

09:16  [Autonomy level 3. You leave.]
       Plan -> 7 steps -> checkpoint -> execute -> verify -> repeat.
       Step 4: Playwright assertion fails. Diagnoses, patches, re-runs.
       Step 6: wants a new dependency. Crosses a gate. Queues the question,
               continues with step 7.

09:41  Kira:   "Uploader done. Tests pass, build clean, verified a real file
                upload in the browser. One question queued: add
                react-dropzone, 12kb, well maintained. Yes or no?"
       You:    "No, write it by hand."

09:46  You:    "Kira, stop. Show me the drop zone first."
       [Abort propagates, process tree killed, repo at checkpoint 7,
        dev server still up, screenshot in the panel]
```

---

## 4. The five mechanisms

### 4.1 Checkpoint & rewind (git-backed, file state)

Before every step, the working tree is committed to a **shadow ref** (`refs/kira/checkpoints/<run-id>/<step>`), invisible to your branch and history.

**Implementation:** use a **separate index file** (`GIT_INDEX_FILE=.git/kira-index`) so the user's staging area is never touched: `git add -A` into the private index, `git write-tree`, `git commit-tree`, `git update-ref`. Untracked, non-ignored files are included. Ignored files are not.

```
main ────●────────────────────────────────●   (your real commits)
          \                              /
           ● c1 ● c2 ● c3 ● c4          /    refs/kira/checkpoints/run-8f2
                       ↑ rewind here ──┘      (squashed to one commit on accept)
```

**What rewind does *not* undo:** installed packages in `node_modules`, database migrations, running processes, global config, anything outside the repo. For that reason:
- **Out-of-repo side effects are a hard gate** (§4.5).
- Dependency installs record the lockfile diff, so rewind can re-run `npm ci` against the restored lockfile.
- The run report lists every side effect that rewind cannot reverse.

### 4.2 Barge-in interruption

The mic stays hot during execution. Wake word or "stop" triggers a cancellation cascade:

1. `AbortController.abort()` on the in-flight model stream (a real HTTP abort to Mistral / NIM)
2. `SIGINT`-equivalent to the PTY; hard kill of the whole **Job Object** after a 2s grace period
3. Tool queue drained; partial writes restored from the last checkpoint
4. Message history truncated to the last **turn boundary** (Kira owns the array, so this is trivial)
5. State → `INTERRUPTED`, with a one-sentence summary

**Must be designed on day one.** Every tool signature takes an `AbortSignal` from the first line of code.

### 4.3 The verification ladder

| Tier | Gate | Cost | Catches |
|---|---|---|---|
| L0 | Parse + typecheck (`tsc --noEmit`) | ~1s | Syntax, type errors |
| L1 | Build | ~30s | Import errors, config breakage |
| L2 | Unit / integration tests | ~10s | Logic regressions |
| L3 | Process health: boots, port listens, `/` returns 200 | ~15s | Crashes, boot failures |
| L4 | Semantic: Playwright asserts real DOM content | ~30s | **Blank page that returns 200** |
| L5 | Cross-family critique: a *different model family* reviews the full diff cold | 1 call | Scope creep, dead code, stubs, fake "done" |

**L4 is the one everyone skips and the one that matters.**

**L5 uses a different model family on purpose.** A Mistral executor's diff is reviewed by a NIM-hosted model (Qwen3-Coder or Kimi K2), and vice versa. A model reviewing its own output shares its own blind spots. Cross-family review is cheap and noticeably less self-lenient.

Every gate has a **hard iteration cap** (default 3). Normalized error output is hashed. Three identical hashes means *stop and escalate*.

### 4.4 The decision journal

Append-only ADR store, retrieved at session start and on any task touching affected files.

```yaml
id: ADR-014
date: 2026-09-23
title: Refunds do not reopen a billing period
status: accepted
decided_by: user (voice, 09:15)
context: >
  Refund handling in the ledger was ambiguous. No precedent in codebase.
alternatives_rejected:
  - Reopen period and recompute. Rejected: breaks exported statements.
consequences:
  - ledger.ts:40 comment corrected in c3
supersedes: null
```

**Noise control:** an ADR is written only when (a) a human made a decision, (b) an alternative was actually tried and rejected, or (c) a gate forced a design change. Everything else goes to episodic memory. Extraction runs on **Mistral Small 4** (cheap) and is shown in the Flight Deck for one-click reject during the first weeks.

### 4.5 Gated autonomy

| Level | Behavior |
|---|---|
| **0 — Observe** | Reads and answers. No writes. |
| **1 — Propose** | Writes a plan and a diff. Nothing applied without approval. |
| **2 — Step** | Executes one step, reports, waits. |
| **3 — Run** | Executes the full plan. Pauses only at gates. |
| **4 — Trust** | Executes and self-corrects. Scratch directories only. |

**Hard gates (pause at every level):** installing a dependency · deleting files outside declared scope · any network write (`git push`, deploy, non-localhost POST) · schema migration · touching `.env` or credentials · `rm -rf` · any force operation · **any side effect outside the repo**.

**Automatic downgrade triggers (objective only):**
- two consecutive verification failures
- a write outside the plan's declared file scope
- a repeated error hash
- step budget or cost budget more than 70% used with the plan less than 50% complete
- more than 2 malformed tool calls in one step (a strong signal that the model is confused)

Self-reported model confidence is **logged but never used as a trigger**. It is poorly calibrated, especially on smaller models.

---

## 5. Model stack

All model IDs live in **`kira.models.json`**, never in code. Both catalogs change monthly. Verify every ID against the live catalog before Phase 0 ([docs.mistral.ai/models](https://docs.mistral.ai/models), [build.nvidia.com/models](https://build.nvidia.com/models)).

### 5.1 Role assignment

| Role | Primary (Mistral) | Alternate (NVIDIA NIM) | Why |
|---|---|---|---|
| **Planner** | Mistral Medium 3.5 (`mistral-medium-3504`) | Kimi K2 / DeepSeek (latest in catalog) | Built for long-horizon agentic work and synchronous tool calling |
| **Executor** (bulk tool calls) | Devstral 2 | Qwen3-Coder 480B (`qwen/qwen3-coder-480b-a35b-instruct`) | Coding-agent specialists |
| **Critic** (L5) | *Must be the other family from the executor* | Qwen3-Coder / Kimi K2 | Cross-family review (§4.3) |
| **Utility** (summaries, ADR extraction, intent parsing, log compression) | Mistral Small 4 (`mistral-small-2603`) | Nemotron Nano / Ministral-class | Cheap, fast, runs constantly |
| **Code embeddings** | Codestral Embed (`codestral-embed-2505`) | NV-EmbedCode 7B | Code-aware retrieval |
| **Text embeddings** (ADRs, episodes) | Mistral Embed (`mistral-embed-2312`) | NV-Embed / NeMo Retriever embed | Prose retrieval |
| **Reranker** | — | NeMo Retriever reranker (`nvidia/*-rerankqa-*`) | Cuts memory noise (R6) |
| **Streaming STT** | Voxtral Mini Transcribe Realtime (`voxtral-mini-realtime-2602`) | Parakeet ASR (Riva, gRPC) | Streaming partials are required |
| **TTS** | Voxtral TTS (`voxtral-tts-2603`) | Magpie TTS (Riva) | Sentence-chunked playback |
| **Safety / injection screen** | Mistral Moderation 2 (`mistral-moderation-2603`) | NemoGuard content-safety / jailbreak detect | Screens untrusted tool output (§13) |

Local, no API: **openWakeWord** (wake word) · **Silero VAD** (endpointing) · **faster-whisper** (offline STT fallback).

### 5.2 Provider policy

- **Mistral is the primary provider for anything on the critical path.** It is paid, has published pricing and is not restricted to evaluation use.
- **NIM's hosted free tier is for development, evaluation and non-critical roles.** Rate limits are per model and per account (commonly reported around 40 RPM). The terms restrict free use to development, testing, research and evaluation. A personal tool fits that, but **do not put a NIM free endpoint on the critical path of a 20-minute run.** If NIM is throttled, the critic falls back to Mistral Large 3 and the run continues.
- **Fallback chain per role** is defined in config: `primary → alternate → degraded` (for example, the critic becomes the same family at a lower temperature, with a warning in the report).
- **Data leaves the machine** to both providers. `.env*` and credentials are deny-listed at the tool layer, so they never enter any prompt.

### 5.3 Provider quirks the adapter must absorb

- Tool-call argument JSON can be malformed or truncated. Validate with `zod`, return the validation error to the model as the tool result, and count it toward the malformed-call downgrade trigger.
- Tool-call ID formats and `tool_choice` semantics differ slightly between providers. Normalize in the adapter.
- Some models emit tool calls as text inside `content` instead of `tool_calls`. Add a parser fallback, off by default and on per model.
- NIM ASR/TTS (Riva) uses **gRPC**, not the OpenAI HTTP shape. It gets its own adapter.
- **Do not assume prompt caching.** Design for context compaction (§6.4) instead.

---

## 6. The agent runtime (custom loop)

This replaces "embed the Claude Agent SDK". It is roughly 400–700 lines and is the heart of Phase 0.

### 6.1 Interfaces

```ts
interface ModelProvider {
  id: "mistral" | "nim";
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatDelta>; // streaming
  embed(texts: string[], model: string, signal: AbortSignal): Promise<number[][]>;
}

interface Tool<I, O> {
  name: string;
  schema: z.ZodType<I>;
  gate: GateClass;                 // none | scoped-write | hard
  run(input: I, ctx: ToolCtx, signal: AbortSignal): Promise<O>;
}
```

Both providers are implemented on the official **`openai`** npm client pointed at different `baseURL`s. `@mistralai/mistralai` is used only for Mistral-specific endpoints (Voxtral, moderation) if its OpenAI-compatible surface lacks them.

### 6.2 The loop

```
while (!done && !signal.aborted):
  checkpoint()                                  # §4.1, before every step
  stream = provider.chat(messages, tools, signal)
  for each tool_call in stream:
      input = schema.safeParse(args)            # malformed -> error result, count++
      gate.check(tool, input, plan, autonomy)   # single chokepoint (§8 inv. 3)
      result = tool.run(input, ctx, signal)
      messages.push(call, summarize(result))    # full output -> disk
  commitTurnBoundary(messages)                  # persisted before next side effect
  if step complete: verificationLadder()
```

### 6.3 Budgets

- **Step budget** per run (default 40)
- **Token and cost budget** per run, with automatic halt
- **Wall-clock budget** per step
- **Per-provider rate limiter** (token bucket). A 429 is treated as *pause and back off*, not failure, and shows in the Flight Deck.

### 6.4 Context management (critical without prompt caching)

- Full tool output (build logs, test output, `npm install`) goes to `.kira/runs/<id>/`. Only a Small-4 summary of ≤300 tokens enters context.
- Every N steps, older turns are compacted into a running "state of the run" note.
- Memory context has a hard token budget (default 3k) and is re-ranked, not dumped.
- Stable content (system prompt, preferences, tool definitions) goes first, so any provider-side caching that exists is used opportunistically.

---

## 7. System architecture

```
┌──────────────────────── VS CODE (Extension Host) ──────────────────────┐
│   Flight Deck Webview          Extension Backend                        │
│   ├── plan / step tree         ├── commands, workspace + editor APIs    │
│   ├── live diff view           ├── diff rendering                       │
│   ├── xterm.js mirror          └── IPC client (JSON-RPC, named pipe)    │
│   ├── approval prompts                        │                         │
│   ├── provider / rate-limit status            │                         │
│   └── browser screenshots                     │                         │
└───────────────────────────────────────────────┼─────────────────────────┘
┌─────────────────── KIRA DAEMON (Node process) ──────────────────────────┐
│  ┌──────────────────── CONTROL PLANE ──────────────────────┐            │
│  │ Session FSM · AbortController tree · Autonomy gate      │            │
│  │ Checkpoint mgr · Step/cost/rate budgets · Audit log     │            │
│  └───────────────────────────┬─────────────────────────────┘            │
│  ┌─────────────┐   ┌─────────▼──────────┐   ┌──────────────────┐        │
│  │ VOICE       │   │ AGENT RUNTIME      │   │ MEMORY           │        │
│  │ (Python     │◄─►│ custom loop        │◄─►│ SQLite + FTS5    │        │
│  │  sidecar,   │   │ planner · executor │   │ + sqlite-vec     │        │
│  │  WebSocket) │   │ critic · utility   │   │ + NIM reranker   │        │
│  └─────────────┘   └─────────┬──────────┘   └──────────────────┘        │
│                    ┌─────────▼──────────┐                               │
│                    │ PROVIDER LAYER     │  Mistral API  ·  NVIDIA NIM   │
│                    │ adapters, limiter, │  (HTTPS, OpenAI-compatible;   │
│                    │ fallback, moderation│   Riva gRPC for NIM speech)  │
│                    └─────────┬──────────┘                               │
│  ┌───────────────────────────▼───────────────────────────────┐          │
│  │ TOOL LAYER: fs (scoped) · pty (node-pty) · git · playwright│         │
│  └────────────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why a separate daemon:** the extension host is single-threaded, shared and killed on window reload. A 25-minute run cannot live there.

**Why a Python voice sidecar:** openWakeWord, Silero, faster-whisper and `sounddevice` are all Python-first and far better on Windows than the Node equivalents. The sidecar talks to the daemon over a localhost WebSocket with a session token.

---

## 8. Control plane: the session state machine

```
   ┌──────┐  goal   ┌──────────┐  approved   ┌───────────┐
   │ IDLE ├────────►│ PLANNING ├────────────►│ EXECUTING │◄──┐
   └──▲───┘         └────┬─────┘             └─────┬─────┘   │
      │                  │ needs approval          ▼         │ fail (≤ cap)
      │                  ▼                   ┌───────────┐   │
      │         AWAITING_APPROVAL            │ VERIFYING ├───┘
      │                                      └─────┬─────┘
      │                                            │ pass / cap hit
      │                                      ┌─────▼─────┐
      └──────────────────────────────────────┤ REPORTING │
                                             └───────────┘
   ┌─────────────┐   ┌──────────────┐
   │ INTERRUPTED │   │ RATE_LIMITED │  ◄── reachable from ANY state
   └──────┬──────┘   └──────┬───────┘
          └──► IDLE         └──► resumes previous state after backoff
```

**Invariants:**
1. Every state transition is persisted before side effects. A daemon crash is resumable.
2. `INTERRUPTED` is reachable from every state, including mid-tool-call.
3. No tool executes without passing the autonomy gate: **one chokepoint function**.
4. History is truncated only at turn boundaries.
5. Every step is preceded by a checkpoint. No exceptions.
6. **A provider failure never corrupts run state.** A 429, 5xx or timeout goes to `RATE_LIMITED` or the fallback chain, never to a half-applied step.

---

## 9. Component notes

### 9.1 Terminal
**`node-pty` owned by the daemon, mirrored into xterm.js. Not the VS Code Terminal API**, whose output reading depends on shell-integration heuristics that fail silently.

Windows specifics:
- ConPTY (Windows 10 1809+). Expect ANSI quirks.
- **Process trees do not die with the parent.** Use **Job Objects**, with `taskkill /T /F /PID` as a fallback. Test with npm → node → dev server in week one.
- Normalize paths internally to forward slashes. Retry `EBUSY` with backoff.

### 9.2 Voice pipeline

```
mic ─► [AEC] ─► wake word ─► VAD ─► Voxtral Realtime STT ─► intent (Small 4)
               (local)      (local)   (streaming partials)        │
                                                            control plane
speaker ◄── Voxtral TTS ◄── sentence splitter ◄──────────────────┘
```

**Latency budget. Target ≤2.0s p50 from end of speech to first audible word:**

```
VAD endpoint              300ms
STT final (realtime)      300ms
LLM time-to-first-sentence 800ms   ← dominant; no prompt caching assumed
TTS first chunk           300ms
─────────────────────────────────
total                   ~1,700ms
```

This is 0.3s looser than v1 because prompt caching is not assumed. Levers: keep voice-turn prompts short, use **Mistral Small 4 for conversational replies**, and hand real work to the planner asynchronously ("On it." first, work second).

**Echo and false triggers:**
- **Acoustic echo cancellation is required**: a headset in Phase 5, WebRTC AEC (`webrtc-audio-processing`) after that. Otherwise the agent hears its own TTS and barges in on itself.
- Barge-in during TTS playback needs the wake word, not just VAD.
- Optional push-to-talk hotkey as a fallback in noisy rooms.

**Voice input is lossy.** No transcript reaches a gated tool without a written echo in the Flight Deck and confirmation.

### 9.3 Memory
SQLite (`better-sqlite3`) + FTS5 + `sqlite-vec`. One DB per workspace at `.kira/memory.db`, gitignored.

| Store | Contents | Retrieval |
|---|---|---|
| **Episodic** | Task log: goal, plan, steps, outcomes, errors, cost | Recency + semantic |
| **Semantic** | ADRs, project facts, architecture map | Hybrid FTS + vector → **NIM rerank** → file-path triggers |
| **Procedural** | "`npm ci` fails behind the proxy here: use `--fetch-retries 5`" | Matched on tool-call signature *before* execution |
| **Preference** | Style, libraries, conventions | Always in the system prompt (small) |

Embeddings are stored with their **model ID and dimension**. Changing embedding models triggers a background re-embed instead of mixing vectors from different spaces.

If the reranker is unavailable (rate limit), retrieval degrades to hybrid FTS + vector with reciprocal-rank fusion. Slightly noisier, never blocking.

### 9.4 Browser
Playwright, headed during development, for L3/L4 and screenshots. Narrow surface: `goto` · `waitForSelector` · `assertText` · `screenshot` · `consoleErrors`. Page text passes through the injection screen (§13) before entering context.

### 9.5 File tools
Scoped to the workspace root. Deny-list: `.git/`, `node_modules/`, `.env*`, gitignored paths unless declared. Every write goes through the checkpoint manager. Writes outside declared scope trigger a downgrade.

---

## 10. Roadmap: phases with exit criteria

Each phase has a **hard exit criterion**. Do not start the next until the current one passes.

### Phase 0 — Loop spike · 2 weekends
- Provider adapters for Mistral and NIM (`openai` client, two base URLs), streaming, tool calls, abort.
- The minimal custom loop (§6.2) with one `run_command` tool through node-pty, plus zod validation.
- `kira.models.json` with verified model IDs.
- Goal: *"create a Vite app, install deps, start it, confirm it serves."*

**Exit:** (a) recovers from an injected failure (wrong package name) without human input, on **both** providers; (b) aborting mid-stream cancels the HTTP request within 200ms; (c) a malformed tool call is caught and corrected, not crashed on.

### Phase 1 — Control plane · 2 weekends ★ highest value
State machine, AbortController tree, Job Object process kill, checkpoint/rewind with a private index, autonomy gate, step/cost/rate budgets, audit log.

**Exit:** Ctrl+C at a random moment during a 10-step run leaves **zero orphan processes and a clean `git status`**, 10 times in a row. A simulated 429 storm pauses and resumes the run without corrupting state.

### Phase 2 — VS Code shell · 1 weekend
Extension, daemon, JSON-RPC over a named pipe. Flight Deck: plan tree, live diff, xterm mirror, approvals, provider/rate-limit status.

**Exit:** a full run is legible from the panel alone.

### Phase 3 — Verification ladder · 1–2 weekends
L0–L5, iteration caps, error-hash loop detection, Playwright, cross-family critic.

**Exit:** reports **failure** on an app that boots with a 200 and renders a blank page. The critic catches a planted stub function (`// TODO: implement`) that passed L0–L4.

### Phase 4 — Memory · 2 weekends
Schema, four stores, Codestral/Mistral embeddings, NIM rerank, gated ADR extraction, "where did we leave off".

**Exit:** a session started 3 days later correctly recalls an unstated constraint from the earlier session. ≥90% on a 20-question recall probe set.

### Phase 5 — Voice · 3–4 weekends
Python sidecar, wake word, VAD, Voxtral Realtime STT, Voxtral TTS, AEC/headset, barge-in.

**Exit:** p50 end-of-speech-to-first-word ≤2.0s, and "stop" mid-install works reliably over audio (the Phase 1 guarantee, now spoken). The agent does not trigger on its own voice over 30 minutes of speaker playback.

### Phase 6 — Polish
Completion notifications, cost dashboard, session resume across reloads, personality tuning.

### Deliberately deferred
Multi-provider *routing by task difficulty* (the fallback chain is not routing) · Docker · OS control beyond VS Code · multi-agent parallelism · self-hosted NIM containers (no local GPU assumed) · fine-tuning.

---

## 11. Success metrics

| Metric | Target | Why |
|---|---|---|
| Unattended run length | ≥10 min at launch, ≥15 min by Phase 6 | The core claim, adjusted for the model stack |
| Interrupt cleanliness | 100%: no orphans, clean tree | Non-negotiable |
| Verification honesty | ≥95% agreement between "done" and human review | Prevents confident wrongness |
| Malformed tool-call rate | Tracked per model; <5% of calls | Decides executor choice with data |
| Voice round-trip | ≤2.0s p50, ≤3.0s p95 | Below the "is it broken?" threshold |
| Session recall | ≥90% on the probe set | Proves memory works |
| Cost per completed feature | Tracked, capped per run | Prevents budget surprises |
| Provider fallback events | Tracked; no run fails *only* because of a 429 | Proves resilience |

**Model bake-off (Phase 0–3):** run the same 5 tasks on Devstral 2, Mistral Medium 3.5 and Qwen3-Coder as executor. Record success rate, malformed-call rate, steps and cost. Choose the default executor from the data, not from benchmarks.

---

## 12. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Cancellation retrofitted too late | **Critical** | `AbortSignal` in every tool and provider signature from line one |
| R2 | Orphaned processes on Windows | High | Job Objects from week one. Test nested spawns. |
| R3 | Agent loops, burns budget | High | Error-hash detection, iteration caps, cost ceiling with auto-halt |
| R4 | Verification passes on broken output | High | L4 semantic checks plus cross-family L5 critic |
| R5 | **Weaker long-horizon tool use** (malformed calls, premature "done") | High | zod validation + repair, malformed-call downgrade trigger, shorter steps, verification ladder, executor bake-off |
| R6 | **NIM free-tier throttling / terms** | Medium | NIM off the critical path. Per-provider limiter. `RATE_LIMITED` state. Mistral fallback. |
| R7 | **Model catalog churn** (IDs deprecated) | Medium | All IDs in config. Startup check pings each configured model and warns. |
| R8 | Memory retrieval returns noise | Medium | Hybrid retrieval, rerank, hard token budget, retrieval log |
| R9 | Context exhaustion, no prompt caching | Medium | Output to disk, summaries in context, periodic compaction |
| R10 | Voice latency / self-triggering | Medium | Latency budget as a metric, local wake word + VAD, AEC or headset |
| R11 | Mis-transcription triggers a destructive action | Medium | Written echo + confirm before any gated tool |
| R12 | **Prompt injection** via repo files, npm output, web pages | Medium | Moderation screen, untrusted-content tagging, gates enforced in code rather than by prompt (§13) |
| R13 | Scope creep | Medium | §10 deferred list is a contract |
| R14 | Existing tools ship this first | Low | You will still have built it and learned the hard parts |

---

## 13. Security & safety posture

- **Credentials never enter model context.** `.env*` is deny-listed at the tool layer, not by prompt instruction. This matters twice as much with two external providers.
- **Prompt injection:**
  - All tool output from untrusted sources (web pages, `npm` output, files not authored in this run) is wrapped as `<untrusted>` data in the prompt.
  - It is screened by Mistral Moderation 2 (jailbreak detection) before entering context. Flagged content is summarized, not passed verbatim, and the run is downgraded.
  - **The real defence is that gates are code, not prompts.** An injected "run `git push --force`" still hits the hard gate.
- Network writes are always gated.
- Append-only audit log of every tool call and every model request (provider, model, tokens, cost, checkpoint).
- The daemon and voice sidecar bind to localhost only, with a per-session token.
- API keys live in the OS credential store (Windows Credential Manager via `keytar` or a similar library). They are never stored in the repo or in settings JSON.

---

## 14. Cost model

Rough. Measure on your own workload.

- **Mistral:** pay-as-you-go, per-token pricing that varies by model. Utility calls (Small 4) are the high-volume, low-cost tier. Planner and critic calls are few but expensive. Executor calls dominate total spend.
- **NIM hosted:** free for development within rate limits. Treat it as $0 but unreliable capacity.
- **Without prompt caching, re-sent context dominates.** Compaction (§6.4) is the single biggest cost lever. Budget ≤25k tokens of context per executor turn.
- **Hard per-run cost ceiling with auto-halt.** Set a monthly spend limit in the Mistral console as well.
- Track cost per step in the audit log from Phase 0. The bake-off needs it.

---

## 15. Tooling

**Environment:** Node 20+ LTS · pnpm · TypeScript · Git for Windows · VS Code · Visual Studio Build Tools 2022 (C++ workload) · Python 3.11+

**Accounts / keys:** Mistral API key (La Plateforme) · NVIDIA API key (`nvapi-…`, build.nvidia.com, Developer Program). No other paid services required.

| Layer | Packages |
|---|---|
| Providers | `openai` (both base URLs) · `@mistralai/mistralai` (Voxtral, moderation) · `@grpc/grpc-js` (NIM Riva speech, only if used) |
| Agent / control | `zod` · `xstate` (or a hand-written FSM) · `pino` · `p-retry` · `bottleneck` (rate limiting) |
| Terminal / process | `node-pty` · `execa` · `tree-kill` · a Job Object helper · `chokidar` |
| Git | `git` CLI via `execa` (plumbing commands for checkpoints) |
| IPC | `vscode-jsonrpc` |
| Extension / UI | `yo` + `generator-code` · `@types/vscode` · `@vscode/vsce` · esbuild · React or Svelte + Vite · `@xterm/xterm` |
| Verification | `typescript` · Vitest · Playwright · `wait-on` |
| Memory | `better-sqlite3` (FTS5) · `sqlite-vec` · `yaml` |
| Voice sidecar (Python) | `openwakeword` · `silero-vad` (onnxruntime) · `sounddevice` · `faster-whisper` · `websockets` · `mistralai` |
| Secrets | `keytar` (or equivalent) |
| Testing | Vitest · `@vscode/test-electron` · Sysinternals Process Explorer · chaos-interrupt script |

**Phase 0 minimum:** Node, pnpm, TypeScript, Git, VS Build Tools, both API keys, `openai`, `zod`, `node-pty`, `execa`, `tree-kill`.

---

## 16. The thirty-minute test

> Give it a genuine feature request on a codebase it has seen before. Leave the room for thirty minutes. Come back.

**Passes if:** the feature works · tests pass · you can read what it did and why · nothing outside scope was touched · undecidable choices are queued as clear questions · the report states which provider and model did what, and whether any fallback happened.

**Fails if** you find yourself checking on it.

---

## 17. Immediate next actions

1. **Get both keys and verify model IDs.** Write `kira.models.json` and a 20-line script that sends one tool-calling request to each configured model and prints pass/fail.
2. **Prove the Windows process-tree kill** with nested spawns before anything else.
3. **Build the minimal loop with abort** (§6.2), with one tool, on both providers.
4. **Write the Phase 1 chaos-interrupt test first**, then build the control plane against it.
5. **Start the executor bake-off log** from the first successful run.

---

## 18. Explicitly rejected ideas

| Idea | Why rejected |
|---|---|
| Difficulty-based model routing | Premature. Fixed roles plus a fallback chain. Revisit only when a *measured* cost or quality problem demands it. |
| Self-hosting NIM containers | Needs a local NVIDIA GPU and Docker. The hosted API is enough for this project. |
| One provider only | Loses the cross-family critic and the fallback path. Two providers behind one interface cost little. |
| Using NIM free tier as the primary executor | Rate limits and evaluation-only terms make it unsuitable for 20-minute critical-path runs. |
| Docker orchestration early | A second full reliability problem. |
| Full OS control | Large surface, large risk, small marginal value. |
| Fine-tuning | Not the bottleneck. Orchestration is. |
| Multi-agent parallelism | Coordination overhead exceeds benefit at this scale. |
| VS Code Terminal API for execution | Output reading depends on shell-integration heuristics that fail silently. |
| Self-reported confidence as a control signal | Poorly calibrated. Logged, never trusted. |

---

## 19. Open questions

1. **Memory scope:** per-workspace or global with partitions? Start per-workspace.
2. **Executor default:** Devstral 2 vs. Mistral Medium 3.5 vs. Qwen3-Coder. Decided by the bake-off, not in advance.
3. **Critic pairing:** always cross-family, or only on large diffs to save calls?
4. **Failure disclosure:** what does the agent *say* when verification passed but the critic raised concerns? Leaning toward reporting "done, with N open concerns", never a plain "done".
5. **Voice provider:** Voxtral end to end, or NIM Riva for lower latency? Decide by measurement in Phase 5.
6. **Checkpoint retention:** when are shadow refs garbage collected?
7. **Multi-window:** one daemon per workspace to start.

---

*End of report.*
