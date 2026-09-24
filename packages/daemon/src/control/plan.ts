export type PlanStepStatus = "pending" | "active" | "done" | "skipped" | "failed";

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
}

/** The plan the executor keeps up to date (via update_plan). Drives the Flight Deck tree and the budget trigger. */
export class PlanTracker {
  private items: PlanStep[] = [];
  private readonly listeners = new Set<(steps: PlanStep[]) => void>();

  constructor(initial: string[] = []) {
    this.items = initial.map((title) => ({ title, status: "pending" }));
  }

  get steps(): readonly PlanStep[] {
    return this.items;
  }

  set(steps: PlanStep[]): void {
    this.items = steps.map((s) => ({ ...s }));
    for (const l of this.listeners) l(this.items);
  }

  onChange(fn: (steps: PlanStep[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fraction of steps done or skipped. With no plan, undefined (the budget trigger then stays quiet). */
  progress(): number | undefined {
    if (this.items.length === 0) return undefined;
    return this.items.filter((s) => s.status === "done" || s.status === "skipped").length / this.items.length;
  }
}
