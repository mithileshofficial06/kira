import { createHash, randomBytes } from "node:crypto";
import type { ToolCall } from "./types.js";

interface StreamedToolCallDelta {
  index: number;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
}

/**
 * Streaming APIs send tool calls as fragments keyed by index. This rebuilds
 * complete calls. Some providers send the whole call in one delta, others
 * send arguments one token at a time; both work.
 */
export class ToolCallAccumulator {
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();

  push(delta: StreamedToolCallDelta): void {
    const cur = this.calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
    if (delta.id) cur.id = delta.id;
    if (delta.function?.name) cur.name += delta.function.name;
    if (delta.function?.arguments) cur.arguments += delta.function.arguments;
    this.calls.set(delta.index, cur);
  }

  finish(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, c]) => c.name.length > 0)
      .map(([, c]) => ({ id: c.id || newToolCallId(), name: c.name, arguments: c.arguments || "{}" }));
  }
}

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** 9 alphanumeric characters: valid for every provider Kira talks to. */
export function newToolCallId(): string {
  const bytes = randomBytes(9);
  let id = "";
  for (const b of bytes) id += ALNUM[b % ALNUM.length];
  return id;
}

const MISTRAL_ID = /^[a-zA-Z0-9]{9}$/;

/**
 * Mistral only accepts tool-call IDs of exactly 9 alphanumeric characters.
 * When a conversation started on another provider falls back to Mistral, the
 * IDs are rewritten deterministically so call/result pairs still match.
 */
export function toMistralToolCallId(id: string): string {
  if (MISTRAL_ID.test(id)) return id;
  const digest = createHash("sha256").update(id).digest();
  let out = "";
  for (let i = 0; i < 9; i++) out += ALNUM[digest[i]! % ALNUM.length];
  return out;
}
