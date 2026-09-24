import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AuditEntry =
  | { type: "run_start"; goal: string; autonomy: number }
  | { type: "state"; from: string; to: string; detail?: string }
  | { type: "checkpoint"; step: number; ref: string; sha: string }
  | {
      type: "model_request";
      step: number;
      role: string;
      provider: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      checkpoint?: string;
    }
  | { type: "fallback"; step: number; from: string; reason: string }
  | { type: "rate_limited"; step: number; waitMs: number; reason: string }
  | { type: "tool_call"; step: number; tool: string; args: string; isError: boolean; malformed: boolean; output: string }
  | { type: "gate"; tool: string; category: string; summary: string; allow: boolean; note?: string }
  | { type: "downgrade"; from: number; to: number; reason: string }
  | { type: "verification"; round: number; passed: boolean; summary: string }
  | { type: "run_end"; status: string; summary: string; costUsd: number; tokens: number };

export type AuditRecord = AuditEntry & { ts: string; seq: number };

/**
 * Append-only JSONL log of every tool call and model request (spec §13).
 * Writes are synchronous so the log is on disk before the next side effect.
 * Holds full tool output: the model only ever sees a truncated version.
 */
export class AuditLog {
  private seq = 0;

  constructor(readonly file: string | undefined) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  static forRun(runDir: string): AuditLog {
    return new AuditLog(join(runDir, "audit.jsonl"));
  }

  append(entry: AuditEntry): void {
    if (!this.file) return;
    const rec: AuditRecord = { ts: new Date().toISOString(), seq: ++this.seq, ...entry };
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
  }

  static read(file: string): AuditRecord[] {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRecord);
  }
}
