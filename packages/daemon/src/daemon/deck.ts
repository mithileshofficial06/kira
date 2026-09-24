/**
 * Flight Deck state: everything the panel shows, rebuilt from the event
 * stream by one pure reducer. The daemon keeps a copy (for reconnecting
 * panels); the webview runs the same reducer. No Node imports: this file is
 * bundled into the browser.
 */
import type { AgentEvent } from "../agent/loop.js";
import type { BudgetSnapshot } from "../control/budget.js";
import type { KiraEvent, MemoryItemRef, RunReport } from "../control/events.js";
import type { PlanStep } from "../control/plan.js";
import type { SessionState } from "../control/session.js";
import type { GateDecisionRecord, GateRequest } from "../tools/gate.js";
import type { LadderReport } from "../verify/types.js";

export interface DeckCall {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
}

export interface DeckStep {
  n: number;
  model?: string;
  narration: string[];
  calls: DeckCall[];
  checkpoint?: string;
  notes: string[];
}

export interface DeckApproval {
  id: string;
  request: GateRequest;
  resolved?: { allow: boolean; note?: string };
}

export interface DeckState {
  run?: {
    runId: string;
    goal: string;
    workspace: string;
    startedAt: string;
    autonomy: number;
    state: SessionState;
    detail?: string;
    resumeAt?: number;
  };
  plan: PlanStep[];
  scope?: string[];
  steps: DeckStep[];
  /** Tail of the terminal stream, replayed into xterm when a panel opens mid-run. */
  terminal: string;
  diff?: { step: number; patch: string; files: { status: string; path: string }[] };
  approvals: DeckApproval[];
  decisions: GateDecisionRecord[];
  provider: { model?: string; fallbacks: number; lastFallback?: string; rateLimited?: { until: number; reason: string } };
  budget?: BudgetSnapshot;
  autonomyChanges: { level: number; reason?: string }[];
  verification?: LadderReport;
  memory: MemoryItemRef[];
  report?: RunReport;
}

const TERMINAL_MAX = 200_000;
const RESULT_MAX = 2_000;

export function emptyDeck(): DeckState {
  return { plan: [], steps: [], terminal: "", approvals: [], decisions: [], provider: { fallbacks: 0 }, autonomyChanges: [], memory: [] };
}

/** Applies one event. Returns a new top-level object; untouched branches are shared. */
export function reduceDeck(s: DeckState, e: KiraEvent): DeckState {
  switch (e.type) {
    case "run_started":
      return {
        ...emptyDeck(),
        run: { runId: e.runId, goal: e.goal, workspace: e.workspace, startedAt: e.at, autonomy: e.autonomy, state: "IDLE" },
      };
    case "state":
      if (!s.run) return s;
      return {
        ...s,
        run: { ...s.run, state: e.state, ...(e.detail !== undefined ? { detail: e.detail } : { detail: undefined }), resumeAt: e.resumeAt },
        provider: e.state === "RATE_LIMITED" ? { ...s.provider, rateLimited: { until: e.resumeAt ?? Date.now(), reason: e.detail ?? "" } } : { ...s.provider, rateLimited: undefined },
      };
    case "plan":
      return { ...s, plan: e.steps, ...(e.scope ? { scope: e.scope } : {}) };
    case "terminal": {
      const t = s.terminal + e.data;
      return { ...s, terminal: t.length > TERMINAL_MAX ? t.slice(t.length - TERMINAL_MAX) : t };
    }
    case "diff":
      return { ...s, diff: { step: e.step, patch: e.patch, files: e.files } };
    case "approval":
      return { ...s, approvals: [...s.approvals, { id: e.id, request: e.request }] };
    case "approval_resolved":
      return {
        ...s,
        approvals: s.approvals.map((a) => (a.id === e.id ? { ...a, resolved: { allow: e.allow, ...(e.note ? { note: e.note } : {}) } } : a)),
      };
    case "decision":
      return { ...s, decisions: [...s.decisions, e.record] };
    case "autonomy":
      return { ...s, run: s.run ? { ...s.run, autonomy: e.level } : s.run, autonomyChanges: [...s.autonomyChanges, { level: e.level, reason: e.reason }] };
    case "verification":
      return { ...s, verification: e.report };
    case "memory":
      return { ...s, memory: mergeRefs(s.memory, e.items) };
    case "report":
      return { ...s, report: e.report, approvals: s.approvals.map((a) => a.resolved ? a : { ...a, resolved: { allow: false, note: "run ended" } }) };
    case "agent":
      return reduceAgent(s, e.event);
  }
}

function reduceAgent(s: DeckState, e: AgentEvent): DeckState {
  if (e.type === "budget") return { ...s, budget: e.data as BudgetSnapshot };
  if (e.type === "fallback") return { ...s, provider: { ...s.provider, fallbacks: s.provider.fallbacks + 1, lastFallback: e.text } };
  if (e.type === "model") return withStep({ ...s, provider: { ...s.provider, model: e.text } }, e.step, (st) => ({ ...st, model: e.text }));
  if (e.type === "step") return e.step > 0 && !s.steps.some((x) => x.n === e.step) ? { ...s, steps: [...s.steps, newStep(e.step)] } : s;
  if (e.step === 0) return s; // run-level notes (tool logs) are shown in the terminal, not the timeline
  return withStep(s, e.step, (st) => {
    switch (e.type) {
      case "narration":
        return { ...st, narration: [...st.narration, e.text] };
      case "checkpoint":
        return { ...st, checkpoint: e.text };
      case "tool_call": {
        const d = e.data as { id: string; name: string; arguments: string } | undefined;
        return { ...st, calls: [...st.calls, { id: d?.id ?? String(st.calls.length), name: d?.name ?? e.text.split(" ")[0]!, args: d?.arguments ?? e.text }] };
      }
      case "tool_result": {
        const d = e.data as { id: string; isError: boolean } | undefined;
        const text = e.text.slice(0, RESULT_MAX);
        return {
          ...st,
          calls: st.calls.map((c) => (c.id === d?.id || (!d && c.result === undefined) ? { ...c, result: text, isError: d?.isError ?? text.startsWith("ERROR") } : c)),
        };
      }
      default:
        return { ...st, notes: [...st.notes, e.text].slice(-20) };
    }
  });
}

function newStep(n: number): DeckStep {
  return { n, narration: [], calls: [], notes: [] };
}

function withStep(s: DeckState, n: number, f: (st: DeckStep) => DeckStep): DeckState {
  if (n <= 0) return s;
  const i = s.steps.findIndex((x) => x.n === n);
  const steps = [...s.steps];
  if (i < 0) steps.push(f(newStep(n)));
  else steps[i] = f(steps[i]!);
  return { ...s, steps };
}

function mergeRefs(a: MemoryItemRef[], b: MemoryItemRef[]): MemoryItemRef[] {
  const seen = new Set(a.map((x) => x.id));
  return [...a, ...b.filter((x) => !seen.has(x.id))];
}

/** Open approvals, oldest first: what the human is being asked right now. */
export function pendingApprovals(s: DeckState): DeckApproval[] {
  return s.approvals.filter((a) => !a.resolved);
}
