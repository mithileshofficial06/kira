import { createHash } from "node:crypto";
import type { ModelRef } from "../config/models.js";
import type { ProviderRegistry } from "../providers/registry.js";

/** Turns text into vectors. `model` is stored beside every vector it makes. */
export interface Embedder {
  readonly model: string;
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>;
}

/** Codestral Embed / Mistral Embed (or a NIM embed model) through the provider adapter. */
export class ProviderEmbedder implements Embedder {
  readonly model: string;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly ref: ModelRef,
    private readonly batchSize = 32,
  ) {
    this.model = `${ref.provider}/${ref.model}`;
  }

  async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    const provider = this.registry.get(this.ref.provider);
    if (!provider) throw new Error(`No API key for ${this.ref.provider}`);
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => t.slice(0, 8_000));
      for (const v of await provider.embed(batch, this.ref.model, signal)) out.push(normalize(Float32Array.from(v)));
    }
    return out;
  }
}

const STOP = new Set(
  "a an and are as at be but by do does for from has have how i if in into is it its of on or our so that the their then there these this to was we were what when where which who why will with you your".split(
    " ",
  ),
);

/** Lowercased word tokens with a light suffix strip, stopwords removed. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => t.replace(/(ing|ed|es|s)$/, "") || t);
}

/**
 * Offline fallback: feature hashing of words and word pairs into a fixed
 * space. Lexical, not semantic, but it keeps memory working with no network
 * and makes retrieval tests deterministic.
 */
export class HashEmbedder implements Embedder {
  readonly model: string;

  constructor(private readonly dim = 384) {
    this.model = `local/hash-${dim}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const toks = tokens(text);
    const add = (feature: string, weight: number) => {
      const h = createHash("md5").update(feature).digest();
      const idx = h.readUInt32LE(0) % this.dim;
      v[idx]! += (h[4]! & 1 ? 1 : -1) * weight;
    };
    for (let i = 0; i < toks.length; i++) {
      add(toks[i]!, 1);
      if (i + 1 < toks.length) add(`${toks[i]} ${toks[i + 1]}`, 0.5);
    }
    return normalize(v);
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
