# FORGE — Project Report

**Codename:** FORGE (*Flight-deck ORchestration for Generative Engineering*)
**One-line pitch:** A voice-driven autonomous engineering agent that lives inside VS Code, works unattended for long stretches, remembers your project across sessions, and can be interrupted, rewound, and redirected mid-task.
**Author:** Anish
**Date:** 2026-09-23
**Status:** Pre-implementation design
**Document purpose:** Build specification. Opinionated on purpose — where a choice is genuinely open it is listed in §17, not hedged inline.

---

## 1. Executive summary

The original framing of this project was "a JARVIS that controls my laptop," then narrowed to "a JARVIS that controls VS Code." Both framings center on the wrong thing: **code generation**. Code generation is a commodity. Claude Code, Cursor, Copilot Workspace, Windsurf and Devin all do it competently, and none of them are differentiated by the model anymore.

FORGE repositions around what is *not* solved:

| Solved (integrate, don't build) | Unsolved (this is the project) |
|---|---|
| LLM writes correct code | Agent remembers *why* it chose Postgres over SQLite three weeks ago |
| Tool-calling / function execution | Interrupting a 20-minute autonomous run cleanly, mid-install |
| Reading and editing files | Knowing it is actually *done* vs. merely not-erroring |
| Running a terminal command | Rewinding to a known-good state after the agent wrecks the repo |
| Streaming a response | Supervising work you are not actively watching |

The deliverable is a VS Code extension plus a local agent daemon. The agent loop itself is supplied by the **Claude Agent SDK** — the same runtime Claude Code is built on — so Phases 2–3 of the naive plan ("build tool-calling", "build the agent loop") collapse into "embed a library." The engineering effort goes into the **control plane**, the **memory system**, the **verification ladder**, and the **voice duplex**.

Realistic timeline to a working vertical slice: **3–5 weekends.** Timeline to something genuinely better than existing tools at the specific thing it targets (continuity + supervision): **3–6 months of part-time work.**

> **Naming note:** "JARVIS" is Marvel/Disney IP. Fine as a private wake word, unusable for anything public — repo name, demo video, portfolio, package registry. FORGE is a placeholder; the wake word is user-configurable and independent of the project name.

---

## 2. The core insight

Current AI coding tools are **stateless transaction machines**. You open a session, you describe context the tool should already know, it does a thing, the session dies, the context evaporates. Every session begins at amnesia.

Three properties follow from fixing that:

### 2.1 Continuity

The agent maintains a durable model of the project — not just an embedding index of the source (that is just search), but a **decision journal**: what was chosen, what was rejected, what constraint forced it, what failed when tried.

Code tells you *what*. Git tells you *when*. Nothing tells you *why* — and *why* is exactly what you lose between sessions.

### 2.2 Supervisability

Long autonomous runs are only useful if you can leave them alone. That requires the agent to be:

- **Narratable** — says what it is about to do, in one sentence, before doing it
- **Interruptible** — stops at any depth, cleanly, leaving no debris
- **Reversible** — every step is a checkpoint you can return to

### 2.3 Calibrated autonomy

Not "autonomous" or "not autonomous" — a dial. Scaffolding a component in a scratch directory should need zero approvals. `git push --force` should need an explicit spoken confirmation. The agent should escalate to the human when *its own confidence* drops, not only when a fixed rule fires.

**Voice is the interface these properties enable, not the product itself.** Voice only becomes worth having once the agent can run unattended — otherwise you are talking to something you could type at faster.

---

## 3. Product vision: a day in the life

```
09:14  You:    "Forge, where did we leave off?"
       FORGE:  "Expense tracker. Auth is done and tested. Receipt upload is
                half built — the S3 presign endpoint works, the client
                uploader doesn't. There's one failing test in billing.spec.ts
                that I left because it needs a decision from you."
                [Flight Deck opens with the diff and the failing test]

09:15  You:    "What's the decision?"
       FORGE:  "Whether a refund reopens the billing period. No precedent in
                the codebase, and it changes the schema."
       You:    "Refunds don't reopen. Keep the period closed."
       FORGE:  "Recorded. That contradicts the comment in ledger.ts line 40 —
                want me to fix the comment?"
       You:    "Yes. Then finish the uploader. Go."

09:16  [Autonomy level 3. You leave.]

       FORGE: plan -> 7 steps -> checkpoint -> execute -> verify -> repeat.
       Step 4: a Playwright assertion fails. Diagnoses, patches, re-runs.
       Step 6: wants to add a dependency — crosses a gate. Queues the
               question, continues with step 7.

09:41  [Notification; spoken if you're in the room]
       FORGE:  "Uploader done. Tests pass, build clean, verified a real file
                upload in the browser. One thing queued: I want to add
                react-dropzone. 12kb, well maintained. Yes or no?"
       You:    "No, write it by hand."
       FORGE:  "On it. Four minutes."

09:46  You:    "Actually — stop. Show me the drop zone first."
       [Abort propagates, child processes killed, repo at checkpoint 7,
        dev server still up, browser screenshot in the panel]
```

Everything in that transcript is achievable with current technology. None of it exists in one tool today.

---

## 4. The five mechanisms

These are the parts that are actually novel. Everything else is integration.

### 4.1 Checkpoint & rewind (git-backed time travel)

Before every autonomous step, the agent commits the working tree to a **shadow git ref** (`refs/forge/checkpoints/<run-id>/<step>`), invisible to your real branch and history. This makes:

- **"Forge, undo that"** a real, instant, total feature — rather than the agent trying to reverse-engineer its own edits
- Failure recovery deterministic: reset to step N, try a different approach, zero residue
- Every run auditable as a sequence of diffs

```
main ────●────────────────────────────────●   (your real commits)
          \                              /
           ● c1 ● c2 ● c3 ● c4          /    refs/forge/checkpoints/run-8f2
                       ↑ rewind here ──┘      (squashed to one commit on accept)
```

**Why nobody does this:** it requires the agent to own the git lifecycle rather than treating git as just another tool it may call. Worth the coupling.

### 4.2 Barge-in interruption

The microphone stays hot **during** execution. Wake word detected mid-run triggers a cancellation cascade:

1. `AbortController.abort()` on the in-flight LLM stream
2. `SIGINT` to the PTY session's process group; hard kill after a 2s grace period
3. Tool-call queue drained; partial writes rolled back to the last checkpoint
4. Conversation state truncated to the last **turn boundary** — never mid-tool-result, which corrupts the message history
5. Agent enters `INTERRUPTED` with a one-sentence summary of what it was doing

**This must be designed on day one.** Retrofitting cancellation into an agent loop is a rewrite, not a patch — every `await` in the tool path needs the abort signal threaded through it, and that is not something you bolt on later.

### 4.3 The verification ladder

"Run it and fix errors" is unbounded and will loop forever. Replace it with tiered gates — cheap to expensive, each a hard pass/fail:

| Tier | Gate | Cost | Catches |
|---|---|---|---|
| L0 | Parse + typecheck (`tsc --noEmit`) | ~1s | Syntax, type errors |
| L1 | Build | ~30s | Import errors, config breakage |
| L2 | Unit / integration tests | ~10s | Logic regressions |
| L3 | Process health — boots, port listens, `/` returns 200 | ~15s | Runtime crashes, boot failures |
| L4 | Semantic — Playwright asserts real DOM content | ~30s | **Blank page that returns 200** |
| L5 | Self-critique — agent reviews its own full diff cold | 1 call | Scope creep, dead code, stubs |

**L4 is the one everyone skips and the one that matters.** A dev server that boots cleanly and renders a white screen passes L0–L3 perfectly.

Every gate is paired with a **hard iteration cap** (default 3 attempts). Repeated identical failures are detected by hashing normalized error output — three identical hashes means *stop and escalate*, not retry.

### 4.4 The decision journal

A structured, append-only store of architectural decisions, written *automatically* as the agent works:

```yaml
id: ADR-014
date: 2026-09-23
title: Refunds do not reopen a billing period
status: accepted
decided_by: user (voice, 09:15)
context: >
  Refund handling in the ledger was ambiguous. No precedent in codebase.
  Affects schema: period.closed_at becomes immutable once set.
alternatives_rejected:
  - Reopen period and recompute — rejected: breaks exported statements
consequences:
  - ledger.ts:40 comment now stale — corrected in c3
  - billing.spec.ts:88 expectation inverted
supersedes: null
```

Retrieved into context at session start, and on any task touching the affected files. This is what makes the agent feel like it has been on the project *with* you, rather than meeting it fresh every morning.

### 4.5 Confidence-gated autonomy

A 0–4 dial, set per session by voice, with automatic downgrade:

| Level | Behavior |
|---|---|
| **0 — Observe** | Reads and answers. No writes. |
| **1 — Propose** | Writes a plan and a diff. Nothing applied without approval. |
| **2 — Step** | Executes one step, reports, waits. |
| **3 — Run** | Executes the full plan. Pauses only at gates. |
| **4 — Trust** | Executes and self-corrects. Reports at the end. Scratch dirs only. |

**Hard gates (pause at any level below 4):** installing a dependency · deleting files outside declared scope · any network write (`git push`, deploy, non-localhost POST) · schema migration · touching `.env` or credentials · `rm -rf` · any force operation.

**Automatic downgrade triggers:** two consecutive verification failures · a tool call touching a file outside the plan's declared scope · the agent's own stated confidence dropping below threshold in its structured plan output.

Escalation is a feature, not a failure.

---

## 5. System architecture

```
┌──────────────────────── VS CODE (Extension Host) ──────────────────────┐
│                                                                         │
│   Flight Deck Webview          Extension Backend                        │
│   ├── plan / step tree         ├── command registration                 │
│   ├── live diff view           ├── workspace + editor APIs              │
│   ├── xterm.js mirror          ├── decoration / diff rendering          │
│   ├── approval prompts         └── IPC client (JSON-RPC over stdio)     │
│   └── browser screenshots                     │                         │
└───────────────────────────────────────────────┼─────────────────────────┘
                                                │
┌─────────────────── FORGE DAEMON (separate Node process) ────────────────┐
│                                                                          │
│  ┌────────────────────── CONTROL PLANE ───────────────────────┐          │
│  │  Session FSM · AbortController tree · Autonomy gate        │          │
│  │  Checkpoint manager · Step budget · Cost meter             │          │
│  └───────────────────────────┬────────────────────────────────┘          │
│                              │                                           │
│  ┌──────────────┐   ┌────────▼─────────┐   ┌──────────────────┐         │
│  │ VOICE        │   │  AGENT RUNTIME   │   │  MEMORY          │         │
│  │ wake word    │◄─►│  Claude Agent    │◄─►│  SQLite + FTS5   │         │
│  │ VAD          │   │  SDK             │   │  + sqlite-vec    │         │
│  │ STT (stream) │   │  · planner       │   │  ├ episodic      │         │
│  │ TTS (stream) │   │  · executor      │   │  ├ semantic/ADR  │         │
│  │ barge-in     │   │  · critic        │   │  ├ procedural    │         │
│  └──────────────┘   └────────┬─────────┘   │  └ preference    │         │
│                              │             └──────────────────┘         │
│  ┌───────────────────────────▼───────────────────────────────┐          │
│  │                      TOOL LAYER                            │          │
│  │  fs (scoped) · pty (node-pty) · git · playwright · http    │          │
│  └────────────────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why a separate daemon instead of running inside the extension host:** the extension host is single-threaded, shared with every other extension, and killed on window reload. A 25-minute autonomous run cannot live there. A separate process survives reloads, can be attached to from multiple windows, and cannot freeze your editor when it does something expensive.

Cost: IPC complexity. Worth it — this is the single most important structural decision in the document.

---

## 6. Component breakdown

### 6.1 Agent runtime

**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). Opus 5 for planning and critique, Sonnet 5 for bulk execution. Wrap it behind a thin `AgentProvider` interface so the model layer is swappable — but **do not build a router now** (see §16).

### 6.2 Terminal — the non-obvious choice

> **Use `node-pty` owned by the daemon, mirrored into an xterm.js webview. Do not use the VS Code Terminal API.**

Rationale: VS Code's `Terminal` API is write-mostly. Reading command output requires shell integration (`onDidStartTerminalShellExecution` + execution read), which exists but depends on the user's shell being instrumented correctly, behaves differently across PowerShell/bash/zsh, and fails silently when a profile interferes. An agent whose ability to *read errors* is contingent on shell-integration heuristics is an agent that breaks constantly.

Owning a PTY gives you: guaranteed output capture · real TTY semantics (CLIs render correctly, interactive prompts are detectable) · true Ctrl+C signaling · a stable process tree to kill.

**Windows specifics** (primary target platform here):

- `node-pty` uses ConPTY on Windows 10 1809+. Works, but expect ANSI quirks.
- **Process trees do not die with the parent.** Kill via **Job Objects**, or `taskkill /T /F /PID` as a fallback. A plain `process.kill()` orphans `node`, the dev server, and everything they spawned. This *will* bite you — handle it in week one.
- Normalize paths to forward slashes internally, convert at the tool boundary. Never build paths by string concatenation.
- Expect `EBUSY` on writes while a file watcher holds a file — retry with backoff.

### 6.3 Voice pipeline

```
mic ──► wake word ──► VAD ──► STT (streaming) ──► intent
       (local,       (endpoint  (partials from     │
        ~50ms)        ~300ms)    ~200ms)           ▼
                                             control plane
                                                   │
speaker ◄── TTS (streaming) ◄── sentence splitter ◄┘
            (first audio ~200ms)
```

| Stage | Choice | Rationale |
|---|---|---|
| Wake word | openWakeWord (local) | Free, private, custom word, no cloud round trip. Porcupine if accuracy falls short. |
| VAD | Silero VAD (ONNX, local) | Endpointing quality dominates perceived latency far more than raw STT speed. |
| STT | Deepgram / AssemblyAI streaming; faster-whisper local as fallback | Must produce *streaming partials* — batch Whisper adds ~1.5s of dead air. |
| TTS | Streaming provider, sentence-level chunking | Speak sentence 1 while generating sentence 2. Non-negotiable. |

**Latency budget — target ≤1.5s from wake word to first audible word:**

```
wake word detect      50ms
VAD endpoint         300ms
STT final            250ms
LLM time-to-first    600ms   ← dominant term; prompt-cache the system context
TTS first chunk      200ms
────────────────────────────
total              ~1,400ms
```

Above ~2s reads as broken. Two levers matter: aggressive prompt caching on the system prompt + memory context, and starting TTS on the first complete sentence rather than the full response.

**Voice input is lossy — treat it as such.** Never route a transcript directly into a gated tool call. Echo it back as text in the Flight Deck and require confirmation. *"Use Postgres 16"* mis-transcribes to *"use post grass sixteen"* often enough to matter.

### 6.4 Memory

SQLite (`better-sqlite3`) + FTS5 for lexical search + `sqlite-vec` for embeddings. One database per workspace at `.forge/memory.db`, gitignored by default.

| Store | Contents | Retrieval |
|---|---|---|
| **Episodic** | Task log: goal, plan, steps, outcomes, errors, duration, cost | Recency + semantic; powers "where did we leave off" |
| **Semantic** | Decision journal (ADRs), project facts, architecture map | Hybrid FTS + vector, plus file-path triggers |
| **Procedural** | Learned corrections: "on this machine `npm ci` fails behind the proxy — use `--fetch-retries 5`" | Matched on tool-call signature *before* execution |
| **Preference** | Style, libraries, conventions, tone | Always in system prompt (small, cached) |

**Procedural memory is the sleeper feature.** An agent that stops making the same environment-specific mistake twice feels dramatically more intelligent than one with a bigger model behind it.

### 6.5 Browser control

Playwright, headed in a managed window during development. Used for L3/L4 verification and screenshot capture into the Flight Deck.

Keep the surface deliberately narrow: `goto` · `waitForSelector` · `assertText` · `screenshot` · `consoleErrors`. A general-purpose browser agent is a separate project — resist it.

### 6.6 File tools

Scoped to the workspace root with an explicit deny-list (`.git/`, `node_modules/`, `.env*`, anything gitignored unless declared). Every write goes through the checkpoint manager. Every write outside the current plan's declared file scope triggers an autonomy downgrade.

---

## 7. Control plane: the session state machine

```
                    ┌──────────────────────────────────────┐
                    │                                      │
   ┌──────┐  goal   ▼          approved      ┌───────────┐ │
   │ IDLE ├──────►PLANNING──────────────────►│ EXECUTING │ │
   └──▲───┘         │ │                      └─────┬─────┘ │
      │             │ │ needs approval             │       │
      │             │ ▼                            ▼       │
      │             │ AWAITING_APPROVAL      ┌───────────┐ │
      │             │                        │ VERIFYING │ │
      │             │                        └─────┬─────┘ │
      │             │                    fail      │ pass  │
      │             │                    ◄─────────┤       │
      │             │                              ▼       │
      │             │                        ┌───────────┐ │
      └─────────────┴────────────────────────┤ REPORTING │ │
                                             └───────────┘ │
   ┌─────────────┐                                         │
   │ INTERRUPTED │◄──── wake word / stop, from ANY state ───┘
   └──────┬──────┘
          └──► IDLE (state preserved, resumable)
```

Invariants that must hold for this to be reliable:

1. **Every state transition is persisted before side effects.** A daemon crash mid-run is resumable.
2. **`INTERRUPTED` is reachable from every state**, including mid-tool-call. The abort signal is threaded through every `await` in the tool path.
3. **No tool executes without passing the autonomy gate.** The gate is a single chokepoint function, not a check scattered across call sites.
4. **Conversation history is truncated only at turn boundaries.** Cutting between a tool call and its result corrupts the message array and produces bizarre downstream behavior.
5. **Every step is preceded by a checkpoint commit.** No exceptions, including "trivial" steps.

---

## 8. Roadmap — phases with exit criteria

Each phase has a **hard exit criterion**. Do not start the next until the current one passes. The most common failure mode for a project like this is adding voice to an unreliable core, which makes the core impossible to debug.

### Phase 0 — Spike · 1 weekend
Headless Node script: Agent SDK + one `run_command` tool through node-pty. Goal: *"create a Vite app, install deps, start it, confirm it serves."*
**Exit:** recovers from one deliberately injected failure (wrong package name) without human input.

### Phase 1 — Control plane · 1–2 weekends ★ highest value
State machine, AbortController tree, checkpoint/rewind, autonomy gate, step budget, cost meter. Still headless, still typed input.
**Exit:** Ctrl+C at a random moment during a 10-step run leaves **zero orphan processes and a clean `git status`** — verified 10 times consecutively.

### Phase 2 — VS Code shell · 1 weekend
Extension + daemon + JSON-RPC. Flight Deck webview: plan tree, live diff, xterm mirror, approval prompts.
**Exit:** a full run is legible from the panel alone, without reading logs.

### Phase 3 — Verification ladder · 1 weekend
L0–L5 gates, iteration caps, error-hash loop detection, Playwright integration.
**Exit:** the agent correctly reports **failure** on an app that boots with a 200 and renders a blank page. This is the best single test of whether verification is real.

### Phase 4 — Memory · 1–2 weekends
SQLite schema, four stores, hybrid retrieval, automatic ADR extraction, "where did we leave off".
**Exit:** a session started 3 days later correctly recalls an unstated constraint from the earlier session.

### Phase 5 — Voice · 1–2 weekends
Wake word, VAD, streaming STT/TTS, barge-in, sentence-chunked speech.
**Exit:** measured wake-to-first-word under 2s, and "stop" mid-install works reliably — the Phase 1 guarantee, now over audio.

### Phase 6 — Polish
Notifications for completed long runs, cost dashboard, personality tuning, session resume across window reloads.

### Deliberately deferred
Multi-model routing · Docker orchestration · OS control beyond VS Code · multi-agent parallelism · remote/cloud execution.

---

## 9. Success metrics

Measurable, so "is this working?" is not a vibe.

| Metric | Target | Why |
|---|---|---|
| Unattended run length | ≥15 min without intervention | The core claim |
| Interrupt cleanliness | 100% — no orphans, clean tree | Non-negotiable safety property |
| Verification honesty | ≥95% agreement between "done" and human review | Prevents the worst failure: confident wrongness |
| Voice round-trip | ≤1.5s p50, ≤2.5s p95 | Below the "is it broken?" threshold |
| Session recall | ≥90% on a hand-built 20-question probe set | Proves memory works |
| Cost per completed feature | Tracked, capped per run | Prevents silent budget destruction |
| Rewind usage | Used, and *correct* | If you never trust rewind, autonomy is theater |

---

## 10. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Cancellation retrofitted too late | **Critical** | Phase 1, before anything else. Abort signal in every tool signature from the first line of code. |
| R2 | Orphaned processes on Windows | High | Job Objects from day one. Test with nested spawns (npm → node → dev server). |
| R3 | Agent loops on same error, burns budget | High | Error-hash detection + hard iteration caps + per-run cost ceiling with automatic halt. |
| R4 | Verification passes on broken output | High | L4 semantic assertions. Test explicitly against a deliberately blank page. |
| R5 | Voice latency makes it feel broken | Medium | Latency budget as a tracked metric, not an afterthought. Local wake word + VAD. |
| R6 | Memory retrieval returns noise, poisons context | Medium | Hybrid retrieval, hard token budget for memory context, log what was retrieved so it is auditable. |
| R7 | Context window exhaustion on long runs | Medium | Per-step summarization. Full tool output to disk, summary to context. |
| R8 | Mis-transcription triggers destructive action | Medium | No voice transcript reaches a gated tool without written echo + confirm. |
| R9 | Scope creep into "control all of Windows" | Medium | The §8 deferred list is a contract with yourself. |
| R10 | Existing tools ship this first | Low | If they do, you have still built it and learned the hard parts. Not a reason to skip it. |

---

## 11. Cost model

Rough, and genuinely uncertain — measure on your own workload before trusting any of it.

- A feature-sized autonomous run: **hundreds of thousands to low millions of tokens** across plan/execute/verify/critique, dominated by re-sent context.
- **Prompt caching on the system prompt + memory context is the single biggest lever.** That content is stable across turns and expensive to re-send.
- Full tool output (build logs, test output) goes to disk; only summaries enter context. A raw `npm install` log alone can be tens of thousands of tokens.
- Sonnet 5 for execution; Opus 5 for planning and critique only.
- **Hard per-run cost ceiling with automatic halt.** The expensive failure is not a big task — it is a stuck loop at 3am.

---

## 12. Security & safety posture

- Credentials never enter model context. `.env*` is deny-listed **at the tool layer**, not by prompt instruction.
- Network writes (`git push`, deploys, non-localhost POSTs) are always gated regardless of autonomy level.
- All tool calls logged to an append-only audit file with timestamps and the checkpoint they ran against.
- The daemon binds to localhost only, with a per-session token. An agent daemon holding filesystem and shell access must not be network-reachable.
- Destructive operations (`rm -rf`, force-push, migrations, branch deletion) require explicit confirmation at every level, including 4.

---

## 13. What makes this defensible as a portfolio project

Worth stating plainly, because it affects what you build first.

"AI coding assistant" on a résumé reads as an API wrapper. What is actually demonstrated here:

- **Distributed systems reasoning** — process separation, IPC, crash recovery, state persistence
- **Concurrency and cancellation** — abort propagation through an async tool tree is genuinely hard and most people get it wrong
- **OS-level process management** — PTYs, signals, job objects, process trees
- **Real-time audio pipeline** — streaming, VAD, latency budgeting, barge-in
- **Information retrieval design** — hybrid search, context budgeting, retrieval evaluation
- **Verification and evaluation design** — the L0–L5 ladder is a quality-engineering argument, not a prompt

Lead with §4.2 (barge-in) and §4.3 (verification ladder) when presenting this. They are the parts that are hard and that almost nobody does.

---

## 14. The thirty-minute test

The honest benchmark for whether FORGE is real:

> Give it a genuine feature request on a codebase it has seen before. Leave the room for thirty minutes. Come back.

**Passes if:** the feature works · tests pass · you can read what it did and why · nothing outside scope was touched · any decision it could not make is queued as a clear question rather than guessed at.

**Fails if** you find yourself checking on it. If you have to watch, it is a faster autocomplete, not a flight deck.

---

## 15. Immediate next actions

1. **Phase 0 spike** — Agent SDK + node-pty, one tool, one injected failure. This weekend.
2. **Prove the Windows process-tree kill works with nested spawns** before writing anything else. Least glamorous, most likely to derail the project.
3. **Write the Phase 1 exit test first** — the script that interrupts a run at a random moment and asserts clean state. Build the control plane against that test.
4. **Defer everything in §8's deferred list**, including the ones that sound fun.

---

## 16. Explicitly rejected ideas

Recorded so they are not re-litigated later.

| Idea | Why rejected |
|---|---|
| Multi-model routing (Phase 7 of the original plan) | Premature. One good model behind a swappable interface. Add routing when a *measured* cost or latency problem demands it — never on principle. |
| Docker orchestration early | Container lifecycle, port conflicts and volume state are a second full reliability problem. SQLite until the core is solid. |
| Full OS control | Enormous surface, enormous risk, minimal marginal value over VS Code + terminal + browser + git. |
| Training or fine-tuning a model | Not the bottleneck. The bottleneck is orchestration. |
| Multi-agent parallelism | Coordination overhead exceeds benefit at this scale. Revisit after the single-agent loop is genuinely reliable. |
| VS Code Terminal API for execution | Read access depends on shell-integration heuristics that fail silently. See §6.2. |

---

## 17. Open questions

1. **Memory scope** — per-workspace, or global with workspace partitions? Global enables cross-project learning ("you always use Zod") but complicates privacy and retrieval precision.
2. **Personality depth** — how much character before it becomes irritating on the hundredth interaction? Probably: dry, brief, no filler, never apologizes twice.
3. **Failure disclosure** — when the agent is 60% confident it succeeded, what does it *say*? Overclaiming destroys trust faster than any other failure mode. Leaning toward mandatory confidence statements on completion.
4. **Multi-window** — one daemon per workspace, or one serving many? Start with one-per-workspace.
5. **Checkpoint retention** — how long before shadow refs are garbage collected? Disk cost vs. rewind depth.

---

*End of report.*
