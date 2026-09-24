/**
 * Phase 4 exit tests (spec §10):
 *  1. A session started 3 days later recalls an unstated constraint from the earlier session.
 *  2. ≥90% on a 20-question recall probe set.
 * Plus the stores, re-embedding, rerank degradation, lessons and ADR gating.
 */
import { config as loadEnv } from "dotenv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatFn } from "../src/agent/loop.js";
import type { KiraEvent, RunReport } from "../src/control/events.js";
import { runSession } from "../src/control/runner.js";
import { findConfig, loadModelsConfig } from "../src/config/models.js";
import { HashEmbedder } from "../src/memory/embed.js";
import { commandSignature, deterministicAdrs, extractAdrs, learnLessons } from "../src/memory/extract.js";
import { loadProbe, runProbe, seedProbe } from "../src/memory/probe.js";
import type { Reranker } from "../src/memory/rerank.js";
import { KiraMemory, memoryFile, openMemory } from "../src/memory/run-memory.js";
import { MemoryStore } from "../src/memory/store.js";
import { RateLimitedError } from "../src/providers/errors.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { newToolCallId } from "../src/providers/tool-calls.js";
import type { ChatMessage } from "../src/providers/types.js";

const PROBE = join(__dirname, "fixtures", "recall-probe.json");
const DAY = 86_400_000;

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kira-mem-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 5 });
});

/** A settable clock shared by memory and the test. */
function clock(start: Date) {
  let t = start;
  return { now: () => t, set: (d: Date) => (t = d), advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
}

function scripted(turns: { calls?: { name: string; args: unknown }[]; text?: string }[]): ChatFn & { seen: ChatMessage[][] } {
  let i = 0;
  const seen: ChatMessage[][] = [];
  const fn = async function* (req: { messages: ChatMessage[] }) {
    seen.push(structuredClone(req.messages));
    const t = turns[Math.min(i++, turns.length - 1)]!;
    yield { type: "model" as const, model: { provider: "mistral" as const, model: "m" } };
    if (t.text) yield { type: "text" as const, delta: t.text };
    for (const c of t.calls ?? []) yield { type: "tool_call" as const, call: { id: newToolCallId(), name: c.name, arguments: JSON.stringify(c.args) } };
    yield { type: "done" as const, finishReason: "stop" };
  };
  return Object.assign(fn, { seen });
}

describe("MemoryStore", () => {
  it("stores, searches, rejects and supersedes", async () => {
    const s = new MemoryStore(":memory:", { textEmbedder: new HashEmbedder() });
    const a = await s.addAdr({ title: "Use Postgres for the ledger", decision: "Postgres", context: "locking", decidedBy: "user" });
    await s.add({ kind: "fact", title: "Staging is on Fly.io", body: "deploys from main" });
    expect((await s.search("which database for the ledger"))[0]!.item.id).toBe(a.id);
    const b = await s.addAdr({ title: "Use SQLite for the ledger after all", decision: "SQLite", context: "single user", decidedBy: "user", supersedes: a.id });
    expect(s.get(a.id)!.status).toBe("superseded");
    const hits = await s.search("ledger database");
    expect(hits.map((h) => h.item.id)).toContain(b.id);
    expect(hits.map((h) => h.item.id)).not.toContain(a.id);
    s.reject(b.id);
    expect((await s.search("ledger database")).map((h) => h.item.id)).not.toContain(b.id);
    expect(MemoryStore.adrId(a)).toBe("ADR-001");
    s.close();
  });

  it("re-embeds with a new model instead of mixing vector spaces", async () => {
    const file = memoryFile(ws);
    const s1 = new MemoryStore(file, { textEmbedder: new HashEmbedder(384) });
    await s1.add({ kind: "fact", title: "one", body: "alpha" });
    await s1.add({ kind: "fact", title: "two", body: "beta" });
    s1.close();
    const s2 = new MemoryStore(file, { textEmbedder: new HashEmbedder(256) });
    expect(await s2.reembedMissing()).toBe(2);
    const models = s2.db.prepare("SELECT DISTINCT model, dim FROM embeddings").all();
    expect(models).toEqual([{ model: "local/hash-256", dim: 256 }]);
    s2.close();
  });

  it("uses the reranker's order, and degrades to fused retrieval when it is throttled", async () => {
    const reverse: Reranker = { model: "r", rerank: async (_q, p) => p.map((_, i) => p.length - 1 - i) };
    const throttled: Reranker = {
      model: "r",
      rerank: async () => {
        throw new RateLimitedError("nim", 1000, "429");
      },
    };
    const make = (reranker: Reranker) => new MemoryStore(":memory:", { textEmbedder: new HashEmbedder(), reranker });
    const a = make(reverse);
    await a.add({ kind: "fact", title: "ledger ledger ledger", body: "ledger" });
    await a.add({ kind: "fact", title: "ledger notes", body: "misc" });
    const plain = make(throttled);
    await plain.add({ kind: "fact", title: "ledger ledger ledger", body: "ledger" });
    await plain.add({ kind: "fact", title: "ledger notes", body: "misc" });
    const fused = await plain.search("ledger");
    expect(fused).toHaveLength(2);
    expect(plain.lastRerankError).toMatch(/429/);
    const reranked = await a.search("ledger");
    expect(reranked.map((h) => h.item.title)).toEqual([...fused.map((h) => h.item.title)].reverse());
    expect(a.db.prepare("SELECT reranked FROM retrieval_log").all()).toEqual([{ reranked: 1 }]);
  });

  it("keeps memory context within the token budget, preferences first", async () => {
    const s = new MemoryStore(":memory:", { textEmbedder: new HashEmbedder(), contextTokens: 100 });
    await s.add({ kind: "preference", title: "Named exports only", body: "Named exports only" });
    for (let i = 0; i < 20; i++) await s.add({ kind: "fact", title: `ledger fact ${i}`, body: "ledger ".repeat(30) });
    const { text, items } = await s.contextFor("ledger");
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text.split("\n")[0]).toMatch(/\[preference\] Named exports only/);
    expect(items.length).toBeLessThan(21);
  });
});

describe("procedural lessons", () => {
  it("derives signatures", () => {
    expect(commandSignature("npm ci --fetch-retries 5")).toBe("npm ci");
    expect(commandSignature('"C:\\Program Files\\nodejs\\npm.cmd" install -D vitest')).toBe("npm install");
    expect(commandSignature("git push origin main")).toBe("git push");
    expect(commandSignature("npx vite --port 3000")).toBe("npx vite");
    expect(commandSignature("node index.js")).toBe("node");
  });

  it("learns fail-then-fix pairs and offers them before the next matching call", async () => {
    const call = (id: string, command: string) => ({ id, name: "run_command", arguments: JSON.stringify({ command }) });
    const transcript: ChatMessage[] = [
      { role: "assistant", content: null, toolCalls: [call("1", "npm ci")] },
      { role: "tool", toolCallId: "1", content: "exit code 1\nnpm ERR! network ETIMEDOUT behind proxy" },
      { role: "assistant", content: null, toolCalls: [call("2", "npm ci --fetch-retries 5")] },
      { role: "tool", toolCallId: "2", content: "exit code 0\nadded 200 packages" },
    ];
    const lessons = learnLessons(transcript);
    expect(lessons).toEqual([{ signature: "npm ci", failed: "npm ci", ok: "npm ci --fetch-retries 5", error: "npm ERR! network ETIMEDOUT behind proxy" }]);

    const mem = new KiraMemory(memoryFile(ws));
    await mem.recordRun(fakeReport(), transcript, new AbortController().signal);
    const note = mem.hooks().toolNote("run_command", { command: "npm ci" });
    expect(note).toMatch(/npm ci --fetch-retries 5/);
    expect(mem.hooks().toolNote("run_command", { command: "npm test" })).toBeUndefined();
    mem.close();
  });
});

function fakeReport(over: Partial<RunReport> = {}): RunReport {
  return {
    runId: "r1",
    goal: "goal",
    status: "done",
    summary: "summary",
    steps: 3,
    durationMs: 1,
    models: [],
    fallbacks: 0,
    rateLimitPauses: 0,
    budget: { steps: 3, tokens: 0, costUsd: 0, limits: { maxSteps: 40, maxTokens: 1, maxCostUsd: 1 }, used: 0, unpriced: [] },
    malformedCalls: 0,
    autonomy: { start: 3, end: 3, downgrades: [] },
    decisions: [],
    sideEffects: [],
    openQuestions: [],
    ...over,
  };
}

describe("gated ADR extraction", () => {
  const declined = { tool: "run_command", summary: "npm install react-dropzone", category: "dependency-install" as const, allow: false, note: "No. Write the drop zone by hand.", at: "" };

  it("writes nothing when no trigger fired", async () => {
    expect(await extractAdrs(fakeReport(), [], undefined, new AbortController().signal)).toEqual([]);
    // An approval without a note is routine, not a decision worth journaling.
    expect(deterministicAdrs(fakeReport({ decisions: [{ ...declined, allow: true, note: undefined }] }))).toEqual([]);
  });

  it("records a human decision in the human's words, pending review", async () => {
    const adrs = await extractAdrs(fakeReport({ decisions: [declined] }), [], undefined, new AbortController().signal);
    expect(adrs).toHaveLength(1);
    expect(adrs[0]).toMatchObject({ title: "No. Write the drop zone by hand", decidedBy: "user", review: "pending" });
    expect(adrs[0]!.decision).toContain("Write the drop zone by hand");
  });

  it("uses the utility model when available and falls back when its reply is junk", async () => {
    const good = scripted([{ text: '{"adrs":[{"title":"Drop zone is hand-written","decision":"No react-dropzone","context":"size","decidedBy":"user"}]}' }]);
    const adrs = await extractAdrs(fakeReport({ decisions: [declined] }), [], good, new AbortController().signal);
    expect(adrs.map((a) => a.title)).toEqual(["Drop zone is hand-written"]);
    const junk = scripted([{ text: "sure! here you go" }]);
    const fallback = await extractAdrs(fakeReport({ decisions: [declined] }), [], junk, new AbortController().signal);
    expect(fallback[0]!.decision).toContain("Write the drop zone by hand");
  });
});

describe("Phase 4 exit test: recall across sessions", () => {
  it("a session started 3 days later recalls an unstated constraint from the earlier session", async () => {
    const c = clock(new Date("2026-09-21T09:00:00Z"));
    const fixture = loadProbe(PROBE);
    // A project with history: every fixture item except the constraint under test.
    const seedMem = new KiraMemory(memoryFile(ws), { now: c.now });
    await seedProbe(seedMem.store, { ...fixture, items: fixture.items.filter((i) => i.key !== "adr-fetch") }, c, c.now());
    seedMem.close();

    // ---- session 1: the human refuses axios, saying why --------------------------------
    const mem1 = new KiraMemory(memoryFile(ws), { now: c.now });
    const s1 = scripted([
      { text: "I'll add axios for the HTTP client.", calls: [{ name: "run_command", args: { command: "npm install axios" } }] },
      { calls: [{ name: "write_file", args: { path: "src/weather.ts", content: "export async function weather(city: string) { return (await fetch(`/w/${city}`)).json(); }\n" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "Weather helper written with fetch." } }] },
    ]);
    const r1 = await runSession({
      goal: "Add an HTTP client helper for the weather API",
      workspace: ws,
      chatFor: () => s1,
      approver: async (req) => (req.category === "dependency-install" ? { allow: false, note: "No axios. This project only uses the built-in fetch for HTTP calls." } : true),
      signal: new AbortController().signal,
      plan: false,
      initGit: true,
      memory: mem1,
    });
    expect(r1.status).toBe("done");
    const adr = mem1.store.list({ kind: "adr" }).find((a) => a.runId === r1.runId);
    expect(adr, "the decision became an ADR").toBeDefined();
    expect(adr!.review).toBe("pending");
    mem1.close();

    // ---- session 2, three days later: the goal does not mention the constraint -------
    c.advance(3 * DAY);
    const mem2 = new KiraMemory(memoryFile(ws), { now: c.now });
    const events: KiraEvent[] = [];
    const s2 = scripted([{ calls: [{ name: "finish", args: { outcome: "done", summary: "ok" } }] }]);
    await runSession({
      goal: "Add a helper that fetches the latest exchange rates from the rates API",
      workspace: ws,
      chatFor: () => s2,
      approver: async () => true,
      signal: new AbortController().signal,
      plan: false,
      memory: mem2,
      onEvent: (e) => events.push(e),
    });
    const system = s2.seen[0]![0]!.content!;
    expect(system).toMatch(/Project memory/);
    expect(system).toMatch(/No axios\. This project only uses the built-in fetch/);
    const recalled = events.find((e): e is Extract<KiraEvent, { type: "memory" }> => e.type === "memory");
    expect(recalled?.items.some((i) => i.id === adr!.id)).toBe(true);

    // "Where did we leave off?" knows when and what.
    const left = await mem2.leftOff(new AbortController().signal);
    expect(left.text).toMatch(/Last session \(today\): "Add a helper that fetches/);
    expect(left.text).toMatch(/Before that: "Add an HTTP client helper for the weather API" \(done, 3 days ago\)/);
    mem2.close();
  }, 60_000);

  it("scores ≥90% on the 20-question recall probe (offline embedder + FTS, no reranker)", async () => {
    const c = clock(new Date("2026-09-24T09:00:00Z"));
    const store = new MemoryStore(":memory:", { textEmbedder: new HashEmbedder(), now: c.now });
    const fixture = loadProbe(PROBE);
    const ids = await seedProbe(store, fixture, c, c.now());
    const r = await runProbe(store, fixture, ids, 5);
    expect(r.total).toBe(20);
    expect(r.score, JSON.stringify(r.misses, null, 2)).toBeGreaterThanOrEqual(0.9);
    store.close();
  });
});

// ---- live: the same probe with Codestral/Mistral embeddings and the NIM reranker ----
const configPath = (() => {
  try {
    return findConfig();
  } catch {
    return undefined;
  }
})();
if (configPath) loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });
const HAS_MISTRAL = !!process.env.MISTRAL_API_KEY?.trim();

describe.skipIf(!HAS_MISTRAL)("live recall probe (needs MISTRAL_API_KEY; NVIDIA_API_KEY adds the reranker)", () => {
  it("scores ≥90% with real embeddings", async () => {
    const config = loadModelsConfig(configPath!);
    const registry = new ProviderRegistry(config);
    const c = clock(new Date("2026-09-24T09:00:00Z"));
    const mem = await openMemory(ws, registry, config, { now: c.now });
    const fixture = loadProbe(PROBE);
    const ids = await seedProbe(mem.store, fixture, c, c.now());
    const r = await runProbe(mem.store, fixture, ids, 5);
    expect(r.score, JSON.stringify(r.misses, null, 2)).toBeGreaterThanOrEqual(0.9);
    mem.close();
  }, 300_000);
});
