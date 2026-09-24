import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent, type ChatFn, type RunOptions } from "../src/agent/loop.js";
import { Autonomy } from "../src/control/autonomy.js";
import { Budget } from "../src/control/budget.js";
import { runDirFor, runSession } from "../src/control/runner.js";
import { IllegalTransitionError, Session, type SessionRecord } from "../src/control/session.js";
import { newToolCallId } from "../src/providers/tool-calls.js";
import type { ChatMessage } from "../src/providers/types.js";
import { BackgroundManager, EXECUTOR_TOOLS, Gate, inScope, type GateRequest } from "../src/tools/index.js";

interface Turn {
  text?: string;
  calls?: { name: string; args: unknown }[];
  usage?: { promptTokens: number; completionTokens: number };
}

function scripted(turns: Turn[]): ChatFn & { seen: ChatMessage[][] } {
  let i = 0;
  const seen: ChatMessage[][] = [];
  const fn = async function* (req: { messages: ChatMessage[] }) {
    seen.push(structuredClone(req.messages));
    const t = turns[Math.min(i++, turns.length - 1)]!;
    yield { type: "model" as const, model: { provider: "mistral" as const, model: "m" } };
    if (t.text) yield { type: "text" as const, delta: t.text };
    for (const c of t.calls ?? []) {
      yield { type: "tool_call" as const, call: { id: newToolCallId(), name: c.name, arguments: JSON.stringify(c.args) } };
    }
    yield { type: "done" as const, finishReason: "stop", usage: t.usage ?? { promptTokens: 10, completionTokens: 5 } };
  };
  return Object.assign(fn, { seen });
}

const write = (path: string, content = "x") => ({ name: "write_file", args: { path, content } });
const finish = (summary = "ok") => ({ name: "finish", args: { outcome: "done", summary } });

let ws: string;
let background: BackgroundManager;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kira-ctl-"));
  background = new BackgroundManager();
});
afterEach(async () => {
  await background.stopAll();
  await rm(ws, { recursive: true, force: true, maxRetries: 5 });
});

function loopOpts(gate: Gate, over: Partial<RunOptions> = {}): RunOptions {
  return {
    goal: "g",
    system: "s",
    tools: EXECUTOR_TOOLS,
    ctx: { workspace: ws, gate, background, log: () => {} },
    signal: new AbortController().signal,
    ...over,
  };
}

describe("Session state machine", () => {
  it("allows the spec's transitions and rejects the rest", () => {
    const s = Session.create("r1", "goal");
    s.to("PLANNING");
    s.to("EXECUTING");
    s.to("VERIFYING");
    s.to("EXECUTING");
    expect(() => s.to("IDLE")).toThrow(IllegalTransitionError);
    s.to("VERIFYING");
    s.to("REPORTING");
    s.to("IDLE");
    expect(s.state).toBe("IDLE");
  });

  it("reaches INTERRUPTED and RATE_LIMITED from anywhere; RATE_LIMITED returns to the interrupted state", () => {
    const s = Session.create("r1", "goal");
    s.to("PLANNING");
    s.rateLimited(Date.now() + 1000, "429");
    expect(s.state).toBe("RATE_LIMITED");
    expect(s.record.resumeAt).toBeGreaterThan(Date.now());
    s.resume();
    expect(s.state).toBe("PLANNING");
    s.to("EXECUTING");
    s.to("VERIFYING");
    s.to("INTERRUPTED");
    s.to("REPORTING");
  });

  it("persists every transition before returning, and reloads after a crash", async () => {
    const dir = join(ws, "run");
    const s = Session.create("r1", "goal", dir);
    let seenOnDisk: string | undefined;
    s.onTransition((t) => {
      seenOnDisk = (JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionRecord).state;
      expect(seenOnDisk).toBe(t.to);
    });
    s.to("EXECUTING");
    expect(seenOnDisk).toBe("EXECUTING");
    const reloaded = Session.load(dir);
    expect(reloaded.state).toBe("EXECUTING");
    expect(reloaded.wasInterruptedByCrash).toBe(true);
  });
});

describe("Budget", () => {
  it("prices calls from the table and flags unpriced models", () => {
    const b = new Budget({ maxCostUsd: 1 }, { "mistral:big": { inputPerM: 2, outputPerM: 6 } });
    expect(b.addUsage({ provider: "mistral", model: "big" }, { promptTokens: 1_000_000, completionTokens: 0 })).toBeCloseTo(2);
    b.addUsage({ provider: "nim", model: "free" }, { promptTokens: 10, completionTokens: 10 });
    expect(b.snapshot().unpriced).toEqual(["nim/free"]);
    expect(b.exceeded()).toMatch(/cost budget/);
  });

  it("halts the run when the cost ceiling is reached", async () => {
    const budget = new Budget({ maxCostUsd: 0.01 }, { "mistral:m": { inputPerM: 1000, outputPerM: 0 } });
    const chat = scripted([{ calls: [write("a.txt")], usage: { promptTokens: 20, completionTokens: 0 } }]);
    const r = await runAgent(chat, loopOpts(new Gate(async () => true), { budget }));
    expect(r.status).toBe("budget");
    expect(r.steps).toBe(1);
    expect(r.summary).toMatch(/cost budget/);
  });
});

describe("autonomy levels at the chokepoint", () => {
  it("level 0 refuses writes and commands but allows reads", async () => {
    const gate = new Gate(async () => true, { autonomy: new Autonomy(0) });
    const chat = scripted([{ calls: [write("a.txt"), { name: "list_dir", args: {} }] }, { calls: [finish()] }]);
    const r = await runAgent(chat, loopOpts(gate));
    expect(r.status).toBe("done");
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
    const results = r.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results[0]).toMatch(/level 0/);
  });

  it("level 1 proposes every write and honours a no", async () => {
    const asked: GateRequest[] = [];
    const gate = new Gate(async (req) => (asked.push(req), req.summary.includes("b.txt")), { autonomy: new Autonomy(1) });
    const chat = scripted([{ calls: [write("a.txt"), write("b.txt")] }, { calls: [finish()] }]);
    await runAgent(chat, loopOpts(gate));
    expect(asked.map((a) => a.category)).toEqual(["propose", "propose"]);
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
    expect(existsSync(join(ws, "b.txt"))).toBe(true);
  });

  it("level 2 asks between steps and stops when told to", async () => {
    const asked: string[] = [];
    const gate = new Gate(async (req) => (asked.push(req.category), asked.length < 2), { autonomy: new Autonomy(2) });
    const chat = scripted([{ calls: [write("a.txt")] }, { calls: [write("b.txt")] }, { calls: [write("c.txt")] }]);
    const r = await runAgent(chat, loopOpts(gate));
    expect(r.status).toBe("blocked");
    expect(r.steps).toBe(2);
    expect(asked).toEqual(["step", "step"]);
  });

  it("asks once for a hard-gated command even though the tool checks again", async () => {
    const asked: string[] = [];
    const gate = new Gate(async (req) => (asked.push(req.summary), false));
    const chat = scripted([{ calls: [{ name: "run_command", args: { command: "git push origin main" } }] }, { calls: [finish()] }]);
    const r = await runAgent(chat, loopOpts(gate));
    expect(asked).toEqual(["git push origin main"]);
    expect(r.messages.some((m) => m.role === "tool" && m.content.includes("declined"))).toBe(true);
    expect(gate.decisions).toHaveLength(1);
  });

  it("records the human's note with the decision", async () => {
    const gate = new Gate(async () => ({ allow: false, note: "write it by hand" }));
    const d = await gate.checkCommand("run_command", "npm install react-dropzone", new AbortController().signal);
    expect(d.allow).toBe(false);
    expect(gate.decisions[0]).toMatchObject({ category: "dependency-install", allow: false, note: "write it by hand" });
  });
});

describe("automatic downgrade triggers", () => {
  it("a write outside the declared scope downgrades 3 -> 2", async () => {
    const autonomy = new Autonomy(3);
    const gate = new Gate(async () => true, { autonomy, scope: ["src/"] });
    const chat = scripted([{ calls: [write("src/ok.ts"), write("elsewhere.ts")] }, { calls: [finish()] }]);
    await runAgent(chat, loopOpts(gate));
    expect(autonomy.level).toBe(2);
    expect(autonomy.downgrades[0]!.reason).toMatch(/outside the declared scope: elsewhere.ts/);
  });

  it("a repeated error hash downgrades before the run stops as stuck", async () => {
    const autonomy = new Autonomy(3);
    const chat = scripted([{ calls: [{ name: "read_file", args: { path: "missing.txt" } }] }]);
    const r = await runAgent(chat, loopOpts(new Gate(async () => true, { autonomy })));
    expect(r.status).toBe("stuck");
    expect(autonomy.downgrades.map((d) => d.reason)).toEqual([expect.stringMatching(/same error hash appeared twice/)]);
  });

  it("more than 2 malformed calls in one step downgrades", async () => {
    const autonomy = new Autonomy(4);
    const bad = { name: "write_file", args: { nope: 1 } };
    await runAgent(scripted([{ calls: [bad, bad, bad] }]), loopOpts(new Gate(async () => true, { autonomy })));
    expect(autonomy.level).toBe(3);
  });

  it("never downgrades below 1", () => {
    const a = new Autonomy(1);
    expect(a.downgrade("x")).toBe(false);
    expect(a.level).toBe(1);
  });

  it("scope matching handles prefixes and globs", () => {
    expect(inScope("src/a/b.ts", ["src/"])).toBe(true);
    expect(inScope("src\\a.ts", ["src"])).toBe(true);
    expect(inScope("srcx/a.ts", ["src"])).toBe(false);
    expect(inScope("lib/x.test.ts", ["lib/**/*.test.ts", "docs/"])).toBe(false);
    expect(inScope("lib/a/x.test.ts", ["lib/**/*.test.ts"])).toBe(true);
    expect(inScope("README.md", ["*.md"])).toBe(true);
  });
});

describe("step wall-clock budget", () => {
  it("stops an overlong step, tells the model, and carries on", async () => {
    const node = `"${process.execPath}"`;
    const chat = scripted([
      { calls: [{ name: "run_command", args: { command: `${node} -e "setInterval(()=>{},1000)"` } }] },
      { calls: [finish("recovered")] },
    ]);
    const r = await runAgent(chat, loopOpts(new Gate(async () => true), { stepTimeoutMs: 1500 }));
    expect(r.status).toBe("done");
    expect(chat.seen[1]!.at(-1)).toMatchObject({ role: "user", content: expect.stringMatching(/wall-clock budget/) });
  }, 30_000);
});

describe("runSession", () => {
  it("plans, executes, reports, and writes session, history, audit and report files", async () => {
    const planner = scripted([{ text: '{"steps":["write a","finish"],"scope":["a.txt"]}' }]);
    const executor = scripted([
      { calls: [{ name: "update_plan", args: { steps: [{ title: "write a", status: "done" }, { title: "finish", status: "active" }] } }, write("a.txt", "hello")] },
      { calls: [finish("wrote a.txt")] },
    ]);
    const report = await runSession({
      goal: "make a.txt",
      workspace: ws,
      chatFor: (role) => (role === "planner" ? planner : executor),
      approver: async () => true,
      signal: new AbortController().signal,
      initGit: true,
    });
    expect(report.status).toBe("done");
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("hello");
    // The executor saw the plan and the declared scope.
    expect(executor.seen[0]![1]!.content).toMatch(/1\. write a[\s\S]*Declared file scope: a.txt/);
    const dir = runDirFor(ws, report.runId);
    for (const f of ["session.json", "history.json", "audit.jsonl", "report.json", "report.md"]) expect(existsSync(join(dir, f)), f).toBe(true);
    const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionRecord;
    expect(session.transitions.map((t) => t.to)).toEqual(["PLANNING", "EXECUTING", "REPORTING", "IDLE"]);
  });

  it("an interrupt goes through INTERRUPTED and still writes a report", async () => {
    const ac = new AbortController();
    const node = `"${process.execPath}"`;
    const executor = scripted([{ calls: [{ name: "run_command", args: { command: `${node} -e "setInterval(()=>{},1000)"` } }] }]);
    setTimeout(() => ac.abort("stop"), 1500);
    const report = await runSession({
      goal: "hang",
      workspace: ws,
      chatFor: () => executor,
      approver: async () => true,
      signal: ac.signal,
      plan: false,
      initGit: true,
    });
    expect(report.status).toBe("aborted");
    const session = JSON.parse(readFileSync(join(runDirFor(ws, report.runId), "session.json"), "utf8")) as SessionRecord;
    expect(session.transitions.map((t) => t.to)).toEqual(["EXECUTING", "INTERRUPTED", "REPORTING", "IDLE"]);
  }, 30_000);

  it("resumes a crashed run from its persisted history", async () => {
    const first = scripted([{ calls: [write("a.txt", "1")] }, { calls: [write("b.txt", "2")] }]);
    // Simulate a crash: the run is cut off by the step budget while EXECUTING, then its session is rewritten to look mid-run.
    const r1 = await runSession({
      goal: "two files",
      workspace: ws,
      chatFor: () => first,
      approver: async () => true,
      signal: new AbortController().signal,
      plan: false,
      initGit: true,
      limits: { maxSteps: 1 },
    });
    const dir = runDirFor(ws, r1.runId);
    const s = Session.load(dir);
    expect(s.state).toBe("IDLE");

    const second = scripted([{ calls: [write("b.txt", "2")] }, { calls: [finish("both")] }]);
    const r2 = await runSession({
      goal: "two files",
      workspace: ws,
      chatFor: () => second,
      approver: async () => true,
      signal: new AbortController().signal,
      plan: false,
      resumeRunId: r1.runId,
      limits: { maxSteps: 5 },
    });
    expect(r2.status).toBe("done");
    // The resumed model saw the first run's committed turn.
    expect(second.seen[0]!.some((m) => m.role === "tool" && m.content.includes("a.txt"))).toBe(true);
    expect(await readFile(join(ws, "b.txt"), "utf8")).toBe("2");
  });
});
