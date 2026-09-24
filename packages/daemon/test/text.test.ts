import { describe, expect, it } from "vitest";
import { stripAnsi, truncateMiddle } from "../src/util/text.js";

describe("stripAnsi", () => {
  it("removes CSI, OSC and cursor codes and normalizes newlines", () => {
    const raw = "\u001b[?25l\u001b[2J\u001b[m\u001b[Hhello\r\n\u001b]0;C:\\cmd.exe\u0007\u001b[32mworld\u001b[0m\r\n";
    expect(stripAnsi(raw)).toBe("hello\nworld\n");
  });
});

describe("truncateMiddle", () => {
  it("leaves short text alone", () => {
    expect(truncateMiddle("abc", 10)).toBe("abc");
  });

  it("keeps head and tail and says how much was dropped", () => {
    const s = "H".repeat(100) + "M".repeat(1000) + "T".repeat(100);
    const out = truncateMiddle(s, 200);
    expect(out.startsWith("H".repeat(60))).toBe(true);
    expect(out.endsWith("T".repeat(100))).toBe(true);
    expect(out).toContain("[1000 characters omitted]");
  });
});
