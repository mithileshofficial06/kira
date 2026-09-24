import { z } from "zod";
import type { ToolSpec } from "../providers/types.js";
import type { BackgroundManager } from "./background.js";
import type { Gate } from "./gate.js";

export interface ToolContext {
  /** Absolute workspace root. Every path a tool touches must resolve inside it. */
  workspace: string;
  signal: AbortSignal;
  gate: Gate;
  background: BackgroundManager;
  /** Progress lines for the operator (terminal now, Flight Deck later). Never sent to the model. */
  log: (line: string) => void;
}

export interface ToolResult {
  /** What the model sees. Keep it short: full output belongs on disk. */
  content: string;
  isError?: boolean;
  /** Set by the `finish` tool to end the run. */
  finished?: { outcome: "done" | "blocked" | "failed"; summary: string };
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

const SAFE_INT = Number.MAX_SAFE_INTEGER;

/** zod -> JSON Schema, minus the bits some providers reject ($schema, ±2^53 bounds). */
export function toToolSpec(tool: Tool): ToolSpec {
  const schema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parameters: clean(schema) as Record<string, unknown> };
}

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if ((k === "minimum" && v === -SAFE_INT) || (k === "maximum" && v === SAFE_INT)) continue;
      out[k] = clean(v);
    }
    return out;
  }
  return node;
}
