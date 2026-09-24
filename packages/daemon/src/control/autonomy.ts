/**
 * Autonomy levels (spec §4.5):
 *   0 Observe  reads and answers, no writes or commands
 *   1 Propose  every write and command needs approval
 *   2 Step     runs one step, then waits for the human
 *   3 Run      runs the plan, pauses only at hard gates
 *   4 Trust    as 3, and self-corrects; meant for scratch directories
 */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

export const LEVEL_NAMES: Record<AutonomyLevel, string> = {
  0: "observe",
  1: "propose",
  2: "step",
  3: "run",
  4: "trust",
};

export interface Downgrade {
  from: AutonomyLevel;
  to: AutonomyLevel;
  reason: string;
}

/**
 * The current level, lowered automatically on objective evidence of trouble.
 * Self-reported model confidence is never a trigger. Downgrades never go below
 * 1 (propose): the run keeps going, but every action is seen by a human.
 */
export class Autonomy {
  readonly downgrades: Downgrade[] = [];
  private readonly listeners = new Set<(d: Downgrade) => void>();

  constructor(private current: AutonomyLevel = 3) {}

  get level(): AutonomyLevel {
    return this.current;
  }

  onDowngrade(fn: (d: Downgrade) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Lowers the level by one. Returns false if already at the floor. */
  downgrade(reason: string): boolean {
    if (this.current <= 1) return false;
    const d: Downgrade = { from: this.current, to: (this.current - 1) as AutonomyLevel, reason };
    this.current = d.to;
    this.downgrades.push(d);
    for (const l of this.listeners) l(d);
    return true;
  }
}
