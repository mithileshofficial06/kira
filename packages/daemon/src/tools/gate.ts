/**
 * The autonomy gate: the single chokepoint every tool call passes through
 * before it runs (spec §8, invariant 3). It applies, in order: the credential
 * deny rules, the autonomy level, the hard gates, and declared-scope tracking.
 * Gates are code, not prompts, so an injected instruction still hits them.
 */
import { Autonomy, LEVEL_NAMES } from "../control/autonomy.js";

export type GateDecision = { allow: true } | { allow: false; reason: string };

/** What a tool does to the world. Decides how each autonomy level treats it. */
export type ToolEffect = "read" | "write" | "exec";

/** "propose": level 1 asks before every write or command. "step": level 2 asks between steps. */
export type GateCategory = HardGateCategory | "propose" | "step";

export interface GateRequest {
  tool: string;
  /** One-line description of the action, shown to the human. */
  summary: string;
  /** Why this is gated. */
  category: GateCategory;
}

/** A human decision. The note ("no, write it by hand") is what memory turns into an ADR. */
export interface GateDecisionRecord extends GateRequest {
  allow: boolean;
  note?: string;
  at: string;
}

export type HardGateCategory =
  | "dependency-install"
  | "remote-code"
  | "network-write"
  | "destructive"
  | "force"
  | "migration"
  | "outside-repo";

export interface ApprovalAnswer {
  allow: boolean;
  /** Optional reason from the human, kept for the decision journal. */
  note?: string;
}

/** Asks the human. Resolves true (or {allow: true}) to allow. Must honour the signal. */
export type Approver = (req: GateRequest, signal: AbortSignal) => Promise<boolean | ApprovalAnswer>;

interface Rule {
  category: HardGateCategory;
  pattern: RegExp;
}

const HARD_GATES: Rule[] = [
  // Order matters: the first match names the category, so the most specific rules go first.
  { category: "outside-repo", pattern: /\b(npm|pnpm)\s+(install|i|add)\b.*\s(-g|--global)\b/i },
  { category: "network-write", pattern: /\bgit\s+push\b/i },
  { category: "force", pattern: /\bgit\b.*\s(--force\b|-f\b|--hard\b)/i },
  { category: "destructive", pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i },
  { category: "destructive", pattern: /\b(rmdir|rd)\s+\/s\b/i },
  { category: "destructive", pattern: /\bdel\s+.*\/s\b/i },
  { category: "destructive", pattern: /\bRemove-Item\b.*-Recurse\b/i },
  { category: "destructive", pattern: /\bgit\s+(clean|branch\s+-D)\b/i },
  // Adding a package. Plain `npm install` / `npm ci` (from the lockfile) is not gated.
  // Flags may come first: `npm i -D vitest`.
  { category: "dependency-install", pattern: /\b(npm|pnpm)\s+(install|i|add)\b(\s+-\S+)*\s+[^-\s&|;]/i },
  { category: "dependency-install", pattern: /\byarn\s+add\b/i },
  { category: "dependency-install", pattern: /\b(pip|pip3|uv\s+pip)\s+install\b/i },
  { category: "remote-code", pattern: /\b(npx|pnpm\s+dlx|npm\s+(create|init|exec)|yarn\s+(create|dlx))\b/i },
  { category: "network-write", pattern: /\b(curl|wget)\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s)/i },
  { category: "network-write", pattern: /\b(Invoke-WebRequest|Invoke-RestMethod)\b.*-Method\s+(Post|Put|Patch|Delete)/i },
  { category: "network-write", pattern: /\b(vercel|netlify|firebase)\s+deploy\b|\bnpm\s+publish\b/i },
  { category: "migration", pattern: /\b(prisma\s+migrate|drizzle-kit\s+(push|migrate)|knex\s+migrate|sequelize\s+db:migrate)\b/i },
  { category: "outside-repo", pattern: /\b(setx|reg\s+add|choco|winget|scoop)\b/i },
];

/** Commands refused outright: they would expose credentials to the model. */
const DENY: RegExp[] = [/\.env\b/i, /\b(printenv|env)\s*$/i, /\bset\s*$/i, /\bGet-ChildItem\s+env:/i];

export function classifyCommand(command: string): { denied?: string; gated?: HardGateCategory } {
  if (DENY.some((r) => r.test(command))) return { denied: "reads credentials or the environment" };
  const hit = HARD_GATES.find((r) => r.pattern.test(command));
  return hit ? { gated: hit.category } : {};
}

export interface GateOptions {
  autonomy?: Autonomy;
  /** Declared file scope of the plan: workspace-relative prefixes ("src/") or globs ("src/**"). */
  scope?: string[];
}

export class Gate {
  readonly autonomy: Autonomy;
  scope: string[] | undefined;
  /** Every question put to the human, with the answer. */
  readonly decisions: GateDecisionRecord[] = [];
  private readonly listeners = new Set<(d: GateDecisionRecord) => void>();
  /** Commands approved at the chokepoint, so the tool's own check does not ask twice. */
  private readonly preApproved = new Map<string, number>();

  constructor(
    private readonly approver: Approver,
    opts: GateOptions = {},
  ) {
    this.autonomy = opts.autonomy ?? new Autonomy(3);
    this.scope = opts.scope;
  }

  onDecision(fn: (d: GateDecisionRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * The chokepoint. Called by the loop for every validated tool call before it runs.
   * `input` is the tool's parsed arguments.
   */
  async authorize(tool: { name: string; effect: ToolEffect }, input: unknown, signal: AbortSignal): Promise<GateDecision> {
    const args = (input ?? {}) as { command?: unknown; path?: unknown };
    const command = typeof args.command === "string" ? args.command : undefined;
    const path = typeof args.path === "string" ? args.path : undefined;
    const level = this.autonomy.level;

    if (command) {
      const c = classifyCommand(command);
      if (c.denied) return { allow: false, reason: `Refused: this command ${c.denied}.` };
    }
    if (tool.effect === "read") return { allow: true };
    if (level === 0) {
      return { allow: false, reason: `Autonomy level 0 (${LEVEL_NAMES[0]}): no writes or commands. Answer from what you can read.` };
    }

    const hard = command ? classifyCommand(command).gated : undefined;
    const summary = command ?? (path ? `${tool.name} ${path}` : tool.name);
    if (hard) {
      const ok = await this.ask({ tool: tool.name, summary, category: hard }, signal);
      if (!ok) return { allow: false, reason: `The human declined this ${hard} action.` };
      const key = `${tool.name}␟${command}`;
      this.preApproved.set(key, (this.preApproved.get(key) ?? 0) + 1);
    } else if (level === 1) {
      const ok = await this.ask({ tool: tool.name, summary, category: "propose" }, signal);
      if (!ok) return { allow: false, reason: "The human declined this action (autonomy level 1: every change is proposed first)." };
    }

    if (tool.effect === "write" && path && this.scope && !inScope(path, this.scope)) {
      this.autonomy.downgrade(`write outside the declared scope: ${path}`);
    }
    return { allow: true };
  }

  /** Hard-gate check used inside command tools. Skips the question if the chokepoint already asked. */
  async checkCommand(tool: string, command: string, signal: AbortSignal): Promise<GateDecision> {
    const c = classifyCommand(command);
    if (c.denied) return { allow: false, reason: `Refused: this command ${c.denied}.` };
    if (!c.gated) return { allow: true };
    const key = `${tool}␟${command}`;
    const n = this.preApproved.get(key) ?? 0;
    if (n > 0) {
      if (n === 1) this.preApproved.delete(key);
      else this.preApproved.set(key, n - 1);
      return { allow: true };
    }
    const ok = await this.ask({ tool, summary: command, category: c.gated }, signal);
    return ok ? { allow: true } : { allow: false, reason: `The human declined this ${c.gated} action.` };
  }

  /** Level 2 (step): asks before starting the next step. Always true at other levels. */
  async confirmStep(step: number, summary: string, signal: AbortSignal): Promise<boolean> {
    if (this.autonomy.level !== 2) return true;
    return this.ask({ tool: "step", summary: `Step ${step} finished: ${summary}. Continue?`, category: "step" }, signal);
  }

  /** Levels 0–1: the plan itself is proposed before anything runs. */
  async confirmPlan(steps: string[], signal: AbortSignal): Promise<boolean> {
    return this.ask({ tool: "plan", summary: steps.map((s, i) => `${i + 1}. ${s}`).join("\n"), category: "propose" }, signal);
  }

  private async ask(req: GateRequest, signal: AbortSignal): Promise<boolean> {
    const raw = await this.approver(req, signal);
    const answer: ApprovalAnswer = typeof raw === "boolean" ? { allow: raw } : raw;
    const rec: GateDecisionRecord = { ...req, allow: answer.allow, at: new Date().toISOString(), ...(answer.note ? { note: answer.note } : {}) };
    this.decisions.push(rec);
    for (const l of this.listeners) l(rec);
    return answer.allow;
  }
}

/** Matches a workspace-relative path against scope entries: plain prefixes or globs with * and **. */
export function inScope(path: string, scope: string[]): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return scope.some((entry) => {
    const e = entry.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!e.includes("*")) return p === e || p.startsWith(e.endsWith("/") ? e : `${e}/`);
    const re = e
      .split("**")
      .map((part) => part.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
      .join(".*");
    return new RegExp(`^${re}$`).test(p);
  });
}
