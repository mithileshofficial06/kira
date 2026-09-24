/**
 * Headless Kira run against real models.
 *
 *   npm run spike -- --preset vite
 *   npm run spike -- --preset vite-typo --yes        (Phase 0 exit test: injected failure)
 *   npm run spike -- "your goal" --workspace C:\path\to\dir
 *
 * Flags:
 *   --preset <name>      vite | vite-typo
 *   --workspace <dir>    working directory (default: a fresh temp folder)
 *   --yes                approve every gated action without asking
 *   --autonomy <0-4>     observe | propose | step | run | trust (default 3)
 *   --no-plan            skip the planner
 *   --no-verify          skip the verification ladder
 *   --max-steps <n>      step budget (default 30)
 *   --max-cost <usd>     cost ceiling (default 2)
 *   --resume <runId>     continue a run whose process died
 *   --executor <p/model> pin the executor to one model, e.g. nim/z-ai/glm-5.3 (Phase 0 "both providers", bake-off)
 *
 * Ctrl+C once interrupts cleanly (process trees killed, the interrupted step
 * rewound, history kept to the last complete turn). Ctrl+C twice exits.
 */
import { config as loadEnv } from "dotenv";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { AutonomyLevel } from "../control/autonomy.js";
import type { KiraEvent } from "../control/events.js";
import { runSession } from "../control/runner.js";
import { findConfig, loadModelsConfig } from "../config/models.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { Approver } from "../tools/index.js";
import { parseModelLabel } from "../verify/critic.js";
import { createVerifier } from "../verify/ladder.js";
import { openMemory } from "../memory/run-memory.js";

const PRESETS: Record<string, string> = {
  vite:
    "Create a new Vite + React + TypeScript app in the folder ./app (non-interactively), install its dependencies, " +
    "start the dev server, and confirm it serves the app over HTTP. Then finish.",
  // Phase 0 exit test. 'dayjss' does not exist on npm, so the install really fails and the agent must recover.
  // (The first version used 'axois', which turned out to be a real, typosquat-looking package: the install succeeded.)
  "vite-typo":
    "Create a new Vite + React + TypeScript app in the folder ./app (non-interactively), install its dependencies, " +
    "then add the npm package 'dayjss' to it (that is the name I was given) and use it to show today's date on the page. " +
    "Start the dev server and confirm it serves the app over HTTP. Then finish.",
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preset: { type: "string" },
    workspace: { type: "string" },
    yes: { type: "boolean", default: false },
    autonomy: { type: "string", default: "3" },
    "no-plan": { type: "boolean", default: false },
    "no-verify": { type: "boolean", default: false },
    "max-steps": { type: "string", default: "30" },
    "max-cost": { type: "string", default: "2" },
    resume: { type: "string" },
    executor: { type: "string" },
  },
});

const goal = positionals.join(" ") || (values.preset ? PRESETS[values.preset] : undefined);
if (!goal && !values.resume) {
  console.error(`Give a goal or --preset (${Object.keys(PRESETS).join(", ")}).`);
  process.exit(2);
}
const autonomy = Number(values.autonomy);
if (![0, 1, 2, 3, 4].includes(autonomy)) {
  console.error("--autonomy must be 0-4");
  process.exit(2);
}

const configPath = findConfig();
loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });
const config = loadModelsConfig(configPath);
const registry = new ProviderRegistry(config);
if (registry.chain("executor").length === 0) {
  console.error('No API key for any "executor" model. Copy .env.example to .env and add MISTRAL_API_KEY and/or NVIDIA_API_KEY.');
  process.exit(2);
}

const pinnedExecutor = values.executor ? parseModelLabel(values.executor) : undefined;
if (values.executor && !pinnedExecutor) {
  console.error('--executor must look like "mistral/codestral-latest" or "nim/z-ai/glm-5.3"');
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
    const answer = await rl.question(`[gate] ${req.category}: ${req.summary}\n       allow? [y/N, or "n: reason"] `, { signal });
    const m = answer.trim().match(/^(y(es)?|n(o)?)\s*(?::\s*(.*))?$/i);
    return { allow: !!m && /^y/i.test(m[1]!), ...(m?.[4] ? { note: m[4] } : {}) };
  } finally {
    rl.close();
  }
};

// ---- output ------------------------------------------------------------
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const onEvent = (k: KiraEvent) => {
  switch (k.type) {
    case "state":
      console.log(dim(`[state] ${k.state}${k.detail ? `: ${k.detail}` : ""}`));
      return;
    case "plan":
      console.log(dim(`[plan] ${k.steps.map((s) => `${s.status === "done" ? "✓" : s.status === "active" ? "▶" : "·"} ${s.title}`).join("  ")}`));
      return;
    case "autonomy":
      console.log(bold(`[autonomy] now level ${k.level}: ${k.reason}`));
      return;
    case "verification":
      for (const g of k.report.gates) console.log(`  [${g.level}] ${g.status.toUpperCase()} ${g.name}: ${g.summary}`);
      return;
    case "memory":
      console.log(dim(`[memory] ${k.items.map((i) => `${i.kind}:${i.title}`).join(" | ")}`));
      return;
    case "agent":
      break;
    default:
      return;
  }
  const e = k.event;
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
    case "checkpoint":
    case "budget":
      break;
    default:
      console.log(`  ! ${e.text}`);
  }
};

const memory = await openMemory(workspace, registry, config);
console.log(`[kira] workspace: ${workspace}`);
console.log(`[kira] executor: ${(pinnedExecutor ? [pinnedExecutor] : registry.chain("executor")).map((r) => `${r.provider}/${r.model}`).join(" → ")}`);
console.log(`[kira] goal: ${goal ?? `(resuming ${values.resume})`}`);

const report = await runSession({
  goal: goal ?? "",
  workspace,
  chatFor: (role) => (req, signal, onFallback) =>
    role === "executor" && pinnedExecutor
      ? registry.chatWith(role, [pinnedExecutor], req, signal, onFallback)
      : registry.chat(role, req, signal, onFallback),
  approver,
  signal: controller.signal,
  autonomy: autonomy as AutonomyLevel,
  plan: !values["no-plan"],
  initGit: !values.workspace,
  limits: { maxSteps: Number(values["max-steps"]), maxCostUsd: Number(values["max-cost"]) },
  pricing: config.pricing,
  onEvent,
  verifier: values["no-verify"] ? undefined : createVerifier({ workspace, registry }),
  memory,
  ...(values.resume ? { resumeRunId: values.resume } : {}),
});
memory.close();

console.log(`\n${bold(`[kira] ${report.status.toUpperCase()}`)} after ${report.steps} steps, ${(report.durationMs / 1000).toFixed(0)}s`);
console.log(report.summary);
console.log(
  dim(
    `cost: $${report.budget.costUsd.toFixed(4)} · tokens: ${report.budget.tokens} · malformed calls: ${report.malformedCalls} · ` +
      `fallbacks: ${report.fallbacks} · models: ${report.models.join(", ")}`,
  ),
);
console.log(dim(`report: ${join(report.runDir ?? "", "report.md")}`));
process.exit(report.status === "done" ? 0 : 1);
