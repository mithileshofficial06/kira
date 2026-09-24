import type { ModelRef, Price } from "../config/models.js";
import type { Usage } from "../providers/types.js";

export interface BudgetLimits {
  /** Model turns per run (spec §6.3, default 40). */
  maxSteps: number;
  /** Prompt + completion tokens per run. */
  maxTokens: number;
  /** USD per run. The run halts when it is reached. */
  maxCostUsd: number;
}

export const DEFAULT_LIMITS: BudgetLimits = { maxSteps: 40, maxTokens: 2_000_000, maxCostUsd: 2 };

export interface BudgetSnapshot {
  steps: number;
  tokens: number;
  costUsd: number;
  limits: BudgetLimits;
  /** Largest fraction used across steps, tokens and cost (0..1+). */
  used: number;
  /** Models that ran with no price configured, so the cost above undercounts. */
  unpriced: string[];
}

/** Tracks spend per run and says when to halt (spec §6.3, §14). */
export class Budget {
  readonly limits: BudgetLimits;
  private steps = 0;
  private tokens = 0;
  private cost = 0;
  private readonly unpriced = new Set<string>();

  constructor(
    limits: Partial<BudgetLimits> = {},
    private readonly pricing: Record<string, Price> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Cost of one call, in USD. */
  price(model: ModelRef, usage: Usage): number {
    const p = this.pricing[`${model.provider}:${model.model}`];
    if (!p) {
      this.unpriced.add(`${model.provider}/${model.model}`);
      return 0;
    }
    return (usage.promptTokens * p.inputPerM + usage.completionTokens * p.outputPerM) / 1_000_000;
  }

  /** Records one model call and returns its cost. */
  addUsage(model: ModelRef, usage: Usage): number {
    const c = this.price(model, usage);
    this.tokens += usage.promptTokens + usage.completionTokens;
    this.cost += c;
    return c;
  }

  addStep(): void {
    this.steps++;
  }

  snapshot(): BudgetSnapshot {
    const l = this.limits;
    return {
      steps: this.steps,
      tokens: this.tokens,
      costUsd: this.cost,
      limits: l,
      used: Math.max(this.steps / l.maxSteps, this.tokens / l.maxTokens, this.cost / l.maxCostUsd),
      unpriced: [...this.unpriced],
    };
  }

  /** A reason to halt, or undefined. Steps are checked by the loop itself. */
  exceeded(): string | undefined {
    if (this.cost >= this.limits.maxCostUsd) return `cost budget reached ($${this.cost.toFixed(4)} of $${this.limits.maxCostUsd})`;
    if (this.tokens >= this.limits.maxTokens) return `token budget reached (${this.tokens} of ${this.limits.maxTokens})`;
    return undefined;
  }
}
