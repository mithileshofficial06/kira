/**
 * Phase 3 exit tests (spec §10):
 *  1. The ladder reports FAILURE on an app that boots with a 200 and renders a blank page.
 *  2. A planted stub (`// TODO: implement`) that passes L0–L4 is caught at L5.
 * Plus unit tests for the stub scan, critic selection and the runner's retry loop.
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatFn } from "../src/agent/loop.js";
import { git } from "../src/checkpoint/git.js";
import { CheckpointManager } from "../src/checkpoint/manager.js";
import { runSession } from "../src/control/runner.js";
import { findConfig, loadModelsConfig } from "../src/config/models.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { newToolCallId } from "../src/providers/tool-calls.js";
import type { ChatMessage } from "../src/providers/types.js";
import { chooseCritic, critique, modelFamily } from "../src/verify/critic.js";
import { createVerifier, detectProject, runLadder } from "../src/verify/ladder.js";
import { findStubs } from "../src/verify/stubs.js";

const HAS_BROWSER = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].some(
  existsSync,
) || !!process.env.KIRA_BROWSER || process.platform !== "win32";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kira-verify-"));
  await git(["init", "-q"], { cwd: ws });
  await git(["config", "user.email", "t@example.com"], { cwd: ws });
  await git(["config", "user.name", "t"], { cwd: ws });
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 5 });
});

async function put(files: Record<string, string>) {
  for (const [f, s] of Object.entries(files)) {
    await mkdir(dirname(join(ws, f)), { recursive: true });
    await writeFile(join(ws, f), s);
  }
}

/** A node server that serves `html` and prints its URL the way Vite does. */
const serverJs = (html: string) =>
  `const http = require("http");
const html = ${JSON.stringify(html)};
http.createServer((q, s) => { s.writeHead(200, {"content-type": "text/html"}); s.end(html); })
  .listen(0, "127.0.0.1", function () { console.log("  Local:   http://localhost:" + this.address().port + "/"); });
`;

/** A critic that always approves: models a lenient reviewer. */
const lenientCritic: ChatFn & { seen: ChatMessage[][] } = Object.assign(
  async function* (req: { messages: ChatMessage[] }) {
    lenientCritic.seen.push(req.messages);
    yield { type: "model" as const, model: { provider: "nim" as const, model: "qwen/fake-critic" } };
    yield { type: "text" as const, delta: '{"verdict":"pass","blocking":[],"concerns":[]}' };
    yield { type: "done" as const, finishReason: "stop" };
  },
  { seen: [] as ChatMessage[][] },
);

describe("findStubs", () => {
  const patch = [
    "diff --git a/src/tax.ts b/src/tax.ts",
    "--- /dev/null",
    "+++ b/src/tax.ts",
    "@@ -0,0 +1,6 @@",
    "+export function tax(x: number) {",
    "+  // TODO: implement",
    "+  return 0;",
    "+}",
    '+export function vat() { throw new Error("TODO"); }',
    "+export const ok = 1; // TODO: rename later",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,1 +1,2 @@",
    " # x",
    "+TODO: implement docs",
  ].join("\n");

  it("flags stubs on added lines with file and line, ignoring docs and harmless TODOs", () => {
    const found = findStubs(patch);
    expect(found.map((f) => `${f.file}:${f.line}:${f.rule}`)).toEqual(["src/tax.ts:2:todo-implement", "src/tax.ts:5:throw-todo"]);
  });

  it("ignores removed lines", () => {
    expect(findStubs("+++ b/a.ts\n@@ -1,1 +1,1 @@\n-// TODO: implement\n+real();")).toEqual([]);
  });
});

describe("critic selection", () => {
  it("knows model families across providers", () => {
    expect(modelFamily({ provider: "mistral", model: "devstral-latest" })).toBe("mistral");
    expect(modelFamily({ provider: "nim", model: "mistralai/mistral-large" })).toBe("mistral");
    expect(modelFamily({ provider: "nim", model: "qwen/qwen3-coder-480b-a35b-instruct" })).toBe("qwen");
    expect(modelFamily({ provider: "nim", model: "moonshotai/kimi-k2-instruct" })).toBe("kimi");
  });

  it("puts other-family critics first, and marks a same-family-only chain as degraded", () => {
    const config = loadModelsConfig(findConfig());
    const registry = new ProviderRegistry(config, { MISTRAL_API_KEY: "x", NVIDIA_API_KEY: "y" });
    const forMistral = chooseCritic(registry, "mistral/devstral-latest")!;
    expect(forMistral.crossFamily).toBe(true);
    expect(modelFamily(forMistral.chain[0]!)).not.toBe("mistral");
    const forQwen = chooseCritic(registry, "nim/qwen/qwen3-coder-480b-a35b-instruct")!;
    expect(modelFamily(forQwen.chain[0]!)).not.toBe("qwen");
    const mistralOnly = new ProviderRegistry(config, { MISTRAL_API_KEY: "x" });
    expect(chooseCritic(mistralOnly, "mistral/devstral-latest")!.crossFamily).toBe(false);
  });
});

describe("detectProject", () => {
  it("picks the package folder holding the run's changes", async () => {
    await put({ "package.json": "{}", "app/package.json": '{"scripts":{"dev":"vite"}}', "app/src/main.ts": "" });
    const p = detectProject(ws, ["app/src/main.ts"]);
    expect(p.root).toBe(join(ws, "app"));
    expect(p.pkg?.scripts?.dev).toBe("vite");
  });
});

describe.skipIf(!HAS_BROWSER)("Phase 3 exit tests", () => {
  it("reports FAILURE on an app that boots with a 200 and renders a blank page", async () => {
    await put({ "README.md": "# app\n" });
    const cm = await CheckpointManager.open(ws);
    const base = await cm.create("r", 1);
    await put({
      "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
      // The classic silent failure: the HTML shell loads, the app never mounts.
      "server.js": serverJs('<!doctype html><html><head><title>Expenses</title></head><body><div id="root"></div><script type="module">/* app never mounts */</script></body></html>'),
    });
    const report = await runLadder(
      { runId: "blank", round: 1, goal: "expense app", claim: "the app runs", baseSha: base.sha, executor: "mistral/x", signal: new AbortController().signal },
      { workspace: ws, critic: () => ({ chat: lenientCritic, crossFamily: true, chain: [] }) },
    );
    const byLevel = Object.fromEntries(report.gates.map((g) => [g.level, g]));
    expect(byLevel.L3?.status, report.summary).toBe("pass");
    expect(byLevel.L3?.summary).toMatch(/returned 200/);
    expect(byLevel.L4?.status, report.summary).toBe("fail");
    expect(byLevel.L4?.summary).toMatch(/blank/);
    expect(existsSync(byLevel.L4!.artifacts![0]!)).toBe(true);
    expect(report.passed).toBe(false);
    // L5 does not run on work that already failed.
    expect(byLevel.L5).toBeUndefined();
  }, 90_000);

  it("catches a planted stub at L5 after it passed L0–L4, even with a lenient critic", async () => {
    await put({ "README.md": "# invoices\n" });
    const cm = await CheckpointManager.open(ws);
    const base = await cm.create("r", 1);
    lenientCritic.seen.length = 0;
    await put({
      "package.json": JSON.stringify({
        scripts: { typecheck: "node --check src/total.js", build: "node build.js", test: "node test.js", dev: "node server.js" },
      }),
      "build.js": 'require("fs").mkdirSync("dist",{recursive:true});require("fs").writeFileSync("dist/ok","1");',
      "test.js": 'const {total}=require("./src/total.js");if(total([1,2])!==3)process.exit(1);console.log("1 passed");',
      "src/total.js":
        "function total(xs) { return xs.reduce((a, b) => a + b, 0); }\n" +
        "function computeTax(amount, region) {\n  // TODO: implement\n  return 0;\n}\n" +
        "module.exports = { total, computeTax };\n",
      "server.js": serverJs("<!doctype html><html><body><h1>Invoice total: 3</h1><p>Tax: 0</p></body></html>"),
    });
    const report = await runLadder(
      { runId: "stub", round: 1, goal: "invoice totals with tax per region", claim: "totals and tax implemented", baseSha: base.sha, executor: "mistral/x", signal: new AbortController().signal },
      { workspace: ws, critic: () => ({ chat: lenientCritic, crossFamily: true, chain: [] }), config: { expectText: ["Invoice total"] } },
    );
    const status = Object.fromEntries(report.gates.map((g) => [g.level, g.status]));
    expect(status, report.summary).toEqual({ L0: "pass", L1: "pass", L2: "pass", L3: "pass", L4: "pass", L5: "fail" });
    const l5 = report.gates.find((g) => g.level === "L5")!;
    expect(l5.summary).toMatch(/src\/total\.js:3 looks like a stub/);
    // The critic reviewed the whole diff, stub included, and was told what the scan found.
    const prompt = lenientCritic.seen[0]!.at(-1)!.content!;
    expect(prompt).toContain("computeTax");
    expect(prompt).toContain("A static scan already flagged");
    expect(report.passed).toBe(false);
  }, 120_000);
});

describe("runner + verifier", () => {
  it("feeds a failed verification back to the model, then accepts the fixed work", async () => {
    let round = 0;
    const verifier = {
      verify: async () => {
        round++;
        return round === 1
          ? { passed: false, round, gates: [{ level: "L4" as const, name: "renders content", status: "fail" as const, summary: "page is blank", durationMs: 1 }], concerns: [], summary: "L4 FAIL" }
          : { passed: true, round, gates: [], concerns: ["tax rounding is untested"], summary: "all gates passed" };
      },
    };
    const seen: ChatMessage[][] = [];
    const turns = [
      [{ name: "finish", args: { outcome: "done", summary: "done v1" } }],
      [{ name: "write_file", args: { path: "fix.txt", content: "fixed" } }],
      [{ name: "finish", args: { outcome: "done", summary: "done v2" } }],
    ];
    let i = 0;
    const executor: ChatFn = async function* (req) {
      seen.push(structuredClone(req.messages));
      yield { type: "model" as const, model: { provider: "mistral" as const, model: "m" } };
      for (const c of turns[Math.min(i++, turns.length - 1)]!) {
        yield { type: "tool_call" as const, call: { id: newToolCallId(), name: c.name, arguments: JSON.stringify(c.args) } };
      }
      yield { type: "done" as const, finishReason: "tool_calls" };
    };
    const report = await runSession({
      goal: "g",
      workspace: ws,
      chatFor: () => executor,
      approver: async () => true,
      signal: new AbortController().signal,
      plan: false,
      verifier,
    });
    expect(report.status).toBe("done");
    expect(report.summary).toMatch(/done v2[\s\S]*1 open concern/);
    expect(report.openQuestions).toEqual(["tax rounding is untested"]);
    expect(seen[1]!.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/verification FAILED[\s\S]*L4 renders content: page is blank/) });
  });

  it("gives up after the round cap and reports failed", async () => {
    const verifier = createVerifier({ workspace: ws, levels: ["L2"], config: { test: "node -e \"process.exit(1)\"" } });
    await put({ "package.json": "{}" });
    const executor: ChatFn = async function* () {
      yield { type: "tool_call" as const, call: { id: newToolCallId(), name: "finish", arguments: '{"outcome":"done","summary":"trust me"}' } };
      yield { type: "done" as const, finishReason: "tool_calls" };
    };
    const report = await runSession({
      goal: "g",
      workspace: ws,
      chatFor: () => executor,
      approver: async () => true,
      signal: new AbortController().signal,
      plan: false,
      verifier,
      maxVerifyRounds: 3,
    });
    expect(report.status).toBe("failed");
    expect(report.verification?.round, report.summary).toBe(3);
    expect(report.autonomy.downgrades.some((d) => /two consecutive verification failures/.test(d.reason))).toBe(true);
  }, 60_000);
});

// ---- live: a real cross-family critic catches the stub without the static scan's help ----
const configPath = (() => {
  try {
    return findConfig();
  } catch {
    return undefined;
  }
})();
if (configPath) loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });
const HAS_KEYS = !!(process.env.MISTRAL_API_KEY?.trim() || process.env.NVIDIA_API_KEY?.trim());

describe.skipIf(!HAS_KEYS)("live critic (needs API keys)", () => {
  it("a real critic model flags the planted stub from the diff alone", async () => {
    const registry = new ProviderRegistry(loadModelsConfig(configPath!));
    const choice = chooseCritic(registry, "mistral/devstral-latest")!;
    const patch = [
      "diff --git a/src/total.js b/src/total.js",
      "--- /dev/null",
      "+++ b/src/total.js",
      "@@ -0,0 +1,6 @@",
      "+function total(xs) { return xs.reduce((a, b) => a + b, 0); }",
      "+function computeTax(amount, region) {",
      "+  // TODO: implement",
      "+  return 0;",
      "+}",
      "+module.exports = { total, computeTax };",
    ].join("\n");
    const v = await critique(
      choice.chat,
      { goal: "Invoice totals with tax computed per region", claim: "Totals and per-region tax are implemented.", patch, gateSummary: "L0–L4 pass", stubs: [] },
      new AbortController().signal,
    );
    expect(v.pass, JSON.stringify(v)).toBe(false);
    expect(v.blocking.join(" ")).toMatch(/computeTax|tax|stub|TODO/i);
  }, 120_000);
});

describe("critic diff", () => {
  it("leaves lockfiles out of the critic's diff but tells it they changed", async () => {
    await put({ "README.md": "# x\n" });
    const cm = await CheckpointManager.open(ws);
    const base = await cm.create("r", 1);
    await put({
      "app/package-lock.json": JSON.stringify({ lock: "x".repeat(200_000) }),
      "app/src/App.tsx": "export const App = () => <p>{new Date().toDateString()}</p>;\n",
    });
    const seen: ChatMessage[][] = [];
    const critic: ChatFn = async function* (req) {
      seen.push(req.messages);
      yield { type: "text" as const, delta: '{"verdict":"pass","blocking":[],"concerns":[]}' };
      yield { type: "done" as const, finishReason: "stop" };
    };
    const report = await runLadder(
      { runId: "lock", round: 1, goal: "show the date", claim: "done", baseSha: base.sha, executor: "mistral/x", signal: new AbortController().signal },
      { workspace: ws, levels: ["L5"], critic: () => ({ chat: critic, crossFamily: true, chain: [] }) },
    );
    const prompt = seen[0]!.at(-1)!.content!;
    expect(prompt).toContain("+export const App");
    expect(prompt).not.toContain("xxxxxxxxxx");
    expect(prompt).toContain("Not shown: 1 lockfile/generated file change(s): A app/package-lock.json");
    expect(report.gates[0]!.summary).toMatch(/1 changed file\(s\) reviewed \(\+1 lockfile\/generated not read\)/);
  });
});
