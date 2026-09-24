/**
 * Phase 0 exit criterion (b): aborting mid-stream cancels the HTTP request
 * within 200ms. Measured two ways: when the caller's stream rejects, and
 * when the server actually sees the connection close. Runs against a local
 * server always, and against the real providers when API keys are set.
 */
import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findConfig, loadModelsConfig, type ModelsConfig } from "../src/config/models.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { isAbortError } from "../src/util/abort.js";
import { startFakeOpenAI, type FakeServer } from "./helpers/fake-openai.js";

const LIMIT_MS = 200;

/** Streams until the first text arrives, aborts, and returns when it aborted and how long the stream took to reject. */
async function abortAfterFirstToken(registry: ProviderRegistry, role: "executor" | "critic", prompt: string): Promise<{ abortedAt: number; rejectMs: number }> {
  const ac = new AbortController();
  let abortedAt = 0;
  try {
    for await (const ev of registry.chat(role, { messages: [{ role: "user", content: prompt }], maxTokens: 2000 }, ac.signal)) {
      if (ev.type === "text" && ev.delta && !abortedAt) {
        abortedAt = performance.now();
        ac.abort("user said stop");
      }
    }
    throw new Error("stream finished without being aborted");
  } catch (err) {
    if (!abortedAt) throw err;
    expect(isAbortError(err), String(err)).toBe(true);
    return { abortedAt, rejectMs: performance.now() - abortedAt };
  }
}

describe("abort latency (local server)", () => {
  let server: FakeServer;
  let closedAt = 0;
  beforeAll(async () => {
    server = await startFakeOpenAI(() => ({ kind: "slow", everyMs: 50, onClose: () => (closedAt = performance.now()) }));
  });
  afterAll(() => server.close());

  it(`cancels the stream and the HTTP request within ${LIMIT_MS}ms`, async () => {
    const config: ModelsConfig = {
      providers: { mistral: { baseURL: server.baseURL, apiKeyEnv: "K", requestsPerMinute: 600 } },
      roles: { planner: [{ provider: "mistral", model: "m" }], executor: [{ provider: "mistral", model: "m" }], critic: [{ provider: "mistral", model: "m" }], utility: [{ provider: "mistral", model: "m" }] },
    };
    const registry = new ProviderRegistry(config, { K: "k" });
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      closedAt = 0;
      const { abortedAt, rejectMs } = await abortAfterFirstToken(registry, "executor", "go");
      // The server must see the socket go away too: a real cancel, not just a client that stopped reading.
      const deadline = performance.now() + 1_000;
      while (!closedAt && performance.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      samples.push(Math.max(rejectMs, closedAt ? closedAt - abortedAt : Infinity));
    }
    expect(Math.max(...samples), `samples: ${samples.map((s) => s.toFixed(1)).join(", ")}ms`).toBeLessThan(LIMIT_MS);
  });
});

// ---- live -------------------------------------------------------------------------
const configPath = (() => {
  try {
    return findConfig();
  } catch {
    return undefined;
  }
})();
if (configPath) loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });

describe.skipIf(!process.env.MISTRAL_API_KEY?.trim() && !process.env.NVIDIA_API_KEY?.trim())("abort latency (live providers)", () => {
  it(`aborting a real stream rejects within ${LIMIT_MS}ms on each provider`, async () => {
    const full = loadModelsConfig(configPath!);
    const results: string[] = [];
    for (const provider of ["mistral", "nim"] as const) {
      const ref = full.roles.executor.find((r) => r.provider === provider);
      if (!ref) continue;
      const one: ModelsConfig = { ...full, roles: { ...full.roles, executor: [ref] } };
      const registry = new ProviderRegistry(one);
      if (!registry.get(provider)) continue;
      const { rejectMs: ms } = await abortAfterFirstToken(registry, "executor", "Write a 600-word essay about rivers. Start immediately.");
      results.push(`${provider}/${ref.model}: ${ms.toFixed(1)}ms`);
      expect(ms, results.join("; ")).toBeLessThan(LIMIT_MS);
    }
    console.log(`[abort latency] ${results.join(" · ")}`);
    expect(results.length).toBeGreaterThan(0);
  }, 180_000);
});
