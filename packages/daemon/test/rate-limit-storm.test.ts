/**
 * Phase 1 exit test, second half (spec §10): a simulated 429 storm pauses and
 * resumes the run without corrupting state. Runs the real provider adapter,
 * rate limiter, fallback chain, loop and session state machine against a local
 * OpenAI-compatible server that throttles, fails and drops streams mid-turn.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "../src/checkpoint/git.js";
import { AuditLog } from "../src/control/audit.js";
import type { KiraEvent } from "../src/control/events.js";
import { runSession } from "../src/control/runner.js";
import type { SessionRecord } from "../src/control/session.js";
import type { ModelsConfig } from "../src/config/models.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { ChatMessage } from "../src/providers/types.js";
import { startFakeOpenAI, toolResultCount, type FakeServer } from "./helpers/fake-openai.js";

const STEPS = 10;
const PARTIAL = "PARTIAL-TEXT-FROM-A-DROPPED-STREAM";

let server: FakeServer;
let ws: string;

/** Deterministic storm: a long burst of 429s, scattered 429s, a 503 and a mid-stream drop. */
function storm(n: number): "429" | "503" | "drop" | undefined {
  if (n >= 4 && n <= 11) return "429"; // longer than the fallback chain: forces a real pause
  if (n === 17) return "drop";
  if (n === 22) return "503";
  if (n % 5 === 0) return "429";
  return undefined;
}

beforeAll(async () => {
  server = await startFakeOpenAI((req) => {
    const s = storm(req.n);
    if (s === "429") return { kind: "status", status: 429, headers: { "retry-after": "0.05" } };
    if (s === "503") return { kind: "status", status: 503 };
    if (s === "drop") return { kind: "drop", text: PARTIAL };
    const k = toolResultCount(req) + 1;
    if (k < STEPS) {
      return {
        kind: "turn",
        turn: { text: `Writing file ${k}.`, calls: [{ name: "write_file", args: { path: `out/f${k}.txt`, content: `v${k}` } }] },
      };
    }
    return { kind: "turn", turn: { calls: [{ name: "finish", args: { outcome: "done", summary: "all files written" } }] } };
  });
  ws = await mkdtemp(join(tmpdir(), "kira-storm-"));
});

afterAll(async () => {
  await server.close();
  await rm(ws, { recursive: true, force: true });
});

describe("Phase 1 exit test: 429 storm", () => {
  it("pauses in RATE_LIMITED, resumes, and finishes with history, files and audit intact", async () => {
    const config: ModelsConfig = {
      providers: { mistral: { baseURL: server.baseURL, apiKeyEnv: "FAKE_KEY", requestsPerMinute: 6000 } },
      roles: {
        planner: [{ provider: "mistral", model: "model-a" }],
        executor: [
          { provider: "mistral", model: "model-a" },
          { provider: "mistral", model: "model-b" },
        ],
        critic: [{ provider: "mistral", model: "model-b" }],
        utility: [{ provider: "mistral", model: "model-a" }],
      },
      pricing: { "mistral:model-a": { inputPerM: 1, outputPerM: 2 }, "mistral:model-b": { inputPerM: 1, outputPerM: 2 } },
    };
    const registry = new ProviderRegistry(config, { FAKE_KEY: "test" });
    const events: KiraEvent[] = [];

    const report = await runSession({
      goal: "write ten files",
      workspace: ws,
      chatFor: (role) => (req, signal, onFallback) => registry.chat(role, req, signal, onFallback),
      approver: async () => true,
      signal: new AbortController().signal,
      plan: false,
      initGit: true,
      pricing: config.pricing,
      onEvent: (e) => events.push(e),
    });

    // The run finished despite the storm.
    expect(report.status, report.summary).toBe("done");
    expect(report.steps).toBe(STEPS);
    expect(report.rateLimitPauses).toBeGreaterThan(0);
    expect(report.fallbacks).toBeGreaterThan(0);

    // Every file exactly once, with the right content.
    for (let k = 1; k < STEPS; k++) expect(await readFile(join(ws, `out/f${k}.txt`), "utf8")).toBe(`v${k}`);

    // The state machine went RATE_LIMITED and came back to EXECUTING, and ended IDLE.
    const session = JSON.parse(readFileSync(join(report.runDir!, "session.json"), "utf8")) as SessionRecord;
    const moves = session.transitions.map((t) => `${t.from}>${t.to}`);
    expect(moves).toContain("EXECUTING>RATE_LIMITED");
    expect(moves).toContain("RATE_LIMITED>EXECUTING");
    expect(session.state).toBe("IDLE");
    expect(events.some((e) => e.type === "state" && e.state === "RATE_LIMITED" && e.resumeAt)).toBe(true);

    // History: one assistant turn per step, every call answered, nothing from failed attempts.
    const { history } = JSON.parse(readFileSync(join(report.runDir!, "history.json"), "utf8")) as { history: ChatMessage[] };
    const assistants = history.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(STEPS);
    expect(JSON.stringify(history)).not.toContain(PARTIAL);
    for (let i = 0; i < history.length; i++) {
      const m = history[i]!;
      if (m.role !== "assistant" || !m.toolCalls) continue;
      const next = history.slice(i + 1, i + 1 + m.toolCalls.length);
      expect(next.map((x) => x.role)).toEqual(m.toolCalls.map(() => "tool"));
    }

    // Audit: one billed model request per committed turn, and every pause recorded.
    const audit = AuditLog.read(join(report.runDir!, "audit.jsonl"));
    expect(audit.filter((a) => a.type === "model_request")).toHaveLength(STEPS);
    expect(audit.filter((a) => a.type === "rate_limited").length).toBe(report.rateLimitPauses);
    expect(audit.filter((a) => a.type === "tool_call")).toHaveLength(STEPS);
    expect(report.budget.costUsd).toBeCloseTo((STEPS * (100 * 1 + 20 * 2)) / 1_000_000, 10);

    // Kira's own files never show up in the user's git status.
    expect(existsSync(join(ws, ".kira"))).toBe(true);
    const status = await git(["status", "--porcelain"], { cwd: ws });
    expect(status).not.toContain(".kira");
  }, 120_000);
});
