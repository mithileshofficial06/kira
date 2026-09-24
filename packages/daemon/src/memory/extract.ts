/**
 * What a finished run leaves in memory: an episode, procedural lessons, and
 * (gated) ADRs.
 *
 * ADR noise control (spec §4.4): an ADR is written only when (a) a human made
 * a decision, (b) an alternative was tried and rejected, or (c) a gate forced
 * a design change. Everything else stays episodic. Extraction runs on the cheap
 * utility model when there is one; otherwise a deterministic extractor records
 * the human decisions verbatim. Extracted ADRs are marked for review so the
 * Flight Deck can reject them in one click.
 */
import type { ChatFn } from "../agent/loop.js";
import { parseToolArgs } from "../agent/json-repair.js";
import type { RunReport } from "../control/events.js";
import type { ChatMessage } from "../providers/types.js";
import type { AdrInput } from "./store.js";

export interface AdrTrigger {
  kind: "human-decision" | "alternative-rejected" | "gate-forced-change";
  detail: string;
}

export function adrTriggers(report: RunReport): AdrTrigger[] {
  const out: AdrTrigger[] = [];
  for (const d of report.decisions) {
    if (!d.allow || d.note) {
      out.push({ kind: "human-decision", detail: `${d.allow ? "allowed" : "declined"} ${d.category}: ${d.summary}${d.note ? ` — "${d.note}"` : ""}` });
    }
  }
  const v = report.verification;
  if (v && v.round > 1 && v.passed) {
    out.push({ kind: "gate-forced-change", detail: `verification failed ${v.round - 1} time(s) before passing; final: ${v.summary}` });
  }
  if (v && !v.passed) {
    out.push({ kind: "alternative-rejected", detail: `the approach failed verification: ${v.summary}` });
  }
  return out;
}

/** Files the run wrote, from its committed tool calls. */
export function filesWritten(transcript: readonly ChatMessage[]): string[] {
  const files = new Set<string>();
  for (const m of transcript) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const c of m.toolCalls) {
      if (c.name !== "write_file") continue;
      const a = parseToolArgs(c.arguments) as { path?: unknown } | undefined;
      if (typeof a?.path === "string") files.add(a.path.replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  }
  return [...files];
}

export async function extractAdrs(
  report: RunReport,
  transcript: readonly ChatMessage[],
  utility: ChatFn | undefined,
  signal: AbortSignal,
): Promise<AdrInput[]> {
  const triggers = adrTriggers(report);
  if (triggers.length === 0) return [];
  const files = filesWritten(transcript);
  if (utility) {
    try {
      const fromModel = await modelExtract(report, triggers, files, utility, signal);
      if (fromModel) return fromModel;
    } catch (err) {
      if (signal.aborted) throw err;
      // fall through to the deterministic extractor
    }
  }
  return deterministicAdrs(report, files);
}

/** Human decisions become ADRs as the human put them: no paraphrase, no invention. */
export function deterministicAdrs(report: RunReport, files: string[] = []): AdrInput[] {
  const out: AdrInput[] = [];
  for (const d of report.decisions) {
    if (d.allow && !d.note) continue;
    const action = `${d.category} \`${d.summary.split("\n")[0]!.slice(0, 160)}\``;
    out.push({
      title: d.note ? firstSentence(d.note) : `Do not ${d.category.replace(/-/g, " ")}: ${d.summary.slice(0, 80)}`,
      decision: d.note ? `${d.note} (${d.allow ? "allowed" : "declined"} ${action})` : `Declined ${action}.`,
      context: `While working on "${report.goal}", the agent asked to ${action}.`,
      alternativesRejected: d.allow ? [] : [action],
      consequences: [],
      decidedBy: "user",
      files,
      runId: report.runId,
      review: "pending",
    });
  }
  return out;
}

async function modelExtract(
  report: RunReport,
  triggers: AdrTrigger[],
  files: string[],
  chat: ChatFn,
  signal: AbortSignal,
): Promise<AdrInput[] | undefined> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You maintain a project's decision journal. From the run digest, write architecture decision records ONLY for: " +
        "(a) decisions a human made, (b) alternatives actually tried and rejected, (c) design changes forced by a failed check. " +
        "Never invent decisions. Keep the human's own words for the decision. Reply with ONLY JSON: " +
        '{"adrs":[{"title":"short statement of the decision","decision":"...","context":"...","alternativesRejected":["..."],' +
        '"consequences":["..."],"decidedBy":"user"|"verification"}]}. An empty list is fine.',
    },
    {
      role: "user",
      content: [
        `Goal: ${report.goal}`,
        `Outcome: ${report.status}: ${report.summary.slice(0, 1_500)}`,
        `Triggers:\n${triggers.map((t) => `- ${t.kind}: ${t.detail}`).join("\n")}`,
        `Files written: ${files.join(", ") || "none"}`,
      ].join("\n\n"),
    },
  ];
  let text = "";
  for await (const ev of chat({ messages, temperature: 0 }, signal)) if (ev.type === "text") text += ev.delta;
  const json = parseToolArgs(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { adrs?: unknown } | undefined;
  if (!json || !Array.isArray(json.adrs)) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  return json.adrs
    .map((a: Record<string, unknown>) => ({
      title: str(a.title),
      decision: str(a.decision),
      context: str(a.context) || `While working on "${report.goal}".`,
      alternativesRejected: list(a.alternativesRejected),
      consequences: list(a.consequences),
      decidedBy: str(a.decidedBy) || "user",
      files,
      runId: report.runId,
      review: "pending" as const,
    }))
    .filter((a) => a.title && a.decision);
}

function firstSentence(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  const m = t.match(/^(.{8,140}?[.!?])(\s|$)/);
  return (m ? m[1]! : t.slice(0, 140)).replace(/[.!?]$/, "");
}

// ---- procedural lessons ---------------------------------------------------------

/**
 * A command's signature: the program and its first non-flag word ("npm ci",
 * "npm install", "git push"). Lessons are matched on it before a call runs.
 */
export function commandSignature(command: string): string {
  // Quote-aware split, so "C:\Program Files\nodejs\npm.cmd" stays one word.
  const words = (command.toLowerCase().match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((w) => w.replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((w) => w.replace(/^.*[\\/]/, "").replace(/\.(cmd|exe|bat)$/, ""));
  const program = words[0] ?? "";
  const sub = words.slice(1).find((w) => !w.startsWith("-") && !/^\d/.test(w));
  return sub && /^[a-z][\w:-]*$/.test(sub) ? `${program} ${sub}` : program;
}

export interface Lesson {
  signature: string;
  failed: string;
  ok: string;
  error: string;
}

/** A command that failed, then a different command with the same signature that worked. */
export function learnLessons(transcript: readonly ChatMessage[]): Lesson[] {
  const results = new Map<string, string>();
  for (const m of transcript) if (m.role === "tool") results.set(m.toolCallId, m.content);
  const lastFailure = new Map<string, { command: string; error: string }>();
  const out: Lesson[] = [];
  for (const m of transcript) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const c of m.toolCalls) {
      if (c.name !== "run_command") continue;
      const a = parseToolArgs(c.arguments) as { command?: unknown } | undefined;
      const result = results.get(c.id);
      if (typeof a?.command !== "string" || result === undefined) continue;
      const sig = commandSignature(a.command);
      if (/^exit code 0\b/.test(result)) {
        const f = lastFailure.get(sig);
        if (f && f.command.trim() !== a.command.trim() && !out.some((l) => l.signature === sig && l.ok === a.command)) {
          out.push({ signature: sig, failed: f.command, ok: a.command, error: f.error });
        }
        lastFailure.delete(sig);
      } else if (/^(exit code [1-9-]|TIMED OUT)/.test(result)) {
        const error = result.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).find((l) => /err|fail|not found|denied|cannot|unable/i.test(l)) ??
          result.split("\n")[0]!;
        lastFailure.set(sig, { command: a.command, error: error.slice(0, 200) });
      }
    }
  }
  return out;
}
