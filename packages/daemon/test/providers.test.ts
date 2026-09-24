import { describe, expect, it } from "vitest";
import { classifyProviderError, ProviderUnavailableError, RateLimitedError } from "../src/providers/errors.js";
import { RateLimiter } from "../src/providers/rate-limit.js";
import { newToolCallId, toMistralToolCallId, ToolCallAccumulator } from "../src/providers/tool-calls.js";
import { AbortedError } from "../src/util/abort.js";

describe("RateLimiter", () => {
  it("allows a burst up to the per-minute limit, then waits", () => {
    let t = 0;
    const rl = new RateLimiter(3, () => t);
    expect([rl.tryAcquire(), rl.tryAcquire(), rl.tryAcquire()]).toEqual([true, true, true]);
    expect(rl.tryAcquire()).toBe(false);
    expect(rl.waitTime()).toBe(20_000);
    t = 20_000;
    expect(rl.tryAcquire()).toBe(true);
  });

  it("pauseFor blocks every caller until the pause ends", () => {
    let t = 0;
    const rl = new RateLimiter(60, () => t);
    rl.pauseFor(5_000);
    expect(rl.tryAcquire()).toBe(false);
    t = 5_000;
    expect(rl.tryAcquire()).toBe(true);
  });

  it("acquire rejects promptly when aborted while waiting", async () => {
    const rl = new RateLimiter(1);
    rl.tryAcquire();
    const ac = new AbortController();
    const p = rl.acquire(ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortedError);
  });
});

describe("ToolCallAccumulator", () => {
  it("rebuilds calls from token-by-token argument fragments", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, id: "call_1", function: { name: "run_command", arguments: "" } });
    acc.push({ index: 0, function: { arguments: '{"comm' } });
    acc.push({ index: 0, function: { arguments: 'and":"ls"}' } });
    acc.push({ index: 1, id: "call_2", function: { name: "read_file", arguments: '{"path":"a"}' } });
    expect(acc.finish()).toEqual([
      { id: "call_1", name: "run_command", arguments: '{"command":"ls"}' },
      { id: "call_2", name: "read_file", arguments: '{"path":"a"}' },
    ]);
  });

  it("assigns an id when the provider omits one and defaults empty args to {}", () => {
    const acc = new ToolCallAccumulator();
    acc.push({ index: 0, function: { name: "list_files" } });
    const [call] = acc.finish();
    expect(call?.id).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(call?.arguments).toBe("{}");
  });
});

describe("tool-call ids", () => {
  it("new ids are 9 alphanumerics", () => {
    for (let i = 0; i < 50; i++) expect(newToolCallId()).toMatch(/^[a-zA-Z0-9]{9}$/);
  });

  it("rewrites foreign ids deterministically for Mistral and keeps valid ones", () => {
    const foreign = "chatcmpl-tool-8f2e1c0d9b7a";
    expect(toMistralToolCallId(foreign)).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(toMistralToolCallId(foreign)).toBe(toMistralToolCallId(foreign));
    expect(toMistralToolCallId("abc123XYZ")).toBe("abc123XYZ");
  });
});

describe("classifyProviderError", () => {
  it("treats capacity errors sent mid-stream (no status) as a provider outage, not a crash", () => {
    // Seen live from NIM: an error event inside the SSE stream, no HTTP status.
    expect(classifyProviderError("nim", new Error("Service temporarily overloaded"))).toBeInstanceOf(ProviderUnavailableError);
    expect(classifyProviderError("mistral", new Error("Not enough capacity available for this request, please retry later."))).toBeInstanceOf(
      ProviderUnavailableError,
    );
    // A 400 that merely mentions the word is still a real error.
    const bad = { status: 400, message: "invalid request: model overloaded param" };
    expect(classifyProviderError("nim", bad)).toBe(bad);
  });

  it("maps 429 to RateLimitedError with retry-after", () => {
    const err = classifyProviderError("nim", { status: 429, headers: { "retry-after": "7" }, message: "slow down" });
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterMs).toBe(7_000);
  });

  it("maps 5xx and unknown-model 404 to ProviderUnavailableError", () => {
    expect(classifyProviderError("mistral", { status: 503, message: "x" })).toBeInstanceOf(ProviderUnavailableError);
    expect(classifyProviderError("mistral", { status: 404, message: "x" })).toBeInstanceOf(ProviderUnavailableError);
  });

  it("passes 400s through untouched (a bad request is a bug, not a fallback)", () => {
    const e = { status: 400, message: "bad" };
    expect(classifyProviderError("mistral", e)).toBe(e);
  });
});
