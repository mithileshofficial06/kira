import type { CheckpointManager } from "../checkpoint/manager.js";
import type { AuditLog } from "../control/audit.js";
import { Budget, type BudgetSnapshot } from "../control/budget.js";
import type { Session } from "../control/session.js";
import type { ModelRef } from "../config/models.js";
import { ProviderUnavailableError, RateLimitedError } from "../providers/errors.js";
import type { FallbackEvent, RoleChatEvent } from "../providers/registry.js";
import type { ChatMessage, ChatRequest, ToolCall, Usage } from "../providers/types.js";
import { toToolSpec, type Tool, type ToolContext, type ToolResult } from "../tools/index.js";
import { AbortedError, isAbortError, sleep, throwIfAborted } from "../util/abort.js";
import { ErrorRepeatTracker } from "./error-hash.js";
import { parseToolArgs } from "./json-repair.js";

/** Streams one model turn. ProviderRegistry.chat bound to a role satisfies this. */
export type ChatFn = (
  req: Omit<ChatRequest, "model">,
  signal: AbortSignal,
  onFallback?: (e: FallbackEvent) => void,
) => AsyncIterable<RoleChatEvent>;

export type RunStatus =
  | "done"
  | "blocked"
  | "failed"
  | "stuck"
  | "budget"
  | "stalled"
  | "aborted"
  | "confused"
  /** Every model in the chain stayed throttled or down for longer than the wait budget. */
  | "unavailable";

export type AgentEventType =
  | "step"
  | "model"
  | "narration"
  | "tool_call"
  | "tool_result"
  | "fallback"
  | "note"
  | "checkpoint"
  | "rate_limited"
  | "resumed"
  | "budget"
  | "step_timeout"
  | "verification";

export interface AgentEvent {
  type: AgentEventType;
  step: number;
  text: string;
  data?: unknown;
}

/** What verification decided when the model called finish(done). */
export type FinishVerdict =
  | { action: "accept"; summary?: string }
  | { action: "retry"; feedback: string }
  | { action: "fail"; summary: string };

export interface LoopHooks {
  /** Runs when the model claims done. The verification ladder plugs in here (spec §6.2). */
  beforeFinish?: (claim: { summary: string; step: number }, signal: AbortSignal) => Promise<FinishVerdict>;
  /** A note to attach to a tool's result, e.g. a procedural lesson matched on the call's signature. */
  toolNote?: (tool: string, args: unknown) => string | undefined;
  /** Sees every executed call, e.g. to learn procedural lessons. */
  afterTool?: (tool: string, args: unknown, result: ToolResult, step: number) => void;
  /** Called at every turn boundary with the committed history (persist it here). */
  onCommit?: (history: readonly ChatMessage[], step: number) => void;
}

export interface RunOptions {
  goal: string;
  system: string;
  tools: Tool[];
  ctx: Omit<ToolContext, "signal">;
  signal: AbortSignal;
  /** Step budget. Defaults to the budget's maxSteps (40). */
  maxSteps?: number;
  /** Identical normalized errors allowed before the run stops as stuck (spec §4.3). */
  maxRepeatedErrors?: number;
  /** Malformed tool calls in one step before the run stops as confused (spec §4.5). */
  maxMalformedPerStep?: number;
  /** Consecutive turns without a tool call before the run stops as stalled. */
  maxIdleTurns?: number;
  /** Wall-clock budget for one step (model turn plus its tool calls). Default 15 minutes. */
  stepTimeoutMs?: number;
  /** Total time the run may spend waiting out rate limits and outages. Default 20 minutes. */
  maxProviderWaitMs?: number;
  onEvent?: (e: AgentEvent) => void;
  /** When set, every step is preceded by a checkpoint and an interrupt rewinds the interrupted step. */
  checkpoints?: { manager: CheckpointManager; runId: string };
  budget?: Budget;
  audit?: AuditLog;
  /** The session state machine: the loop moves it through RATE_LIMITED and back. */
  session?: Session;
  /** Role name for the audit log. */
  role?: string;
  hooks?: LoopHooks;
  /** Continue a persisted run instead of starting fresh. */
  resume?: { history: ChatMessage[]; step: number };
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
  budget: BudgetSnapshot;
  /** Set when an interrupt rolled the workspace back to the start of the interrupted step. */
  rewound?: { step: number; restored: string[]; removed: string[]; undoRef: string };
}

const DEFAULT_STEP_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_PROVIDER_WAIT_MS = 20 * 60_000;

class StepTimeoutError extends Error {
  override name = "StepTimeoutError";
}

/**
 * The Kira agent loop (spec §6.2). Owns the message history, so an interrupt
 * truncates cleanly at the last turn boundary, and a provider failure mid-turn
 * throws away only the uncommitted turn (spec §8 invariant 6).
 */
export async function runAgent(chat: ChatFn, opts: RunOptions): Promise<RunResult> {
  const budget = opts.budget ?? new Budget({ maxSteps: opts.maxSteps ?? 40 });
  const maxSteps = opts.maxSteps ?? budget.limits.maxSteps;
  const maxRepeated = opts.maxRepeatedErrors ?? 3;
  const maxMalformed = opts.maxMalformedPerStep ?? 3;
  const maxIdle = opts.maxIdleTurns ?? 2;
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxProviderWait = opts.maxProviderWaitMs ?? DEFAULT_PROVIDER_WAIT_MS;
  const emit = (type: AgentEventType, step: number, text: string, data?: unknown) =>
    opts.onEvent?.({ type, step, text, ...(data !== undefined ? { data } : {}) });
  const audit = opts.audit;
  const role = opts.role ?? "executor";
  const autonomy = opts.ctx.gate.autonomy;

  const tools = new Map(opts.tools.map((t) => [t.name, t]));
  const specs = opts.tools.map(toToolSpec);
  const repeats = new ErrorRepeatTracker();
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  const models: ModelRef[] = [];
  let malformedCalls = 0;
  let idleTurns = 0;
  let providerWaitedMs = 0;
  let budgetTriggerFired = false;

  const history: ChatMessage[] = opts.resume
    ? structuredClone(opts.resume.history)
    : [
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
    budget: budget.snapshot(),
  });

  let step = opts.resume?.step ?? 0;
  const commit = (msgs: ChatMessage[]) => {
    history.push(...msgs);
    opts.hooks?.onCommit?.(history, step);
  };
  let checkpointedStep = 0;
  let lastCheckpoint: string | undefined;

  const rewindStep = async (s: number) => {
    if (!opts.checkpoints || checkpointedStep !== s || s === 0) return undefined;
    const rep = await opts.checkpoints.manager.restore(opts.checkpoints.runId, s);
    return { step: s, restored: rep.restored, removed: rep.removed, undoRef: rep.undo.ref };
  };

  /** One model turn, retried through rate limits and outages. Nothing is committed here. */
  const modelTurn = async (signal: AbortSignal): Promise<{ text: string; calls: ToolCall[] }> => {
    let attempt = 0;
    for (;;) {
      let text = "";
      const calls: ToolCall[] = [];
      let model: ModelRef | undefined;
      try {
        for await (const ev of chat({ messages: history, tools: specs, temperature: 0.2 }, signal, (f) => {
          emit("fallback", step, `${f.from.provider}/${f.from.model} unavailable (${f.reason.slice(0, 120)}); trying next`);
          audit?.append({ type: "fallback", step, from: `${f.from.provider}/${f.from.model}`, reason: f.reason.slice(0, 500) });
        })) {
          if (ev.type === "model") {
            model = ev.model;
            models.push(ev.model);
            emit("model", step, `${ev.model.provider}/${ev.model.model}`, ev.model);
          } else if (ev.type === "text") text += ev.delta;
          else if (ev.type === "tool_call") calls.push(ev.call);
          else if (ev.type === "done" && ev.usage) {
            usage.promptTokens += ev.usage.promptTokens;
            usage.completionTokens += ev.usage.completionTokens;
            const ref = model ?? { provider: "mistral", model: "unknown" };
            const costUsd = budget.addUsage(ref, ev.usage);
            audit?.append({
              type: "model_request",
              step,
              role,
              provider: ref.provider,
              model: ref.model,
              promptTokens: ev.usage.promptTokens,
              completionTokens: ev.usage.completionTokens,
              costUsd,
              ...(lastCheckpoint ? { checkpoint: lastCheckpoint } : {}),
            });
          }
        }
        if (opts.session?.state === "RATE_LIMITED") opts.session.resume("provider answered");
        return { text, calls };
      } catch (err) {
        if (signal.aborted || isAbortError(err)) throw err;
        if (!(err instanceof RateLimitedError || err instanceof ProviderUnavailableError)) throw err;
        const hinted = err instanceof RateLimitedError ? err.retryAfterMs : undefined;
        const wait = Math.max(250, hinted ?? Math.min(60_000, 2_000 * 2 ** attempt));
        attempt++;
        if (providerWaitedMs + wait > maxProviderWait) throw new ProviderExhaustedError(err.message);
        providerWaitedMs += wait;
        const reason = `${err.name}: ${err.message.slice(0, 200)}`;
        opts.session?.rateLimited(Date.now() + wait, reason);
        audit?.append({ type: "rate_limited", step, waitMs: wait, reason });
        emit("rate_limited", step, `all models for ${role} unavailable; pausing ${(wait / 1000).toFixed(1)}s (${reason})`, {
          waitMs: wait,
          resumeAt: Date.now() + wait,
        });
        // The turn being built is discarded: history still ends at the last boundary.
        await sleep(wait, signal);
        emit("resumed", step, "retrying the same turn");
      }
    }
  };

  try {
    while (step < maxSteps) {
      throwIfAborted(opts.signal);
      step++;
      budget.addStep();
      emit("step", step, `step ${step}/${maxSteps}`, { step, maxSteps });
      if (opts.checkpoints) {
        const c = await opts.checkpoints.manager.create(opts.checkpoints.runId, step);
        checkpointedStep = step;
        lastCheckpoint = c.sha;
        audit?.append({ type: "checkpoint", step, ref: c.ref, sha: c.sha });
        emit("checkpoint", step, `checkpoint ${c.ref} ${c.sha.slice(0, 8)}`, c);
      }

      // Per-step wall clock: its own abort, distinct from the human's interrupt.
      // It starts once the model has answered, so waiting out a rate limit never counts against it.
      const stepCtl = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const clock = {
        start: () => {
          timer = setTimeout(() => stepCtl.abort(new StepTimeoutError(`step ${step} exceeded ${stepTimeoutMs / 1000}s`)), stepTimeoutMs);
        },
        stop: () => clearTimeout(timer),
      };
      const signal = AbortSignal.any([opts.signal, stepCtl.signal]);
      const ctx: ToolContext = { ...opts.ctx, signal };
      let outcome: RunResult | "continue";
      try {
        outcome = await runStep(signal, ctx, clock);
      } catch (err) {
        if (opts.signal.aborted || !stepCtl.signal.aborted) throw err;
        // Wall-clock budget hit: undo the step and tell the model, then carry on.
        const rw = await rewindStep(step);
        const msg = `Step ${step} ran past its ${stepTimeoutMs / 1000}s wall-clock budget and was stopped` +
          (rw ? `; its file changes were rewound.` : ".") + " Take a smaller step, or use start_background for long-running processes.";
        emit("step_timeout", step, msg);
        commit([{ role: "user", content: msg }]);
        continue;
      } finally {
        clock.stop();
      }
      if (outcome !== "continue") return outcome;
    }
    return result("budget", `Step budget (${maxSteps}) used up before the goal was verified.`, step);
  } catch (err) {
    if (err instanceof ProviderExhaustedError) {
      return result("unavailable", `Paused for rate limits and outages longer than the ${maxProviderWait / 60_000} min wait budget. Last error: ${err.message}. History is intact; the run can be resumed.`, step);
    }
    if (isAbortError(err) || opts.signal.aborted) {
      // Processes first, so nothing writes to the tree while it is being rewound.
      await stopBackground(opts, emit, step);
      const r = result("aborted", `Interrupted during step ${step}. History kept up to the last complete turn.`, step);
      const rw = await rewindStep(step);
      if (rw) {
        r.rewound = rw;
        r.summary += ` Workspace rewound to the start of step ${step} (${rw.restored.length} restored, ${rw.removed.length} removed; undo: ${rw.undoRef}).`;
      }
      return r;
    }
    throw err;
  } finally {
    await stopBackground(opts, emit, step);
  }

  async function runStep(signal: AbortSignal, ctx: ToolContext, clock: { start(): void; stop(): void }): Promise<RunResult | "continue"> {
    // ---- model turn --------------------------------------------------
    const { text, calls } = await modelTurn(signal);
    throwIfAborted(signal);
    clock.start();
    if (text.trim()) emit("narration", step, text.trim());

    const over = budget.exceeded();
    // The turn is staged and only committed once every call has its result.
    const turn: ChatMessage[] = [{ role: "assistant", content: text || null, toolCalls: calls.length ? calls : undefined }];

    if (calls.length === 0) {
      idleTurns++;
      if (idleTurns > maxIdle) {
        commit(turn);
        return result("stalled", text.trim() || "The model stopped calling tools without finishing.", step);
      }
      turn.push({ role: "user", content: "Continue by calling a tool. If the goal is verified or you are blocked, call finish." });
      commit(turn);
      if (over) return result("budget", `Halted: ${over}.`, step);
      return "continue";
    }
    idleTurns = 0;

    // ---- tool calls --------------------------------------------------
    let finished: ToolResult["finished"];
    let malformedThisStep = 0;
    let stuck: string | undefined;
    for (const call of calls) {
      const r = await executeCall(call, tools, ctx, opts.hooks, step);
      if (r.malformed) {
        malformedCalls++;
        malformedThisStep++;
      }
      emit("tool_call", step, `${call.name} ${abbreviate(call.arguments)}`, { id: call.id, name: call.name, arguments: call.arguments });
      emit("tool_result", step, `${r.result.isError ? "ERROR " : ""}${abbreviate(r.result.content, 300)}`, {
        id: call.id,
        isError: !!r.result.isError,
      });
      audit?.append({
        type: "tool_call",
        step,
        tool: call.name,
        args: call.arguments,
        isError: !!r.result.isError,
        malformed: r.malformed,
        output: r.result.content,
      });
      turn.push({ role: "tool", toolCallId: call.id, content: r.result.content });
      if (r.result.finished) finished = r.result.finished;
      if (r.result.isError && !r.malformed) {
        const n = repeats.record(r.result.content);
        if (n === 2) autonomy.downgrade(`the same error hash appeared twice (${call.name})`);
        if (n >= maxRepeated) stuck = r.result.content;
      }
    }
    commit(turn); // turn boundary
    clock.stop();

    if (malformedThisStep > 2) autonomy.downgrade(`${malformedThisStep} malformed tool calls in step ${step}`);
    const snap = budget.snapshot();
    const progress = ctx.plan?.progress();
    if (!budgetTriggerFired && snap.used > 0.7 && progress !== undefined && progress < 0.5) {
      budgetTriggerFired = true;
      autonomy.downgrade(`${Math.round(snap.used * 100)}% of the budget used with ${Math.round(progress * 100)}% of the plan done`);
    }
    emit("budget", step, `$${snap.costUsd.toFixed(4)} · ${snap.tokens} tokens · step ${snap.steps}/${maxSteps}`, snap);

    if (finished) {
      if (finished.outcome === "done" && opts.hooks?.beforeFinish) {
        const v = await opts.hooks.beforeFinish({ summary: finished.summary, step }, opts.signal);
        if (v.action === "accept") return result("done", v.summary ?? finished.summary, step);
        if (v.action === "fail") return result("failed", v.summary, step);
        commit([{ role: "user", content: v.feedback }]);
        return "continue";
      }
      return result(finished.outcome, finished.summary, step);
    }
    if (stuck) return result("stuck", `Same error ${maxRepeated} times; escalating instead of retrying:\n${abbreviate(stuck, 600)}`, step);
    if (malformedThisStep >= maxMalformed) {
      return result("confused", `${malformedThisStep} malformed tool calls in one step; stopping for review.`, step);
    }
    if (over) return result("budget", `Halted: ${over}.`, step);
    if (!(await ctx.gate.confirmStep(step, abbreviate(text || calls.map((c) => c.name).join(", "), 200), opts.signal))) {
      return result("blocked", `Stopped by the human after step ${step} (autonomy level 2: step mode).`, step);
    }
    return "continue";
  }
}

class ProviderExhaustedError extends Error {
  override name = "ProviderExhaustedError";
}

async function stopBackground(opts: RunOptions, emit: (t: AgentEventType, s: number, x: string) => void, step: number) {
  const reports = await opts.ctx.background.stopAll();
  const survivors = reports.flatMap((r) => r.survivors);
  if (survivors.length) emit("note", step, `WARNING: background PIDs survived shutdown: ${survivors.join(", ")}`);
}

async function executeCall(
  call: ToolCall,
  tools: Map<string, Tool>,
  ctx: ToolContext,
  hooks: LoopHooks | undefined,
  step: number,
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
    // The single chokepoint (spec §8 invariant 3): nothing runs without passing the gate.
    const decision = await ctx.gate.authorize(tool, parsed.data, ctx.signal);
    let result: ToolResult = decision.allow ? await tool.run(parsed.data, ctx) : { isError: true, content: decision.reason };
    const note = decision.allow ? hooks?.toolNote?.(tool.name, parsed.data) : undefined;
    if (note) result = { ...result, content: `${result.content}\n[memory] ${note}` };
    hooks?.afterTool?.(tool.name, parsed.data, result, step);
    return { malformed: false, result };
  } catch (err) {
    if (isAbortError(err) || ctx.signal.aborted) throw err instanceof AbortedError ? err : new AbortedError(ctx.signal.reason);
    return { malformed: false, result: { isError: true, content: `${(err as Error).name}: ${(err as Error).message}` } };
  }
}

function abbreviate(s: string, max = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
