import { describe, expect, it } from "vitest";
import { errorHash, ErrorRepeatTracker } from "../src/agent/error-hash.js";
import { parseToolArgs } from "../src/agent/json-repair.js";

describe("parseToolArgs", () => {
  it.each([
    ['{"path":"a.ts"}', { path: "a.ts" }],
    ['```json\n{"path":"a.ts"}\n```', { path: "a.ts" }],
    ['{"path":"a.ts",}', { path: "a.ts" }],
    ['Sure! {"path":"a.ts"} is what I will use', { path: "a.ts" }],
    ['"{\\"path\\":\\"a.ts\\"}"', { path: "a.ts" }],
    ["{\u201Cpath\u201D:\u201Ca.ts\u201D}", { path: "a.ts" }],
    ["", {}],
  ])("parses %j", (raw, expected) => {
    expect(parseToolArgs(raw)).toEqual(expected);
  });

  it.each(["not json at all", "[1,2]", '{"path": }'])("rejects %j", (raw) => {
    expect(parseToolArgs(raw)).toBeUndefined();
  });
});

describe("errorHash", () => {
  it("treats the same failure with different paths, ports and timings as identical", () => {
    const a = "Error: listen EADDRINUSE :::5173 at C:\\Users\\a\\app\\server.js:12 (after 340ms)";
    const b = "Error: listen EADDRINUSE :::5174 at C:\\Users\\b\\other\\server.js:99 (after 1200ms)";
    expect(errorHash(a)).toBe(errorHash(b));
  });

  it("distinguishes different failures", () => {
    expect(errorHash("Cannot find module 'react'")).not.toBe(errorHash("Unexpected token '<'"));
  });

  it("tracker counts repeats", () => {
    const t = new ErrorRepeatTracker();
    expect(t.record("npm ERR! 404 Not Found - GET https://registry.npmjs.org/raect")).toBe(1);
    expect(t.record("npm ERR! 404 Not Found - GET https://registry.npmjs.org/raect")).toBe(2);
    expect(t.record("something else")).toBe(1);
  });
});
