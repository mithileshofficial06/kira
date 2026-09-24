import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent, type ChatFn, type RunOptions } from "../src/agent/loop.js";
import { CheckpointManager } from "../src/checkpoint/manager.js";
import type { ChatMessage } from "../src/providers/types.js";
import { newToolCallId } from "../src/providers/tool-calls.js";
import { BackgroundManager, Gate, PHASE0_TOOLS } from "../src/tools/index.js";

interface ScriptedTurn {
  text?: string;
  calls?: { name: string; args: unknown }[];
}

/** A fake model that plays back scripted turns and records what it was sent. */
function scripted(turns: ScriptedTurn[]): ChatFn & { seen: ChatMessage[][] } {
  let i = 0;
  const seen: ChatMessage[][] = [];
  const fn = async function* (req: { messages: ChatMessage[] }) {
    seen.push(structuredClone(req.messages));
    const t = turns[Math.min(i++, turns.length - 1)]!;
    yield { type: "model" as const, model: { provider: "mistral" as const, model: "fake" } };
    if (t.text) yield { type: "text" as const, delta: t.text };
    for (const c of t.calls ?? []) {
      yield {
        type: "tool_call" as const,
        call: { id: newToolCallId(), name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) },
      };
    }
    yield { type: "done" as const, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } };
  };
  return Object.assign(fn, { seen });
}

let ws: string;
let background: BackgroundManager;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kira-loop-"));
  background = new BackgroundManager();
});
afterEach(async () => {
  await background.stopAll();
  await rm(ws, { recursive: true, force: true });
});

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return {
    goal: "test goal",
    system: "system",
    tools: PHASE0_TOOLS,
    ctx: { workspace: ws, gate: new Gate(async () => true), background, log: () => {} },
    signal: new AbortController().signal,
    ...over,
  };
}

/** Every assistant tool call must be answered by a tool message before the next assistant turn. */
function assertTurnBoundaries(messages: ChatMessage[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls) continue;
    const answered = new Set(
      messages.slice(i + 1, i + 1 + m.toolCalls.length).flatMap((x) => (x.role === "tool" ? [x.toolCallId] : [])),
    );
    for (const c of m.toolCalls) expect(answered.has(c.id), `call ${c.name} has no result`).toBe(true);
  }
}

describe("runAgent", () => {
  it("runs tools, feeds results back, and finishes done", async () => {
    const chat = scripted([
      { text: "Writing the file.", calls: [{ name: "write_file", args: { path: "a.txt", content: "hi" } }] },
      { calls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "Wrote and read back a.txt." } }] },
    ]);
    const r = await runAgent(chat, opts());
    expect(r.status).toBe("done");
    expect(r.steps).toBe(3);
    expect(existsSync(join(ws, "a.txt"))).toBe(true);
    expect(r.usage).toEqual({ promptTokens: 30, completionTokens: 15 });
    // The model saw the read_file result on its third turn.
    const third = chat.seen[2]!;
    expect(third.some((m) => m.role === "tool" && m.content.includes("hi"))).toBe(true);
    assertTurnBoundaries(r.messages);
  });

  it("repairs sloppy JSON and reports schema errors back to the model", async () => {
    const chat = scripted([
      { calls: [{ name: "write_file", args: '```json\n{"path":"b.txt","content":"x",}\n```' }] },
      { calls: [{ name: "write_file", args: { path: "c.txt" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "ok" } }] },
    ]);
    const r = await runAgent(chat, opts());
    expect(r.status).toBe("done");
    expect(existsSync(join(ws, "b.txt"))).toBe(true);
    expect(r.malformedCalls).toBe(1);
    const toolMsgs = r.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
    expect(toolMsgs.some((c) => c.startsWith("Invalid arguments for write_file: content"))).toBe(true);
  });

  it("stops as stuck when the same error repeats", async () => {
    const chat = scripted([{ calls: [{ name: "read_file", args: { path: "missing.txt" } }] }]);
    const r = await runAgent(chat, opts({ maxRepeatedErrors: 3 }));
    expect(r.status).toBe("stuck");
    expect(r.steps).toBe(3);
  });

  it("stops as confused after too many malformed calls in one step", async () => {
    const bad = { name: "rm_everything", args: {} };
    const r = await runAgent(scripted([{ calls: [bad, bad, bad] }]), opts());
    expect(r.status).toBe("confused");
    assertTurnBoundaries(r.messages);
  });

  it("nudges, then stops as stalled when the model never calls tools", async () => {
    const r = await runAgent(scripted([{ text: "I think it is done." }]), opts({ maxIdleTurns: 2 }));
    expect(r.status).toBe("stalled");
    expect(r.steps).toBe(3);
  });

  it("stops at the step budget", async () => {
    const r = await runAgent(scripted([{ calls: [{ name: "list_dir", args: {} }] }]), opts({ maxSteps: 4 }));
    expect(r.status).toBe("budget");
    expect(r.steps).toBe(4);
  });

  it("aborts mid-command: returns aborted, keeps only complete turns, leaves no processes", async () => {
    const ac = new AbortController();
    const node = `"${process.execPath}"`;
    const chat = scripted([
      { calls: [{ name: "write_file", args: { path: "d.txt", content: "1" } }] },
      { calls: [{ name: "run_command", args: { command: `${node} -e "setInterval(()=>{},1000)"` } }] },
    ]);
    let commandStarted = false;
    const run = runAgent(
      chat,
      opts({
        signal: ac.signal,
        ctx: {
          workspace: ws,
          gate: new Gate(async () => true),
          background,
          log: (l) => {
            if (l.startsWith("$ ")) commandStarted = true;
          },
        },
      }),
    );
    while (!commandStarted) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 800));
    const t0 = Date.now();
    ac.abort("user said stop");
    const r = await run;

    expect(r.status).toBe("aborted");
    // Shared CI runners start PowerShell and taskkill several times slower than a dev machine.
    expect(Date.now() - t0).toBeLessThan(process.env.CI ? 30_000 : 10_000);
    // Step 1 committed; the interrupted step 2 was dropped whole.
    const assistants = r.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    assertTurnBoundaries(r.messages);
  }, 60_000);

  it("with checkpoints: an interrupt rewinds the partial writes of the interrupted step", async () => {
    const manager = await CheckpointManager.open(ws, { initIfMissing: true });
    const ac = new AbortController();
    const node = `"${process.execPath}"`;
    const chat = scripted([
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "good" } }] },
      {
        calls: [
          { name: "write_file", args: { path: "a.txt", content: "half-done" } },
          { name: "write_file", args: { path: "b.txt", content: "new" } },
          { name: "run_command", args: { command: `${node} -e "setInterval(()=>{},1000)"` } },
        ],
      },
    ]);
    let commandStarted = false;
    const run = runAgent(
      chat,
      opts({
        signal: ac.signal,
        checkpoints: { manager, runId: "t1" },
        ctx: {
          workspace: ws,
          gate: new Gate(async () => true),
          background,
          log: (l) => {
            if (l.startsWith("$ ")) commandStarted = true;
          },
        },
      }),
    );
    while (!commandStarted) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
    ac.abort("stop");
    const r = await run;

    expect(r.status).toBe("aborted");
    expect(r.rewound?.step).toBe(2);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("good");
    expect(existsSync(join(ws, "b.txt"))).toBe(false);
    expect((await manager.list("t1")).map((c) => c.step)).toEqual([1, 2]);
  }, 30_000);

  it("stops background processes when the run ends", async () => {
    const node = `"${process.execPath}"`;
    const server = `${node} -e "require('http').createServer((q,s)=>s.end('x')).listen(0,function(){console.log('http://localhost:'+this.address().port+'/')})"`;
    const chat = scripted([
      { calls: [{ name: "start_background", args: { command: server, waitSeconds: 20 } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "server ran" } }] },
    ]);
    const r = await runAgent(chat, opts());
    expect(r.status).toBe("done");
    expect(background.list()).toEqual([]);
  }, 30_000);
});
