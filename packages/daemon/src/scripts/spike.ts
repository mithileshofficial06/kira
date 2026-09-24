/**
 * Phase 0 spike: run the agent loop headless against real models.
 *
 *   npm run spike -- --preset vite
 *   npm run spike -- --preset vite-typo --yes        (Phase 0 exit test: injected failure)
 *   npm run spike -- "your goal" --workspace C:\path\to\dir
 *
 * Flags:
 *   --preset <name>     vite | vite-typo
 *   --workspace <dir>   working directory (default: a fresh temp folder)
 *   --yes               approve every gated action without asking
 *   --role <role>       model role to drive the loop (default: executor)
 *   --max-steps <n>     step budget (default 30)
 *
 * Ctrl+C once interrupts cleanly (process trees killed, history kept to the
 * last complete turn). Ctrl+C twice exits immediately.
 */
import { config as loadEnv } from "dotenv";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { runAgent, type AgentEvent } from "../agent/loop.js";
import { systemPrompt } from "../agent/prompt.js";
import { findConfig, loadModelsConfig, Role } from "../config/models.js";
import { ProviderRegistry } from "../providers/registry.js";
import { BackgroundManager, Gate, PHASE0_TOOLS, type Approver } from "../tools/index.js";

const PRESETS: Record<string, string> = {
  vite:
    "Create a new Vite + React + TypeScript app in the folder ./app (non-interactively), install its dependencies, " +
    "start the dev server, and confirm it serves the app over HTTP. Then finish.",
  "vite-typo":
    "Create a new Vite + React + TypeScript app in the folder ./app (non-interactively), install its dependencies, " +
    "then add the npm package 'axois' to it (that is the name I was given). Start the dev server and confirm it " +
    "serves the app over HTTP. Then finish.",
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preset: { type: "string" },
    workspace: { type: "string" },
    yes: { type: "boolean", default: false },
    role: { type: "string", default: "executor" },
    "max-steps": { type: "string", default: "30" },
  },
});

const goal = positionals.join(" ") || (values.preset ? PRESETS[values.preset] : undefined);
if (!goal) {
  console.error(`Give a goal or --preset (${Object.keys(PRESETS).join(", ")}).`);
  process.exit(2);
}
const role = Role.parse(values.role);

const configPath = findConfig();
loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });
const registry = new ProviderRegistry(loadModelsConfig(configPath));
if (registry.chain(role).length === 0) {
  console.error(`No API key for any "${role}" model. Copy .env.example to .env and add MISTRAL_API_KEY and/or NVIDIA_API_KEY.`);
  process.exit(2);
}

const workspace = resolve(values.workspace ?? join(tmpdir(), `kira-spike-${Date.now()}`));
await mkdir(workspace, { recursive: true });

// ---- interrupt handling ------------------------------------------------
const controller = new AbortController();
let interrupts = 0;
process.on("SIGINT", () => {
  interrupts++;
  if (interrupts === 1) {
    console.log("\n[kira] interrupt: stopping cleanly (Ctrl+C again to force quit)");
    controller.abort("user interrupt");
  } else {
    process.exit(130);
  }
});

// ---- approvals ---------------------------------------------------------
const approver: Approver = async (req, signal) => {
  if (values.yes) {
    console.log(`[gate] auto-approved ${req.category}: ${req.summary}`);
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`[gate] ${req.category}: ${req.summary}\n       allow? [y/N] `, { signal });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

// ---- output ------------------------------------------------------------
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const onEvent = (e: AgentEvent) => {
  switch (e.type) {
    case "step":
      console.log(dim(`\n── ${e.text} ──`));
      break;
    case "model":
      console.log(dim(`   model: ${e.text}`));
      break;
    case "narration":
      console.log(bold(`kira: ${e.text}`));
      break;
    case "tool_call":
      console.log(`  → ${e.text}`);
      break;
    case "tool_result":
      console.log(dim(`  ← ${e.text}`));
      break;
    default:
      console.log(`  ! ${e.text}`);
  }
};

console.log(`[kira] workspace: ${workspace}`);
console.log(`[kira] role: ${role} → ${registry.chain(role).map((r) => `${r.provider}/${r.model}`).join(" → ")}`);
console.log(`[kira] goal: ${goal}`);

const started = Date.now();
const result = await runAgent((req, signal, onFallback) => registry.chat(role, req, signal, onFallback), {
  goal,
  system: systemPrompt({ workspace, platform: process.platform }),
  tools: PHASE0_TOOLS,
  ctx: { workspace, gate: new Gate(approver), background: new BackgroundManager(), log: (l) => console.log(dim(`    ${l}`)) },
  signal: controller.signal,
  maxSteps: Number(values["max-steps"]),
  onEvent,
});

const secs = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\n${bold(`[kira] ${result.status.toUpperCase()}`)} after ${result.steps} steps, ${secs}s`);
console.log(result.summary);
console.log(
  dim(
    `tokens: ${result.usage.promptTokens} in / ${result.usage.completionTokens} out · malformed calls: ${result.malformedCalls} · ` +
      `models: ${[...new Set(result.models.map((m) => `${m.provider}/${m.model}`))].join(", ")}`,
  ),
);
process.exit(result.status === "done" ? 0 : 1);
