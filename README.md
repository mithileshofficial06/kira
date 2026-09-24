# Kira

A voice-driven autonomous engineering agent for VS Code. It works unattended for long stretches, remembers your project across sessions, and can be interrupted, rewound and redirected mid-task.

Models: **Mistral** (primary) and **NVIDIA NIM** (specialist roles and cross-family critic), behind Kira's own agent loop.

- Design spec: [docs/PROJECT-REPORT.md](docs/PROJECT-REPORT.md)
- Engineering notes: [docs/notes/](docs/notes/)

## Status

**Phase 0 (loop spike):** built and tested offline; the live exit test needs API keys.
**Phase 1 (control plane):** checkpoints, rewind and the chaos exit test are done; the state machine and cost budget are next.

| Piece | State |
|---|---|
| Model registry (`kira.models.json`) and `check-models` | done |
| Mistral + NIM adapter: streaming tool calls, abort, rate limits, fallback chains | done |
| PTY process layer with verified Windows process-tree kill | done |
| Tools: files, commands, background servers, localhost HTTP, finish | done |
| Autonomy gate (hard gates, credential deny rules) | done |
| Agent loop: validation, JSON repair, loop detection, budgets, clean abort | done |
| Spike CLI with injected-failure preset | done |
| Git shadow-ref checkpoints; rewind of the interrupted step | done |
| **Phase 1 exit test:** 10 random interrupts → 0 orphans, clean tree | **passing** |
| Phase 0 exit test on both providers | **needs API keys** |
| Session state machine, cost budget, audit log | next |

## Setup

Requirements: Windows 10 1809+ or 11, Node 20+ (tested on 24), Git.

```sh
npm install
copy .env.example .env      # then add MISTRAL_API_KEY and NVIDIA_API_KEY
npm run check-models        # verifies every configured model ID and tool calling
```

Keys: [console.mistral.ai](https://console.mistral.ai/) and [build.nvidia.com](https://build.nvidia.com/). `.env` is gitignored and no Kira tool can read it.

## Run the spike

```sh
npm run spike -- --preset vite                # asks before gated actions
npm run spike -- --preset vite-typo --yes     # Phase 0 exit test: recover from a misspelled package
npm run spike -- "your goal" --workspace C:\path\to\dir
```

Ctrl+C once stops the run cleanly: process trees are killed, and history is kept up to the last complete turn. Press it twice to force quit.

## Develop

```sh
npm run typecheck
npm test
```

## Layout

```
packages/daemon/src/
  agent/       loop, system prompt, JSON repair, error-hash loop detection
  checkpoint/  git shadow-ref checkpoints and rewind
  config/      kira.models.json schema and loader
  providers/   Mistral/NIM adapter, rate limiter, fallback registry
  process/     PTY processes, descendant snapshot, tree kill
  tools/       gate, workspace scoping, file/command/background/http tools
  scripts/     check-models, spike
```
