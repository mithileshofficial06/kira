/**
 * What a spoken sentence means to Kira. Deliberately small and predictable:
 * control phrases first, then a sentence that starts like work ("build...",
 * "can you fix...") is a task; anything else is conversation, which a model
 * answers (and may still turn into a task, see converse.ts). Voice input is lossy
 * (spec R11), so a spoken goal is echoed as the run's goal in the Flight Deck,
 * and gated tools still need an explicit approval.
 */
export type Intent =
  | { kind: "stop" }
  | { kind: "left_off" }
  | { kind: "status" }
  | { kind: "approve"; allow: boolean; note?: string }
  | { kind: "task"; goal: string }
  | { kind: "chat"; text: string }
  | { kind: "busy"; text: string }
  | { kind: "nothing" };

const STOP = /^\W*(?:please\W+)?(stop|cancel|abort|halt|hold on|wait|pause|enough|kill it|freeze)\b/i;
const LEFT_OFF = /\b(where (did|do|were) we (leave|left) off|where were we|what were we (doing|working on)|catch me up|what('s| is) left)\b/i;
const STATUS = /^\W*(status|progress|update|how('s| is) it going|what are you (doing|working on)|how far along)\b/i;
/** Starts like work. The sidecar's wake.py TASK has the same list, for its "On it." vs "Mm-hm.": keep them in step. */
export const TASK = new RegExp(
  String.raw`^\W*(?:(?:please|now|and|then|so|okay|ok|also)\W+)*` +
    String.raw`(?:(?:can|could|would|will) you\W+(?:please\W+)?|i (?:want|need) you to\W+|let'?s\W+|go ahead and\W+)?` +
    String.raw`(?:build|create|make|add|fix|write|implement|refactor|update|change|remove|delete|rename|move|install|set ?up|` +
    String.raw`run|test|deploy|generate|scaffold|convert|migrate|upgrade|improve|optimi[sz]e|clean ?up|debug|replace|edit|modify|` +
    String.raw`style|design|init(?:ialize)?|start|put|hook up|wire|connect|integrate|document|translate|bump|configure|port|split|` +
    String.raw`merge|extract|commit|revert|undo|finish|continue|redo|polish|speed up|restructure|rewrite)\b`,
  "i",
);
const YES = /^\W*(yes|yeah|yep|yup|sure|ok(ay)?|allow( it)?|approve(d)?|go ahead|do it|fine|proceed)\b/i;
const NO = /^\W*(no|nope|nah|don'?t|do not|deny|decline|reject|skip( it)?|not that)\b/i;
/** A lone "no"/"yes" is often transcribed as a sound-alike. Only trusted while an approval is waiting. */
const NO_ALIKE = /^\W*(know|now|noh|nor|note)\W*$/i;
const YES_ALIKE = /^\W*(yas|yah|yea|yess|jess|guess)\W*$/i;

export function classify(text: string, ctx: { running: boolean; pendingApproval: boolean }): Intent {
  const t = text.trim();
  if (!t) return { kind: "nothing" };
  if (STOP.test(t)) return { kind: "stop" };
  if (ctx.pendingApproval) {
    if (YES.test(t) || YES_ALIKE.test(t)) return { kind: "approve", allow: true };
    if (NO_ALIKE.test(t)) return { kind: "approve", allow: false };
    if (NO.test(t)) {
      // "No, write it by hand" keeps the reason: it becomes the decision record.
      const note = t.replace(NO, "").replace(/^[\s,.:;-]+/, "").trim();
      return { kind: "approve", allow: false, ...(note ? { note } : {}) };
    }
  }
  if (LEFT_OFF.test(t)) return { kind: "left_off" };
  if (STATUS.test(t)) return { kind: "status" };
  const work = TASK.test(t);
  if (!work) return { kind: "chat", text: t };
  if (ctx.running) return { kind: "busy", text: t };
  return { kind: "task", goal: t.replace(/[.!\s]+$/, "") };
}
