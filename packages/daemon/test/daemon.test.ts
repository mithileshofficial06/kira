/**
 * Phase 2: the daemon over a real named pipe with a real JSON-RPC client.
 * The client rebuilds the Flight Deck from notifications alone (the same
 * reducer the webview runs), and the test checks the whole run is legible
 * from that state: goal, plan, steps, commands, approvals, diff, verification
 * and the final report.
 */
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import type { ChatFn } from "../src/agent/loop.js";
import type { KiraEvent } from "../src/control/events.js";
import { emptyDeck, pendingApprovals, reduceDeck, type DeckState } from "../src/daemon/deck.js";
import { Methods, type EventNotification, type HelloResult, type StartResult } from "../src/daemon/protocol.js";
import { KiraDaemon, pipeName } from "../src/daemon/server.js";
import { KiraMemory, memoryFile } from "../src/memory/run-memory.js";
import { runInPty } from "../src/process/pty-process.js";
import { newToolCallId } from "../src/providers/tool-calls.js";

const TOKEN = "test-token-123";
const NODE = `"${process.execPath}"`;

let ws: string;
let daemon: KiraDaemon;
let pipe: string;
let memory: KiraMemory;

function scripted(turns: { text?: string; calls?: { name: string; args: unknown }[] }[]): ChatFn {
  let i = 0;
  return async function* () {
    const t = turns[Math.min(i++, turns.length - 1)]!;
    yield { type: "model" as const, model: { provider: "mistral" as const, model: "fake-exec" } };
    if (t.text) yield { type: "text" as const, delta: t.text };
    for (const c of t.calls ?? []) yield { type: "tool_call" as const, call: { id: newToolCallId(), name: c.name, arguments: JSON.stringify(c.args) } };
    yield { type: "done" as const, finishReason: "stop", usage: { promptTokens: 1000, completionTokens: 200 } };
  };
}

let executor: ChatFn;
const planner = scripted([{ text: '{"steps":["Write the greeting module","Install left-pad","Verify and finish"],"scope":["src/"]}' }]);

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kira-daemon-"));
  pipe = pipeName(ws);
  memory = new KiraMemory(memoryFile(ws));
  daemon = new KiraDaemon({
    workspace: ws,
    pipe,
    token: TOKEN,
    initGit: true,
    chatFor: (role) => (role === "planner" ? planner : executor),
    pricing: { "mistral:fake-exec": { inputPerM: 0.4, outputPerM: 2 } },
    memory,
    verifier: () => ({
      verify: async ({ round }) => ({
        passed: true,
        round,
        gates: [
          { level: "L0", name: "typecheck", status: "pass", summary: "tsc passed", durationMs: 900 },
          { level: "L4", name: "renders content", status: "skip", summary: "nothing is served", durationMs: 0 },
          { level: "L5", name: "critic", status: "pass", summary: "no blocking issue", durationMs: 1200 },
        ],
        concerns: ["greeting is not localized"],
        summary: "L0 pass · L4 skip · L5 pass",
      }),
    }),
  });
  await daemon.listen();
});

afterEach(async () => {
  await daemon.close();
  await rm(ws, { recursive: true, force: true, maxRetries: 5 });
});

async function client(): Promise<{ conn: MessageConnection; deck: () => DeckState; events: KiraEvent[]; closed: Promise<void> }> {
  const socket = connect(pipe);
  await new Promise<void>((r, j) => socket.once("connect", r).once("error", j));
  const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
  let deck = emptyDeck();
  const events: KiraEvent[] = [];
  conn.onNotification(Methods.event, (n: EventNotification) => {
    events.push(n.event);
    deck = reduceDeck(deck, n.event);
  });
  conn.listen();
  const closed = new Promise<void>((r) => socket.once("close", () => r()));
  return { conn, deck: () => deck, events, closed };
}

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("daemon security", () => {
  it("refuses every call before hello, and drops a client with a bad token", async () => {
    const c = await client();
    await expect(c.conn.sendRequest(Methods.snapshot, {})).rejects.toThrow(/unauthorized/);
    await expect(c.conn.sendRequest(Methods.hello, { token: "wrong", client: "test" })).rejects.toThrow(/unauthorized/);
    await c.closed;
  });

  it("agent commands never see API keys or the session token", async () => {
    process.env.FAKE_PROVIDER_API_KEY = "sk-must-not-leak";
    try {
      const cmd = process.platform === "win32" ? "echo [%FAKE_PROVIDER_API_KEY%]" : 'echo "[$FAKE_PROVIDER_API_KEY]"';
      const r = await runInPty(cmd, { cwd: ws, signal: new AbortController().signal });
      expect(r.output).not.toContain("sk-must-not-leak");
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
    }
  }, 20_000);
});

describe("Phase 2 exit test: a full run is legible from the Flight Deck state alone", () => {
  it("streams plan, steps, terminal, approvals, diff, verification and report; approvals round-trip over RPC", async () => {
    executor = scripted([
      {
        text: "I'll lay out the plan, then write the greeting module.",
        calls: [
          { name: "update_plan", args: { steps: [{ title: "Write the greeting module", status: "active" }, { title: "Install left-pad", status: "pending" }, { title: "Verify and finish", status: "pending" }] } },
          { name: "write_file", args: { path: "src/greet.js", content: "export const greet = (n) => `hello ${n}`;\n" } },
        ],
      },
      { text: "Adding left-pad for alignment.", calls: [{ name: "run_command", args: { command: "npm install left-pad" } }] },
      {
        text: "Checking the module loads.",
        calls: [
          { name: "update_plan", args: { steps: [{ title: "Write the greeting module", status: "done" }, { title: "Install left-pad", status: "skipped" }, { title: "Verify and finish", status: "active" }] } },
          { name: "run_command", args: { command: `${NODE} -e "console.log('greet ok')"` } },
        ],
      },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "Greeting module written and loads; left-pad was declined so padding is hand-written." } }] },
    ]);

    const c = await client();
    const hello = (await c.conn.sendRequest(Methods.hello, { token: TOKEN, client: "test" })) as HelloResult;
    expect(hello.workspace).toBe(ws);
    const { runId } = (await c.conn.sendRequest(Methods.start, { goal: "Add a greeting module" })) as StartResult;

    // The human answers the dependency gate from the panel, with a reason.
    await until(() => pendingApprovals(c.deck()).length > 0);
    const ap = pendingApprovals(c.deck())[0]!;
    expect(ap.request).toMatchObject({ category: "dependency-install", summary: "npm install left-pad" });
    expect(c.deck().run?.state).toBe("AWAITING_APPROVAL");
    await c.conn.sendRequest(Methods.approve, { id: ap.id, allow: false, note: "No new dependencies for padding; write it by hand." });

    await until(() => !!c.deck().report);
    const d = c.deck();
    if (process.env.KIRA_DUMP_DECK) writeFileSync(process.env.KIRA_DUMP_DECK, JSON.stringify(c.events, null, 1));

    // What was asked, and where it ended.
    expect(d.run).toMatchObject({ runId, goal: "Add a greeting module", state: "IDLE" });
    expect(d.report).toMatchObject({ status: "done", runId });
    expect(d.report!.summary).toMatch(/1 open concern/);
    // The plan tree, kept current by the executor.
    expect(d.plan.map((p) => `${p.status}:${p.title}`)).toEqual(["done:Write the greeting module", "skipped:Install left-pad", "active:Verify and finish"]);
    expect(d.scope).toEqual(["src/"]);
    // Every step with its narration, model, calls and results.
    expect(d.steps.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    expect(d.steps[0]!.narration[0]).toMatch(/lay out the plan/);
    expect(d.steps[0]!.model).toBe("mistral/fake-exec");
    expect(d.steps[1]!.calls[0]).toMatchObject({ name: "run_command", isError: true });
    expect(d.steps[1]!.calls[0]!.result).toMatch(/declined/);
    expect(d.steps.every((s) => s.calls.every((call) => call.result !== undefined))).toBe(true);
    // The terminal mirror saw the command and its output.
    expect(d.terminal).toContain("greet ok");
    // The approval and the decision behind it.
    expect(d.approvals).toEqual([expect.objectContaining({ id: ap.id, resolved: { allow: false, note: "No new dependencies for padding; write it by hand." } })]);
    expect(d.decisions[0]).toMatchObject({ allow: false, note: "No new dependencies for padding; write it by hand." });
    // Live diff of the run so far.
    expect(d.diff?.files).toEqual([{ status: "A", path: "src/greet.js" }]);
    expect(d.diff?.patch).toContain("+export const greet");
    // Verification ladder and cost.
    expect(d.verification?.gates.map((g) => `${g.level}:${g.status}`)).toEqual(["L0:pass", "L4:skip", "L5:pass"]);
    expect(d.budget?.costUsd).toBeGreaterThan(0);
    // State transitions the panel showed, in order.
    const states = c.events.flatMap((e) => (e.type === "state" ? [e.state] : []));
    expect(states).toEqual(["PLANNING", "EXECUTING", "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "REPORTING", "IDLE"]);

    // A panel that opens afterwards gets the same picture from the snapshot.
    const late = await client();
    const h2 = (await late.conn.sendRequest(Methods.hello, { token: TOKEN, client: "late" })) as HelloResult;
    expect(h2.deck.report?.status).toBe("done");
    expect(h2.deck.steps).toHaveLength(4);

    // The declined dependency became a decision record, pending one-click review.
    const pending = (await c.conn.sendRequest(Methods.memoryList, { kind: "adr", review: "pending" })) as { id: number; title: string }[];
    expect(pending[0]?.title).toMatch(/No new dependencies for padding/);
    await c.conn.sendRequest(Methods.memoryReject, { id: pending[0]!.id });
    expect(await c.conn.sendRequest(Methods.memoryList, { kind: "adr", review: "pending" })).toEqual([]);
    const left = (await c.conn.sendRequest(Methods.leftOff, {})) as { text: string };
    expect(left.text).toMatch(/Add a greeting module/);
  }, 60_000);

  it("stop over RPC interrupts a run mid-command and the panel shows INTERRUPTED then IDLE", async () => {
    executor = scripted([{ calls: [{ name: "run_command", args: { command: `${NODE} -e "setInterval(()=>{},1000)"` } }] }]);
    const c = await client();
    await c.conn.sendRequest(Methods.hello, { token: TOKEN, client: "test" });
    await c.conn.sendRequest(Methods.start, { goal: "hang forever", plan: false, verify: false });
    await expect(c.conn.sendRequest(Methods.start, { goal: "second" })).rejects.toThrow(/already in progress/);
    await until(() => c.deck().terminal.includes("setInterval"));
    const t0 = Date.now();
    expect(await c.conn.sendRequest(Methods.stop, {})).toEqual({ stopped: true });
    expect(Date.now() - t0).toBeLessThan(process.env.CI ? 30_000 : 10_000);
    await until(() => !!c.deck().report);
    expect(c.deck().report?.status).toBe("aborted");
    const states = c.events.flatMap((e) => (e.type === "state" ? [e.state] : []));
    expect(states.slice(-3)).toEqual(["INTERRUPTED", "REPORTING", "IDLE"]);
    expect(daemon.running).toBe(false);
  }, 60_000);
});
