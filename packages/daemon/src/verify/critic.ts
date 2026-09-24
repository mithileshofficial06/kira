import type { ChatFn } from "../agent/loop.js";
import { parseToolArgs } from "../agent/json-repair.js";
import type { ModelRef } from "../config/models.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { StubFinding } from "./stubs.js";

/**
 * Model family, not provider: NIM hosts Mistral models too, and a Qwen
 * executor on NIM must not be reviewed by Qwen on NIM (spec §4.3).
 */
export function modelFamily(ref: Pick<ModelRef, "provider" | "model">): string {
  if (ref.provider === "mistral") return "mistral";
  const vendor = ref.model.split("/")[0]!.toLowerCase();
  if (vendor === "mistralai") return "mistral";
  if (vendor === "moonshotai") return "kimi";
  if (vendor === "deepseek-ai") return "deepseek";
  if (vendor === "meta") return "llama";
  return vendor;
}

/** Parses "provider/model" labels as the loop reports them. */
export function parseModelLabel(label: string | undefined): ModelRef | undefined {
  if (!label) return undefined;
  const i = label.indexOf("/");
  if (i < 0) return undefined;
  const provider = label.slice(0, i);
  if (provider !== "mistral" && provider !== "nim") return undefined;
  return { provider, model: label.slice(i + 1) };
}

export interface CriticChoice {
  chat: ChatFn;
  /** False when only same-family models were available: the review is degraded and says so. */
  crossFamily: boolean;
  chain: ModelRef[];
}

/** The critic chain reordered so every other-family model comes before any same-family one. */
export function chooseCritic(registry: ProviderRegistry, executorLabel: string | undefined): CriticChoice | undefined {
  const exec = parseModelLabel(executorLabel);
  const chain = registry.chain("critic");
  if (chain.length === 0) return undefined;
  const execFamily = exec ? modelFamily(exec) : undefined;
  const other = chain.filter((r) => modelFamily(r) !== execFamily);
  const same = chain.filter((r) => modelFamily(r) === execFamily);
  const ordered = [...other, ...same];
  return {
    chain: ordered,
    crossFamily: other.length > 0,
    chat: (req, signal, onFallback) => registry.chatWith("critic", ordered, req, signal, onFallback),
  };
}

export interface CriticVerdict {
  pass: boolean;
  blocking: string[];
  concerns: string[];
  model?: string;
}

/** A cold review of the full diff by a different model family (L5). */
export async function critique(
  chat: ChatFn,
  input: { goal: string; claim: string; patch: string; gateSummary: string; stubs: StubFinding[] },
  signal: AbortSignal,
): Promise<CriticVerdict> {
  const stubs = input.stubs.length
    ? `\nA static scan already flagged these added lines:\n${input.stubs.map((s) => `- ${s.file}:${s.line} ${s.text}`).join("\n")}\n`
    : "";
  const messages = [
    {
      role: "system" as const,
      content:
        "You review another model's work cold. You did not write it and owe it nothing. Judge whether the diff really " +
        "achieves the goal. Look for: stub or placeholder code, TODOs standing in for logic, functions that return fake " +
        "values, dead code, scope creep beyond the goal, and claims in the summary the diff does not support. " +
        'Reply with ONLY JSON: {"verdict":"pass"|"fail","blocking":["issue that means the goal is NOT met", ...],' +
        '"concerns":["non-blocking issue worth a human look", ...]}. Keep each item to one sentence with a file name.',
    },
    {
      role: "user" as const,
      content:
        `Goal:\n${input.goal}\n\nThe agent claims:\n${input.claim}\n\nAutomated checks:\n${input.gateSummary}\n${stubs}\n` +
        `Full diff since the run started:\n${input.patch.slice(0, 60_000) || "(empty diff)"}`,
    },
  ];
  let text = "";
  let model: string | undefined;
  for await (const ev of chat({ messages, temperature: 0 }, signal)) {
    if (ev.type === "text") text += ev.delta;
    if (ev.type === "model") model = `${ev.model.provider}/${ev.model.model}`;
  }
  const json = parseToolArgs(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as
    | { verdict?: unknown; blocking?: unknown; concerns?: unknown }
    | undefined;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
  if (!json) {
    // An unreadable review blocks nothing, but it is never silently counted as a clean one.
    return { pass: true, blocking: [], concerns: [`the critic's reply could not be read, so the diff was not reviewed: ${text.slice(0, 160)}`], ...(model ? { model } : {}) };
  }
  const blocking = list(json.blocking);
  return {
    pass: json.verdict === "pass" && blocking.length === 0,
    blocking,
    concerns: list(json.concerns),
    ...(model ? { model } : {}),
  };
}
