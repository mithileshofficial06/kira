import { createHash } from "node:crypto";

/**
 * Hashes error output with the volatile parts removed (numbers, paths,
 * durations, hex ids), so "the same failure again" hashes identically even
 * when timestamps and ports differ.
 */
export function errorHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[a-z]:[\\/][^\s:'"]*/g, "<path>")
    .replace(/(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/g, "<dur>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Counts repeats of each error hash. `record` returns how many times this one has now been seen. */
export class ErrorRepeatTracker {
  private readonly counts = new Map<string, number>();

  record(errorText: string): number {
    const h = errorHash(errorText);
    const n = (this.counts.get(h) ?? 0) + 1;
    this.counts.set(h, n);
    return n;
  }
}
