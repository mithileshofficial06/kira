import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Session states (spec §8). */
export type SessionState =
  | "IDLE"
  | "PLANNING"
  | "AWAITING_APPROVAL"
  | "EXECUTING"
  | "VERIFYING"
  | "REPORTING"
  | "INTERRUPTED"
  | "RATE_LIMITED";

/** Legal moves. INTERRUPTED and RATE_LIMITED are reachable from every state and handled separately. */
const TRANSITIONS: Record<SessionState, SessionState[]> = {
  IDLE: ["PLANNING", "EXECUTING"],
  PLANNING: ["AWAITING_APPROVAL", "EXECUTING", "REPORTING"],
  AWAITING_APPROVAL: ["EXECUTING", "PLANNING", "VERIFYING", "REPORTING"],
  EXECUTING: ["AWAITING_APPROVAL", "VERIFYING", "REPORTING"],
  VERIFYING: ["EXECUTING", "REPORTING"],
  REPORTING: ["IDLE"],
  INTERRUPTED: ["REPORTING", "IDLE"],
  // RATE_LIMITED returns to the state it interrupted (see resume()).
  RATE_LIMITED: [],
};

export interface Transition {
  from: SessionState;
  to: SessionState;
  at: string;
  detail?: string;
}

export interface SessionRecord {
  runId: string;
  goal: string;
  state: SessionState;
  /** The state RATE_LIMITED will return to. */
  resumeTo?: SessionState;
  /** Epoch ms at which a rate-limit pause ends, for the Flight Deck countdown. */
  resumeAt?: number;
  transitions: Transition[];
  updatedAt: string;
}

export class IllegalTransitionError extends Error {
  override name = "IllegalTransitionError";
}

/**
 * The session state machine. Every transition is written to disk (atomically,
 * synchronously) before `to()` returns, so the caller performs side effects
 * only after the new state is durable (spec §8 invariant 1).
 */
export class Session {
  private rec: SessionRecord;
  private readonly listeners = new Set<(t: Transition, rec: SessionRecord) => void>();

  private constructor(
    readonly file: string | undefined,
    rec: SessionRecord,
    private readonly now: () => Date,
  ) {
    this.rec = rec;
  }

  /** A new session in IDLE. `dir` is the run folder; omit it for an in-memory session (tests). */
  static create(runId: string, goal: string, dir?: string, now: () => Date = () => new Date()): Session {
    const s = new Session(dir ? join(dir, "session.json") : undefined, {
      runId,
      goal,
      state: "IDLE",
      transitions: [],
      updatedAt: now().toISOString(),
    }, now);
    s.persist();
    return s;
  }

  /** Loads a persisted session, e.g. after a daemon crash. */
  static load(dir: string, now: () => Date = () => new Date()): Session {
    const file = join(dir, "session.json");
    return new Session(file, JSON.parse(readFileSync(file, "utf8")) as SessionRecord, now);
  }

  get state(): SessionState {
    return this.rec.state;
  }

  get record(): Readonly<SessionRecord> {
    return this.rec;
  }

  /** True when a previous daemon died mid-run: the session was neither idle nor finished reporting. */
  get wasInterruptedByCrash(): boolean {
    return this.rec.state !== "IDLE" && this.rec.state !== "REPORTING";
  }

  onTransition(fn: (t: Transition, rec: SessionRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  canMove(to: SessionState): boolean {
    const from = this.rec.state;
    if (to === "INTERRUPTED" || to === "RATE_LIMITED") return from !== to;
    return TRANSITIONS[from].includes(to);
  }

  /** Moves to `to`, persisting first. Throws on an illegal move. No-op if already there. */
  to(to: SessionState, detail?: string): void {
    if (this.rec.state === to) return;
    if (!this.canMove(to)) throw new IllegalTransitionError(`${this.rec.state} -> ${to} is not a legal transition`);
    const from = this.rec.state;
    if (to === "RATE_LIMITED") this.rec.resumeTo = from;
    this.apply(from, to, detail);
  }

  /** Enters RATE_LIMITED until `resumeAt`. */
  rateLimited(resumeAt: number, detail?: string): void {
    this.rec.resumeAt = resumeAt;
    if (this.rec.state === "RATE_LIMITED") {
      this.persist();
      return;
    }
    this.to("RATE_LIMITED", detail);
  }

  /** Leaves RATE_LIMITED for the state it interrupted. */
  resume(detail?: string): void {
    if (this.rec.state !== "RATE_LIMITED") return;
    const back = this.rec.resumeTo ?? "EXECUTING";
    this.rec.resumeTo = undefined;
    this.rec.resumeAt = undefined;
    this.apply("RATE_LIMITED", back, detail);
  }

  private apply(from: SessionState, to: SessionState, detail?: string): void {
    const t: Transition = { from, to, at: this.now().toISOString(), ...(detail ? { detail } : {}) };
    this.rec.state = to;
    this.rec.transitions.push(t);
    this.persist();
    for (const l of this.listeners) l(t, this.rec);
  }

  private persist(): void {
    this.rec.updatedAt = this.now().toISOString();
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.rec, null, 2));
    renameSync(tmp, this.file);
  }
}
