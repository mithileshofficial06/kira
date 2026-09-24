/**
 * Phase 5, daemon side: what Kira does with what it hears, and what it says.
 * A scripted fake sidecar stands in for the Python one (whose audio pipeline
 * has its own tests in packages/voice).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatFn } from "../src/agent/loop.js";
import { emptyDeck, reduceDeck } from "../src/daemon/deck.js";
import { KiraDaemon } from "../src/daemon/server.js";
import { newToolCallId } from "../src/providers/tool-calls.js";
import { FALLBACK_REPLY, parse } from "../src/voice/converse.js";
import { classify } from "../src/voice/intents.js";
import { narrate, statusLine } from "../src/voice/narrator.js";

const FAKE = join(__dirname, "fixtures", "fake-voice.cjs");
const NODE = `"${process.execPath}"`;

describe("classify", () => {
  const idle = { running: false, pendingApproval: false };
  it.each([
    ["build a login system with session cookies", { kind: "task", goal: "build a login system with session cookies" }],
    ["Where did we leave off?", { kind: "left_off" }],
    ["stop!", { kind: "stop" }],
    ["status", { kind: "status" }],
  ])("%s", (text, intent) => expect(classify(text, idle)).toEqual(intent));

  it("answers approvals only when one is pending, keeping the reason", () => {
    const asking = { running: true, pendingApproval: true };
    expect(classify("yes, go ahead", asking)).toEqual({ kind: "approve", allow: true });
    expect(classify("No, write it by hand.", asking)).toEqual({ kind: "approve", allow: false, note: "write it by hand." });
    expect(classify("yes", { running: true, pendingApproval: false })).toEqual({ kind: "chat", text: "yes" });
  });

  it("takes a sound-alike of a lone yes or no as the answer, but only while an approval waits", () => {
    const asking = { running: true, pendingApproval: true };
    expect(classify("know.", asking)).toEqual({ kind: "approve", allow: false });
    expect(classify("Yea", asking)).toEqual({ kind: "approve", allow: true });
    expect(classify("know.", { running: true, pendingApproval: false }).kind).toBe("chat");
  });

  it("does not start a second task over a running one", () => {
    expect(classify("add dark mode", { running: true, pendingApproval: false }).kind).toBe("busy");
  });

  it("sends questions and remarks to conversation, not to a coding run", () => {
    for (const t of ["are you listening to me?", "what can you do", "I need a login page", "hello", "testing one two three"]) {
      expect(classify(t, idle), t).toEqual({ kind: "chat", text: t });
    }
    for (const t of ["can you please add tests for the parser", "Please fix the build", "let's refactor the router", "I want you to write a README"]) {
      expect(classify(t, idle).kind, t).toBe("task");
    }
  });
});

describe("conversation replies", () => {
  it("turns a TASK: line into a goal and strips markdown from spoken answers", () => {
    expect(parse("TASK: Build a login page with email and password.")).toEqual({ task: "Build a login page with email and password" });
    expect(parse("**Yes**, I'm listening.\nWhat should we build?")).toEqual({ reply: "Yes, I'm listening. What should we build?" });
    expect(parse("")).toEqual({ reply: FALLBACK_REPLY });
  });
});

describe("narrate", () => {
  it("speaks approvals, endings and long pauses, and nothing else", () => {
    const d = emptyDeck();
    expect(narrate({ type: "approval", id: "a", request: { tool: "run_command", summary: 'npm install left-pad --save "C:\\x\\y"', category: "dependency-install" } }, d)).toBe(
      "I need your OK to dependency install: npm install left-pad a file. Say yes or no.",
    );
    expect(narrate({ type: "state", state: "RATE_LIMITED", resumeAt: 60_000 }, d, 0)).toMatch(/Pausing for about 60 seconds/);
    expect(narrate({ type: "state", state: "RATE_LIMITED", resumeAt: 5_000 }, d, 0)).toBeUndefined();
    expect(narrate({ type: "state", state: "EXECUTING" }, d)).toBeUndefined();
  });

  it("reads a step-mode approval as a short question", () => {
    const summary = "Step 9 finished: The directory 'app' was created. I will now install the packages.. Continue?";
    expect(narrate({ type: "approval", id: "a", request: { tool: "step", summary, category: "step" } }, emptyDeck())).toBe(
      "Step 9 is done. The directory 'app' was created. Shall I continue? Say yes or no.",
    );
  });

  it("gives a status line from the Flight Deck state", () => {
    let d = reduceDeck(emptyDeck(), { type: "run_started", runId: "r", goal: "g", workspace: "w", autonomy: 3, at: "" });
    d = reduceDeck(d, { type: "state", state: "EXECUTING" });
    d = reduceDeck(d, { type: "plan", steps: [{ title: "a", status: "done" }, { title: "write tests", status: "active" }, { title: "c", status: "pending" }] });
    expect(statusLine(d)).toBe("I'm executing. 1 of 3 plan steps done; now: write tests.");
    expect(statusLine(emptyDeck())).toBe("Nothing is running.");
  });
});

// ---- end to end: fake sidecar + real daemon ---------------------------------------
let ws: string;
let daemon: KiraDaemon | undefined;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kira-voice-"));
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(ws, { recursive: true, force: true, maxRetries: 5 });
});

function scripted(turns: { calls: { name: string; args: unknown }[] }[]): ChatFn {
  let i = 0;
  return async function* () {
    const t = turns[Math.min(i++, turns.length - 1)]!;
    yield { type: "model" as const, model: { provider: "mistral" as const, model: "m" } };
    for (const c of t.calls) yield { type: "tool_call" as const, call: { id: newToolCallId(), name: c.name, arguments: JSON.stringify(c.args) } };
    yield { type: "done" as const, finishReason: "tool_calls" };
  };
}

/** A utility model that answers each conversation turn with the next line. */
function talker(lines: string[]): ChatFn & { asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  const fn = async function* (req: { messages: { role: string; content: unknown }[] }) {
    asked.push(String(req.messages.at(-1)!.content));
    yield { type: "text" as const, delta: lines[Math.min(i++, lines.length - 1)]! };
    yield { type: "done" as const, finishReason: "stop" };
  };
  return Object.assign(fn, { asked }) as ChatFn & { asked: string[] };
}

async function withVoice(executor: ChatFn, hear: unknown[], utility?: ChatFn) {
  const logFile = join(ws, "..", `${ws.split(/[\\/]/).pop()}-said.log`);
  process.env.KIRA_FAKE_HEAR = JSON.stringify(hear);
  process.env.KIRA_FAKE_LOG = logFile;
  daemon = new KiraDaemon({
    workspace: ws,
    pipe: "",
    token: "",
    initGit: true,
    chatFor: (role) => (role === "utility" && utility ? utility : executor),
    defaults: { plan: false, verify: false },
    voice: { mistralApiKey: "test", command: { file: process.execPath, args: [FAKE] } },
  });
  await daemon.voiceStart();
  const said = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; text?: string }) : []);
  return { said };
}

async function until(cond: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("voice end to end (fake sidecar, real daemon)", () => {
  it("a spoken task runs; a gated install is asked aloud and declined by voice with a reason; the result is spoken", async () => {
    const executor = scripted([
      { calls: [{ name: "write_file", args: { path: "greet.js", content: "module.exports = (n) => `hi ${n}`;\n" } }] },
      { calls: [{ name: "run_command", args: { command: "npm install left-pad" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "Greeting written by hand. No new dependencies." } }] },
    ]);
    const { said } = await withVoice(executor, [
      { after: 50, event: { type: "utterance", text: "add a greeting module", heard: "Kira add a greeting module", source: "voxtral", endOfSpeechAt: 0 } },
      { whenSaid: "I need your OK", after: 50, event: { type: "utterance", text: "No, write it by hand.", heard: "no write it by hand", source: "voxtral", endOfSpeechAt: 0 } },
    ]);
    await until(() => !!daemon!.deckState().report);
    const deck = daemon!.deckState();
    expect(deck.run?.goal).toBe("add a greeting module"); // written echo of what was heard
    expect(deck.report?.status).toBe("done");
    expect(deck.decisions[0]).toMatchObject({ allow: false, category: "dependency-install", note: "write it by hand. (said by voice)" });
    await until(() => said().some((c) => c.text?.startsWith("Done.")));
    const lines = said().filter((c) => c.type === "say").map((c) => c.text);
    expect(lines).toEqual([
      "I need your OK to dependency install: npm install left-pad. Say yes or no.",
      "Okay, I won't.",
      "Done. Greeting written by hand.",
    ]);
    // The sidecar was told when a run started and ended (a bare "stop" only counts during a run).
    const states = said().filter((c) => c.type === "state").map((c) => (c as { running?: boolean }).running);
    expect(states).toContain(true);
    expect(states.at(-1)).toBe(false);
  }, 60_000);

  it("a spoken stop interrupts a running command and Kira says it rolled back", async () => {
    const executor = scripted([
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] },
      { calls: [{ name: "run_command", args: { command: `${NODE} -e "setInterval(()=>{},1000)"` } }] },
    ]);
    const { said } = await withVoice(executor, [
      { after: 50, event: { type: "utterance", text: "install the dependencies", heard: "Kira install the dependencies", source: "voxtral", endOfSpeechAt: 0 } },
      { after: 2500, event: { type: "stop", heard: "stop", endOfSpeechAt: 0 } },
    ]);
    await until(() => !!daemon!.deckState().report);
    expect(daemon!.deckState().report?.status).toBe("aborted");
    await until(() => said().some((c) => c.text?.startsWith("Stopped.")));
    expect(said().find((c) => c.text?.startsWith("Stopped."))?.text).toMatch(/Stopped\. (I rolled back step \d+, and n|N)othing is left running\./);
  }, 60_000);
});

describe("voice conversation (fake sidecar, real daemon)", () => {
  it("answers a question out loud without starting a run, and keeps listening for the answer", async () => {
    const utility = talker(["Yes, I'm listening. What should we build?"]);
    const { said } = await withVoice(scripted([]), [
      { after: 50, event: { type: "utterance", text: "are you listening to me?", heard: "Kira are you listening to me", source: "voxtral", endOfSpeechAt: 0 } },
    ], utility);
    await until(() => said().some((c) => c.type === "say"));
    const reply = said().find((c) => c.type === "say") as { text: string; listen?: boolean };
    expect(reply).toMatchObject({ text: "Yes, I'm listening. What should we build?", listen: true });
    expect(utility.asked).toEqual(["are you listening to me?"]);
    expect(daemon!.deckState().run).toBeUndefined(); // no coding run for a question
  }, 30_000);

  it("turns work asked for in other words into a run, and an approval keeps the mic open for yes or no", async () => {
    const utility = talker(["TASK: Create greet.js that exports a greeting function"]);
    const executor = scripted([
      { calls: [{ name: "write_file", args: { path: "greet.js", content: "module.exports = () => 'hi';\n" } }] },
      { calls: [{ name: "run_command", args: { command: "npm install left-pad" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "Greeting module written." } }] },
    ]);
    const { said } = await withVoice(executor, [
      { after: 50, event: { type: "utterance", text: "I need a greeting module", heard: "Kira I need a greeting module", source: "voxtral", endOfSpeechAt: 0 } },
      { whenSaid: "I need your OK", after: 50, event: { type: "utterance", text: "no", heard: "no", source: "voxtral", endOfSpeechAt: 0 } },
    ], utility);
    await until(() => !!daemon!.deckState().report);
    expect(daemon!.deckState().run?.goal).toBe("Create greet.js that exports a greeting function");
    await until(() => said().some((c) => c.text?.startsWith("Done.")));
    const says = said().filter((c) => c.type === "say") as { text: string; listen?: boolean }[];
    expect(says[0]!.text).toBe("On it: Create greet.js that exports a greeting function.");
    expect(says.find((s) => s.text.startsWith("I need your OK"))?.listen).toBe(true);
    expect(says.find((s) => s.text.startsWith("Done."))?.listen).toBe(true);
    const awaiting = said().filter((c) => c.type === "state").map((c) => (c as { awaiting?: boolean }).awaiting);
    expect(awaiting).toContain(true);
    expect(awaiting.at(-1)).toBe(false);
  }, 60_000);
});

describe("voice in the VS Code assistant (fake sidecar, real daemon, real pipe)", () => {
  it("a connected client sees what was heard and said, and a typed message is answered like speech", async () => {
    const { createMessageConnection, SocketMessageReader, SocketMessageWriter } = await import("vscode-jsonrpc/node");
    const { connect } = await import("node:net");
    const { pipeName } = await import("../src/daemon/server.js");
    const { Methods } = await import("../src/daemon/protocol.js");
    const logFile = join(ws, "..", `${basename(ws)}-ui.log`);
    process.env.KIRA_FAKE_HEAR = JSON.stringify([
      { after: 800, event: { type: "utterance", text: "how are you?", heard: "Kira how are you", source: "voxtral", endOfSpeechAt: 0 } },
    ]);
    process.env.KIRA_FAKE_LOG = logFile;
    const pipe = pipeName(ws);
    const utility = talker(["I'm good. What are we building?", "Nothing is running right now."]);
    daemon = new KiraDaemon({
      workspace: ws,
      pipe,
      token: "tok",
      chatFor: (role) => (role === "utility" ? utility : scripted([])),
      defaults: { plan: false, verify: false },
      voice: { mistralApiKey: "test", command: { file: process.execPath, args: [FAKE] } },
    });
    await daemon.listen();
    const socket = connect(pipe);
    await new Promise<void>((r) => socket.once("connect", r));
    const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    const seen: { type: string; text?: string }[] = [];
    conn.onNotification(Methods.voiceEvent, (e: { type: string; text?: string }) => void seen.push(e));
    conn.listen();
    try {
      await conn.sendRequest(Methods.hello, { token: "tok", client: "test" });
      await conn.sendRequest(Methods.voiceStart);
      await until(() => seen.some((e) => e.type === "say"));
      expect(seen.filter((e) => e.type !== "log").map((e) => `${e.type}:${e.text ?? ""}`)).toEqual(["ready:", "utterance:how are you?", "say:I'm good. What are we building?"]);

      await conn.sendRequest(Methods.voiceAsk, { text: "anything running?" });
      await until(() => seen.filter((e) => e.type === "say").length === 2);
      expect(seen.slice(-2).map((e) => `${e.type}:${e.text}`)).toEqual(["typed:anything running?", "say:Nothing is running right now."]);
      expect(daemon.deckState().run).toBeUndefined();

      // The sidecar was asked for levels (there is a UI) and given the project's words.
      const cmds = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; on?: boolean; words?: string[] });
      expect(cmds.find((c) => c.type === "meter")?.on).toBe(true);
      expect(Array.isArray(cmds.find((c) => c.type === "vocab")?.words)).toBe(true);
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 30_000);
});
