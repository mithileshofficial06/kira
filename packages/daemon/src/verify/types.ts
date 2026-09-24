/** Verification ladder tiers (spec §4.3). */
export type LadderLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";

export interface GateResult {
  level: LadderLevel;
  name: string;
  status: "pass" | "fail" | "skip";
  /** One line for the Flight Deck and the model. */
  summary: string;
  /** Error output or findings (truncated). */
  details?: string;
  durationMs: number;
  /** Files written as evidence (screenshots), workspace-relative or absolute. */
  artifacts?: string[];
}

export interface LadderReport {
  passed: boolean;
  /** 1-based verification round within the run. */
  round: number;
  gates: GateResult[];
  /** Non-blocking critic concerns: the run reports "done, with N open concerns". */
  concerns: string[];
  summary: string;
  /** The same failure hash came back 3 times: stop retrying and hand it to a human. */
  escalate?: boolean;
}
