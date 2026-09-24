/**
 * Everything a run tells the outside world: the Flight Deck, the spike CLI and
 * the audit trail all consume this one stream. Types only, so the webview can
 * import it without pulling in Node modules.
 */
import type { AgentEvent, RunStatus } from "../agent/loop.js";
import type { GateDecisionRecord, GateRequest } from "../tools/gate.js";
import type { LadderReport } from "../verify/types.js";
import type { BudgetSnapshot } from "./budget.js";
import type { PlanStep } from "./plan.js";
import type { SessionState } from "./session.js";

export interface RunReport {
  runId: string;
  goal: string;
  status: RunStatus;
  summary: string;
  steps: number;
  durationMs: number;
  /** "provider/model" per role, in order of first use. */
  models: string[];
  fallbacks: number;
  rateLimitPauses: number;
  budget: BudgetSnapshot;
  malformedCalls: number;
  autonomy: { start: number; end: number; downgrades: { from: number; to: number; reason: string }[] };
  decisions: GateDecisionRecord[];
  /** Approved actions that rewind cannot undo (spec §4.1). */
  sideEffects: string[];
  verification?: LadderReport;
  /** Open critic concerns or queued questions. */
  openQuestions: string[];
  rewound?: { step: number; restored: string[]; removed: string[]; undoRef: string };
  runDir?: string;
}

export interface MemoryItemRef {
  id: number;
  kind: string;
  title: string;
}

export type KiraEvent =
  | { type: "run_started"; runId: string; goal: string; workspace: string; autonomy: number; at: string }
  | { type: "state"; state: SessionState; detail?: string; resumeAt?: number }
  | { type: "agent"; event: AgentEvent }
  | { type: "plan"; steps: PlanStep[]; scope?: string[] }
  | { type: "terminal"; id: string; data: string }
  | { type: "diff"; step: number; patch: string; files: { status: string; path: string }[] }
  | { type: "approval"; id: string; request: GateRequest }
  | { type: "approval_resolved"; id: string; allow: boolean; note?: string }
  | { type: "decision"; record: GateDecisionRecord }
  | { type: "autonomy"; level: number; reason?: string }
  | { type: "verification"; report: LadderReport }
  | { type: "memory"; items: MemoryItemRef[]; note?: string }
  | { type: "report"; report: RunReport };
