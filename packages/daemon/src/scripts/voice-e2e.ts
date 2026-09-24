/**
 * The whole voice loop, end to end, with no microphone: the real Python
 * sidecar (VAD, local Whisper wake, Voxtral STT and TTS), the real daemon,
 * real models and a real run in a scratch git repo. "The human" is a second
 * Voxtral voice injected where the microphone would be (--source inject).
 * Kira's replies play through the speakers.
 *
 *   npm run voice-e2e            (needs MISTRAL_API_KEY; takes a few minutes)
 */
import { config as loadEnv } from "dotenv";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findConfig, loadModelsConfig } from "../config/models.js";
import { KiraDaemon } from "../daemon/server.js";
import { openMemory } from "../memory/run-memory.js";
import { ProviderRegistry } from "../providers/registry.js";
import { createVerifier } from "../verify/ladder.js";
import type { VoiceEvent } from "../voice/bridge.js";

const configPath = findConfig();
loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });
const config = loadModelsConfig(configPath);
const registry = new ProviderRegistry(config);
const key = process.env.MISTRAL_API_KEY?.trim();
if (!key) {
  console.error("needs MISTRAL_API_KEY in .env");
  process.exit(2);
}

const ws = mkdtempSync(join(tmpdir(), "kira-voice-e2e-"));
execFileSync("git", ["init", "-q"], { cwd: ws });
console.log(`workspace: ${ws}`);

// ---- what happened, in order ---------------------------------------------------------
type Line = { at: number; kind: "heard" | "said" | "event" | "speaking-end"; text: string };
const lines: Line[] = [];
const t0 = Date.now();
const note = (kind: Line["kind"], text: string) => {
  lines.push({ at: Date.now(), kind, text });
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  if (kind !== "speaking-end") console.log(`${s}s  ${kind.padEnd(6)} ${text}`);
};

const memory = await openMemory(ws, registry, config);
const daemon = new KiraDaemon({
  workspace: ws,
  pipe: "",
  token: "",
  chatFor: (role) => (req, signal, onFallback) => registry.chat(role, req, signal, onFallback),
  pricing: config.pricing,
  verifier: () => createVerifier({ workspace: ws, registry }),
  memory,
  defaults: { autonomy: 3, maxCostUsd: 1 },
  log: (l) => {
    if (l.startsWith("kira says: ")) note("said", l.slice(11));
    else if (l.startsWith("heard: ")) note("heard", l.slice(7));
  },
  voice: {
    mistralApiKey: key,
    args: ["--source", "inject"],
    onVoiceEvent: (e: VoiceEvent) => {
      if (e.type === "speaking" && e.state === "end") note("speaking-end", e.id);
      if (e.type === "latency") note("event", `${e.kind} ${e.ms} ms`);
    },
  },
});
daemon.onEvent((e) => {
  if (e.type === "run_started") note("event", `run started: ${e.goal}`);
  if (e.type === "approval") note("event", `approval asked: ${e.request.category}: ${e.request.summary.slice(0, 80)}`);
  if (e.type === "report") note("event", `run ended ${e.report.status}: ${e.report.summary.split("\n")[0]!.slice(0, 160)}`);
});

// ---- helpers ------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, get: () => T | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const since = (at: number, kind: Line["kind"]) => lines.find((l) => l.at >= at && l.kind === kind);
/** Speak as the human; wait until Kira has heard it. */
async function human(text: string): Promise<number> {
  const at = Date.now();
  note("event", `human says: "${text}"`);
  daemon.voiceHear(text);
  await until(`Kira to hear "${text}"`, () => since(at, "heard"), 45_000);
  return at;
}
/** Wait until Kira has said something after `at` and finished speaking it. */
async function reply(at: number, ms = 60_000): Promise<string> {
  const said = await until("a spoken reply", () => since(at, "said"), ms);
  await until("the reply to finish playing", () => since(said.at, "speaking-end"), 60_000);
  await sleep(400);
  return said.text;
}
const results: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const report = () => daemon.deckState().report;

// ---- the session --------------------------------------------------------------------
const st = await daemon.voiceStart();
note("event", `voice ready: wake ${st.wake}, voice ${st.voice}`);

await check("a question gets a spoken answer, not a coding run", async () => {
  const at = await human("Kira, are you listening to me?");
  const r = await reply(at);
  expect(!daemon.deckState().run, "a run was started for a question");
  return r;
});

await check("a follow-up needs no wake word", async () => {
  const at = await human("What kinds of things can you build?");
  const r = await reply(at);
  expect(!daemon.deckState().run, "a run was started for a question");
  return r;
});

await check("a spoken task runs, is verified, and the result is spoken", async () => {
  const at = await human("Kira, create a file named hello.txt that contains the text hello world.");
  await until("the run to start", () => daemon.deckState().run, 60_000);
  const r = await until("the run's report", report, 6 * 60_000);
  const done = await reply(at, 30_000).catch(() => "");
  const file = join(ws, "hello.txt");
  expect(existsSync(file), `hello.txt was not created (run ${r.status}: ${r.summary.slice(0, 200)})`);
  expect(/hello,? world/i.test(readFileSync(file, "utf8")), "hello.txt does not say hello world");
  expect(r.status === "done", `run ended ${r.status}: ${r.summary.slice(0, 200)}`);
  return `${r.status}; spoken: ${done}`;
});

await check("after the result, a follow-up needs no wake word", async () => {
  const at = await human("Thanks. What did you just do?");
  return reply(at);
});

await check("status and where-we-left-off answer out loud", async () => {
  const a = await human("Kira, status.");
  const s = await reply(a);
  const b = await human("Kira, where did we leave off?");
  const l = await reply(b, 90_000);
  return `${s} | ${l}`;
});

await check("an approval is answered by a plain spoken no", async () => {
  const before = daemon.deckState().run?.runId;
  const at = await human("Kira, install the left-pad package with npm.");
  await until("the run to start", () => daemon.deckState().run?.runId !== before && daemon.deckState().run, 60_000);
  const asked = await until(
    "an approval or the end of the run",
    () => lines.find((l) => l.at >= at && l.kind === "event" && /^approval asked|^run ended/.test(l.text)),
    4 * 60_000,
  );
  expect(asked.text.startsWith("approval asked"), `no approval was asked: ${asked.text}`);
  await until("the question to finish playing", () => since(asked.at, "speaking-end"), 60_000);
  await sleep(400);
  await human("No.");
  await until("the run to end", () => report()?.runId === daemon.deckState().run?.runId && report(), 4 * 60_000);
  const d = daemon.deckState().decisions.at(-1);
  expect(d && !d.allow, "the decision was not recorded as denied");
  expect(!existsSync(join(ws, "node_modules", "left-pad")), "left-pad was installed anyway");
  return `denied: ${d.category}; run ${report()!.status}`;
});

await check("a spoken stop interrupts a run", async () => {
  const before = daemon.deckState().run?.runId;
  await human("Kira, write a node script called count.js that prints the numbers one to one hundred, with a test.");
  await until("the run to start", () => daemon.deckState().run?.runId !== before && daemon.deckState().run, 60_000);
  await sleep(4000);
  const at = Date.now();
  note("event", 'human says: "Stop."');
  daemon.voiceHear("Stop.");
  const r = await until("the run to stop", () => report()?.runId === daemon.deckState().run?.runId && report(), 60_000);
  expect(r.status === "aborted", `run ended ${r.status}, not aborted`);
  return `aborted ${((Date.now() - at) / 1000).toFixed(1)} s after "stop" was queued`;
});

// ---- result -------------------------------------------------------------------------
const vs = daemon.voiceStatus();
await daemon.close();
console.log("\n==== voice end-to-end ====");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
console.log(`ack p50: ${vs.ackP50Ms} ms over ${vs.samples}`);
console.log(`workspace kept for inspection: ${ws}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
