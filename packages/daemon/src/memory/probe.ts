/**
 * The Phase 4 recall probe: seed a memory from a fixture, ask each question,
 * and count how often the expected item ranks in the top K.
 */
import { readFileSync } from "node:fs";
import type { MemoryKind, MemoryStore } from "./store.js";

export interface ProbeFixture {
  items: {
    key: string;
    kind: MemoryKind;
    title: string;
    body: string;
    daysAgo?: number;
    files?: string[];
    signature?: string;
    status?: string;
  }[];
  probes: { q: string; expect: string }[];
}

export function loadProbe(file: string): ProbeFixture {
  return JSON.parse(readFileSync(file, "utf8")) as ProbeFixture;
}

/** Inserts the fixture, oldest first, with `clock` set to each item's age. Returns fixture key -> item id. */
export async function seedProbe(store: MemoryStore, fixture: ProbeFixture, clock: { set(d: Date): void }, now: Date): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  const sorted = [...fixture.items].sort((a, b) => (b.daysAgo ?? 0) - (a.daysAgo ?? 0));
  for (const it of sorted) {
    clock.set(new Date(now.getTime() - (it.daysAgo ?? 0) * 86_400_000));
    const item = await store.add({
      kind: it.kind,
      title: it.title,
      body: it.body,
      files: it.files,
      signature: it.signature,
      source: "fixture",
      meta: it.kind === "episode" ? { status: it.status ?? "done", summary: it.body } : {},
    });
    ids.set(it.key, item.id);
  }
  clock.set(now);
  return ids;
}

export interface ProbeResult {
  hits: number;
  total: number;
  score: number;
  misses: { q: string; expect: string; got: string[] }[];
}

export async function runProbe(store: MemoryStore, fixture: ProbeFixture, ids: Map<string, number>, k = 5): Promise<ProbeResult> {
  const keyOf = new Map([...ids].map(([key, id]) => [id, key]));
  const misses: ProbeResult["misses"] = [];
  let hits = 0;
  for (const p of fixture.probes) {
    const got = (await store.search(p.q, { limit: k })).map((h) => keyOf.get(h.item.id) ?? String(h.item.id));
    if (got.includes(p.expect)) hits++;
    else misses.push({ q: p.q, expect: p.expect, got });
  }
  return { hits, total: fixture.probes.length, score: hits / fixture.probes.length, misses };
}
