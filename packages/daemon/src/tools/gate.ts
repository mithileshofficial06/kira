/**
 * The autonomy gate: the single chokepoint every tool call passes through
 * before it runs (spec §8, invariant 3). Phase 0 implements the hard gates and
 * the credential deny rule; autonomy levels and scope tracking arrive in Phase 1.
 */

export type GateDecision = { allow: true } | { allow: false; reason: string };

export interface GateRequest {
  tool: string;
  /** One-line description of the action, shown to the human. */
  summary: string;
  /** Why this is gated. */
  category: HardGateCategory;
}

export type HardGateCategory =
  | "dependency-install"
  | "remote-code"
  | "network-write"
  | "destructive"
  | "force"
  | "migration"
  | "outside-repo";

/** Asks the human. Resolves true to allow. Must honour the signal. */
export type Approver = (req: GateRequest, signal: AbortSignal) => Promise<boolean>;

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

export class Gate {
  constructor(private readonly approver: Approver) {}

  async checkCommand(tool: string, command: string, signal: AbortSignal): Promise<GateDecision> {
    const c = classifyCommand(command);
    if (c.denied) return { allow: false, reason: `Refused: this command ${c.denied}.` };
    if (!c.gated) return { allow: true };
    const ok = await this.approver({ tool, summary: command, category: c.gated }, signal);
    return ok ? { allow: true } : { allow: false, reason: `The human declined this ${c.gated} action.` };
  }
}
