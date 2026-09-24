/**
 * Conversation: what Kira says to a sentence that is not a control phrase and
 * does not start like work ("are you listening?", "what can you do?", "I need
 * a login page"). The utility model either answers out loud or, when the
 * human is asking for work in other words, turns it into a task.
 */
import { basename } from "node:path";
import type { ChatFn } from "../agent/loop.js";
import type { ChatMessage } from "../providers/types.js";
import type { DeckState } from "../daemon/deck.js";
import { statusLine } from "./narrator.js";

export type ConverseResult = { reply: string } | { task: string };

export const FALLBACK_REPLY = "I'm here and listening. Tell me what to build or fix, for example: build a to-do app.";
const TIMEOUT_MS = 20_000;
const HISTORY = 8;

export class Conversation {
  private readonly history: ChatMessage[] = [];

  constructor(
    private readonly chat: ChatFn | undefined,
    private readonly workspace: string,
  ) {}

  async respond(text: string, deck: DeckState, signal?: AbortSignal): Promise<ConverseResult> {
    if (!this.chat) return { reply: FALLBACK_REPLY };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      let out = "";
      for await (const ev of this.chat({ messages: [{ role: "system", content: systemPrompt(this.workspace, deck) }, ...this.history, { role: "user", content: text }], temperature: 0.4, maxTokens: 200 }, ctrl.signal)) {
        if (ev.type === "text") out += ev.delta;
      }
      const r = parse(out);
      this.remember(text, "task" in r ? `(started the task: ${r.task})` : r.reply);
      return r;
    } catch {
      return { reply: FALLBACK_REPLY };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private remember(user: string, assistant: string): void {
    this.history.push({ role: "user", content: user }, { role: "assistant", content: assistant });
    this.history.splice(0, Math.max(0, this.history.length - HISTORY));
  }
}

export function parse(out: string): ConverseResult {
  const t = out.trim();
  const m = t.match(/^\W*TASK\s*:\s*([\s\S]+)$/i);
  if (m) return { task: m[1]!.trim().replace(/[.!\s]+$/, "") };
  // Spoken, so no markdown, and short.
  const reply = t.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  return { reply: reply || FALLBACK_REPLY };
}

function systemPrompt(workspace: string, deck: DeckState): string {
  const last = deck.report ? `The last run ended ${deck.report.status}: ${deck.report.summary.split("\n")[0]!.slice(0, 200)}` : "No run has finished in this session.";
  return [
    `You are the voice of a coding agent that works on the project folder "${basename(workspace)}". The human just spoke to you out loud.`,
    "If they are asking for work on the code, even indirectly (\"I need a login page\", \"the tests are broken\"), reply with exactly one line: TASK: <the goal as a clear instruction>.",
    "Otherwise answer as if speaking: one or two short, friendly sentences, plain words, no markdown, no lists, no code. Never say your own name.",
    "What you can do: build, fix, test and refactor code in this project and check your work; the human can say stop at any time, ask for status, or ask where we left off.",
    `Right now: ${statusLine(deck)} ${last}`,
  ].join("\n");
}
