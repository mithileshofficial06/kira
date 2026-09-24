/**
 * Turns run events into short spoken lines. Kira speaks rarely: when it needs
 * the human (an approval), when something objective changed (autonomy lowered,
 * a long rate-limit pause), and when the run ends.
 */
import type { KiraEvent } from "../control/events.js";
import type { DeckState } from "../daemon/deck.js";

const LEVELS = ["observe", "propose", "step", "run", "trust"];

export function narrate(e: KiraEvent, deck: DeckState, now = Date.now()): string | undefined {
  switch (e.type) {
    case "approval":
      return `I need your OK to ${e.request.category.replace(/-/g, " ")}: ${speakCommand(e.request.summary)}. Say yes or no.`;
    case "autonomy":
      return `Heads up: I've lowered my autonomy to ${LEVELS[e.level] ?? e.level}, because ${firstClause(e.reason ?? "something went wrong")}.`;
    case "state":
      if (e.state === "RATE_LIMITED" && e.resumeAt && e.resumeAt - now > 20_000) {
        return `The model provider is throttling me. Pausing for about ${Math.round((e.resumeAt - now) / 1000)} seconds.`;
      }
      return undefined;
    case "report": {
      const r = e.report;
      const first = firstSentence(r.summary);
      switch (r.status) {
        case "done": {
          const n = r.openQuestions.length;
          return `Done. ${first}${n ? ` ${n === 1 ? "One open concern" : `${n} open concerns`} in the report.` : ""}`;
        }
        case "aborted":
          return r.rewound ? `Stopped. I rolled back step ${r.rewound.step}, and nothing is left running.` : "Stopped. Nothing is left running.";
        case "blocked":
          return `I'm blocked. ${first}`;
        default:
          return `I couldn't finish. ${first}`;
      }
    }
    default:
      return undefined;
  }
}

/** A spoken status line for "Kira, status". */
export function statusLine(deck: DeckState): string {
  if (!deck.run || deck.report || deck.run.state === "IDLE") return "Nothing is running.";
  const done = deck.plan.filter((p) => p.status === "done" || p.status === "skipped").length;
  const active = deck.plan.find((p) => p.status === "active");
  const step = deck.steps.at(-1)?.n;
  const parts = [`I'm ${deck.run.state.toLowerCase().replace("_", " ")}${step ? `, on step ${step}` : ""}.`];
  if (deck.plan.length) parts.push(`${done} of ${deck.plan.length} plan steps done${active ? `; now: ${active.title}` : ""}.`);
  return parts.join(" ");
}

export function firstSentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{10,220}?[.!?])(\s|$)/);
  return m ? m[1]! : t.slice(0, 220);
}

function firstClause(s: string): string {
  return s.replace(/\s+/g, " ").trim().split(/[:;(]/)[0]!.slice(0, 140);
}

/** Commands read aloud: drop paths and flags that are noise when spoken. */
function speakCommand(cmd: string): string {
  return cmd
    .split("\n")[0]!
    .replace(/"[^"]*[\\/][^"]*"/g, "a file")
    .replace(/\s--?[\w-]+(=\S+)?/g, "")
    .slice(0, 120)
    .trim();
}
