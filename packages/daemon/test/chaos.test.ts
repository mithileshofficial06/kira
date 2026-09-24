/**
 * Phase 1 exit test (spec §10): interrupt a 10-step run at a random moment,
 * ten times in a row. Every time there must be zero orphan processes and the
 * working tree must match the last checkpoint exactly.
 */
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent, type ChatFn } from "../src/agent/loop.js";
import { git } from "../src/checkpoint/git.js";
import { CheckpointManager } from "../src/checkpoint/manager.js";
import { listDescendants } from "../src/process/descendants.js";
import { newToolCallId } from "../src/providers/tool-calls.js";
import { BackgroundManager, Gate, PHASE0_TOOLS } from "../src/tools/index.js";

const ITERATIONS = Number(process.env.KIRA_CHAOS_ITERATIONS ?? 10);
const NODE = `"${process.execPath}"`;
const NEST = join(__dirname, "fixtures", "nest.cjs");
const SERVER = `${NODE} -e "require('http').createServer((q,s)=>s.end('ok')).listen(0,function(){console.log('http://localhost:'+this.address().port+'/')})"`;

const STEPS: { name: string; args: Record<string, unknown> }[][] = [
  [{ name: "write_file", args: { path: "src/one.ts", content: "export const one = 1;\n" } }],
  [{ name: "run_command", args: { command: `${NODE} -e "setTimeout(()=>{},400)"` } }],
  [{ name: "start_background", args: { command: SERVER, waitSeconds: 20 } }],
  [
    { name: "write_file", args: { path: "src/two.ts", content: "export const two = 2;\n" } },
    { name: "write_file", args: { path: "src/one.ts", content: "export const one = 11;\n" } },
  ],
  [{ name: "run_command", args: { command: `${NODE} "${NEST}" 2`, timeoutSeconds: 2 } }],
  [{ name: "background_output", args: { id: "bg1" } }],
  [{ name: "write_file", args: { path: "src/three.ts", content: "export const three = 3;\n" } }],
  [{ name: "run_command", args: { command: `${NODE} -e "setTimeout(()=>{},600)"` } }],
  [{ name: "write_file", args: { path: "docs/notes.md", content: "# notes\n" } }],
  [{ name: "run_command", args: { command: `${NODE} -e "setInterval(()=>{},1000)"`, timeoutSeconds: 120 } }],
];

function scriptedRun(): ChatFn {
  let i = 0;
  return async function* () {
    const calls = STEPS[Math.min(i++, STEPS.length - 1)]!;
    yield { type: "model" as const, model: { provider: "mistral" as const, model: "chaos" } };
    for (const c of calls) {
      yield { type: "tool_call" as const, call: { id: newToolCallId(), name: c.name, arguments: JSON.stringify(c.args) } };
    }
    yield { type: "done" as const, finishReason: "tool_calls" };
  };
}

async function strayDescendants(baseline: Set<number>, timeoutMs = 8_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const extra = (await listDescendants(process.pid)).filter((p) => !baseline.has(p));
    if (extra.length === 0 || Date.now() > deadline) return extra;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function treeOf(ws: string, rev: string): Promise<string> {
  return git(["rev-parse", `${rev}^{tree}`], { cwd: ws });
}

describe("Phase 1 exit test: chaos interrupt", () => {
  it(`random interrupts leave no orphans and a tree equal to the last checkpoint (${ITERATIONS}x in a row)`, async () => {
    const baseline = new Set(await listDescendants(process.pid));
    const log: string[] = [];

    for (let n = 1; n <= ITERATIONS; n++) {
      const ws = await mkdtemp(join(tmpdir(), `kira-chaos-${n}-`));
      try {
        const manager = await CheckpointManager.open(ws, { initIfMissing: true });
        const background = new BackgroundManager();
        const ac = new AbortController();
        const delay = 300 + Math.floor(Math.random() * 9_000);
        const timer = setTimeout(() => ac.abort("chaos"), delay);

        const r = await runAgent(scriptedRun(), {
          goal: "chaos",
          system: "chaos",
          tools: PHASE0_TOOLS,
          ctx: { workspace: ws, gate: new Gate(async () => true), background, log: () => {} },
          signal: ac.signal,
          checkpoints: { manager, runId: "chaos" },
          maxSteps: STEPS.length + 5,
        });
        clearTimeout(timer);

        const stray = await strayDescendants(baseline);
        const checkpoints = await manager.list("chaos");
        const last = checkpoints.at(-1)!;
        const now = await manager.create("verify", 1);
        const clean = (await treeOf(ws, now.sha)) === (await treeOf(ws, last.sha));

        log.push(`#${n} abort@${delay}ms status=${r.status} step=${r.steps} rewound=${r.rewound ? "yes" : "no"} stray=${stray.length} clean=${clean}`);
        expect(r.status, log.join("\n")).toBe("aborted");
        expect(stray, log.join("\n")).toEqual([]);
        expect(clean, log.join("\n")).toBe(true);
      } finally {
        await rm(ws, { recursive: true, force: true, maxRetries: 5 });
      }
    }
    writeFileSync(join(tmpdir(), "kira-chaos-last.log"), log.join("\n") + "\n");
  }, 600_000);
});
