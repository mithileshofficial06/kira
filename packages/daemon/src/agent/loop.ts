import type { CheckpointManager } from "../checkpoint/manager.js";
import type { ModelRef } from "../config/models.js";
import type { FallbackEvent, RoleChatEvent } from "../providers/registry.js";
import type { ChatMessage, ChatRequest, ToolCall, Usage } from "../providers/types.js";
import { toToolSpec, type Tool, type ToolContext, type ToolResult } from "../tools/index.js";
import { AbortedError, isAbortError } from "../util/abort.js";
import { ErrorRepeatTracker } from "./error-hash.js";
import { parseToolArgs } from "./json-repair.js";

/** Streams one model turn. ProviderRegistry.chat bound to a role satisfies this. */
export type ChatFn = (
  req: Omit<ChatRequest, "model">,
  signal: AbortSignal,
  onFallback?: (e: FallbackEvent) => void,
) => AsyncIterable<RoleChatEvent>;

export type RunStatus = "done" | "blocked" | "failed" | "stuck" | "budget" | "stalled" | "aborted" | "confused";

export interface AgentEvent {
  type: "step" | "model" | "narration" | "tool_call" | "tool_result" | "fallback" | "note";
  step: number;
  text: string;
}

export interface RunOptions {
  goal: string;
  system: string;
  tools: Tool[];
  ctx: Omit<ToolContext, "signal">;
  signal: AbortSignal;
  maxSteps?: number;
  /** Identical normalized errors allowed before the run stops as stuck (spec §4.3). */
  maxRepeatedErrors?: number;
  /** Malformed tool calls in one step before the run stops as confused (spec §4.5). */
  maxMalformedPerStep?: number;
  /** Consecutive turns without a tool call before the run stops as stalled. */
  maxIdleTurns?: number;
  onEvent?: (e: AgentEvent) => void;
  /** When set, every step is preceded by a checkpoint and an interrupt rewinds the interrupted step. */
  checkpoints?: { manager: CheckpointManager; runId: string };
}

export interface RunResult {
  status: RunStatus;
  summary: string;
  steps: number;
  usage: Usage;
  malformedCalls: number;
  models: ModelRef[];
  /** Committed history: only complete turns, never a call without its result. */
  messages: ChatMessage[];
  /** Set when an interrupt rolled the workspace back to the start of the interrupted step. */
  rewound?: { step: number; restored: string[]; removed: string[]; undoRef: string };
}

/**
 * The Kira agent loop (spec §6.2). Owns the message history, so an interrupt
 * truncates cleanly at the last turn boundary.
 */
export async function runAgent(chat: ChatFn, opts: RunOptions): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? 40;
  const maxRepeated = opts.maxRepeatedErrors ?? 3;
  const maxMalformed = opts.maxMalformedPerStep ?? 3;
  const maxIdle = opts.maxIdleTurns ?? 2;
  const emit = (type: AgentEvent["type"], step: number, text: string) => opts.onEvent?.({ type, step, text });

  const tools = new Map(opts.tools.map((t) => [t.name, t]));
  const specs = opts.tools.map(toToolSpec);
  const ctx: ToolContext = { ...opts.ctx, signal: opts.signal };
  const repeats = new ErrorRepeatTracker();
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  const models: ModelRef[] = [];
  let malformedCalls = 0;
  let idleTurns = 0;

  const history: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.goal },
  ];
  const result = (status: RunStatus, summary: string, steps: number): RunResult => ({
    status,
    summary,
    steps,
    usage,
    malformedCalls,
    models,
    messages: history,
  });

  let step = 0;
  let checkpointedStep = 0;
  try {
    while (step < maxSteps) {
      step++;
      emit("step", step, `step ${step}/${maxSteps}`);
      if (opts.checkpoints) {
        const c = await opts.checkpoints.manager.create(opts.checkpoints.runId, step);
        checkpointedStep = step;
        emit("note", step, `checkpoint ${c.ref} ${c.sha.slice(0, 8)}`);
      }

      // ---- model turn --------------------------------------------------
      let text = "";
      const calls: ToolCall[] = [];
      for await (const ev of chat({ messages: history, tools: specs, temperature: 0.2 }, opts.signal, (f) =>
        emit("fallback", step, `${f.from.provider}/${f.from.model} unavailable (${f.reason.slice(0, 120)}); trying next`),
      )) {
        if (ev.type === "model") {
          models.push(ev.model);
          emit("model", step, `${ev.model.provider}/${ev.model.model}`);
        } else if (ev.type === "text") text += ev.delta;
        else if (ev.type === "tool_call") calls.push(ev.call);
        else if (ev.type === "done" && ev.usage) {
          usage.promptTokens += ev.usage.promptTokens;
          usage.completionTokens += ev.usage.completionTokens;
        }
      }
      if (text.trim()) emit("narration", step, text.trim());

      // The turn is staged and only committed once every call has its result.
      const turn: ChatMessage[] = [{ role: "assistant", content: text || null, toolCalls: calls.length ? calls : undefined }];

      if (calls.length === 0) {
        idleTurns++;
        if (idleTurns > maxIdle) {
          history.push(...turn);
          return result("stalled", text.trim() || "The model stopped calling tools without finishing.", step);
        }
        turn.push({ role: "user", content: "Continue by calling a tool. If the goal is verified or you are blocked, call finish." });
        history.push(...turn);
        continue;
      }
      idleTurns = 0;

      // ---- tool calls --------------------------------------------------
      let finished: ToolResult["finished"];
      let malformedThisStep = 0;
      let stuck: string | undefined;
      for (const call of calls) {
        const r = await executeCall(call, tools, ctx);
        if (r.malformed) {
          malformedCalls++;
          malformedThisStep++;
        }
        emit("tool_call", step, `${call.name} ${abbreviate(call.arguments)}`);
        emit("tool_result", step, `${r.result.isError ? "ERROR " : ""}${abbreviate(r.result.content, 300)}`);
        turn.push({ role: "tool", toolCallId: call.id, content: r.result.content });
        if (r.result.finished) finished = r.result.finished;
        if (r.result.isError && !r.malformed && repeats.record(r.result.content) >= maxRepeated) {
          stuck = r.result.content;
        }
      }
      history.push(...turn); // turn boundary

      if (finished) return result(finished.outcome, finished.summary, step);
      if (stuck) return result("stuck", `Same error ${maxRepeated} times; escalating instead of retrying:\n${abbreviate(stuck, 600)}`, step);
      if (malformedThisStep >= maxMalformed) {
        return result("confused", `${malformedThisStep} malformed tool calls in one step; stopping for review.`, step);
      }
    }
    return result("budget", `Step budget (${maxSteps}) used up before the goal was verified.`, step);
  } catch (err) {
    if (isAbortError(err) || opts.signal.aborted) {
      // Processes first, so nothing writes to the tree while it is being rewound.
      await stopBackground(opts, emit, step);
      const r = result("aborted", `Interrupted during step ${step}. History kept up to the last complete turn.`, step);
      if (opts.checkpoints && checkpointedStep === step && step > 0) {
        const rep = await opts.checkpoints.manager.restore(opts.checkpoints.runId, step);
        r.rewound = { step, restored: rep.restored, removed: rep.removed, undoRef: rep.undo.ref };
        r.summary += ` Workspace rewound to the start of step ${step} (${rep.restored.length} restored, ${rep.removed.length} removed; undo: ${rep.undo.ref}).`;
      }
      return r;
    }
    throw err;
  } finally {
    await stopBackground(opts, emit, step);
  }
}

async function stopBackground(opts: RunOptions, emit: (t: AgentEvent["type"], s: number, x: string) => void, step: number) {
  const reports = await opts.ctx.background.stopAll();
  const survivors = reports.flatMap((r) => r.survivors);
  if (survivors.length) emit("note", step, `WARNING: background PIDs survived shutdown: ${survivors.join(", ")}`);
}

async function executeCall(
  call: ToolCall,
  tools: Map<string, Tool>,
  ctx: ToolContext,
): Promise<{ result: ToolResult; malformed: boolean }> {
  const tool = tools.get(call.name);
  if (!tool) {
    return {
      malformed: true,
      result: { isError: true, content: `Unknown tool "${call.name}". Available: ${[...tools.keys()].join(", ")}.` },
    };
  }
  const args = parseToolArgs(call.arguments);
  if (!args) {
    return { malformed: true, result: { isError: true, content: `Arguments are not a JSON object: ${abbreviate(call.arguments)}` } };
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { malformed: true, result: { isError: true, content: `Invalid arguments for ${call.name}: ${issues}` } };
  }
  try {
    return { malformed: false, result: await tool.run(parsed.data, ctx) };
  } catch (err) {
    if (isAbortError(err) || ctx.signal.aborted) throw err instanceof AbortedError ? err : new AbortedError(ctx.signal.reason);
    return { malformed: false, result: { isError: true, content: `${(err as Error).name}: ${(err as Error).message}` } };
  }
}

function abbreviate(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
