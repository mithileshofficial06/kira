/**
 * What a spoken sentence means to Kira. Deliberately small and predictable:
 * anything that is not a control phrase is a task. Voice input is lossy
 * (spec R11), so a spoken goal is echoed as the run's goal in the Flight Deck,
 * and gated tools still need an explicit approval.
 */
export type Intent =
  | { kind: "stop" }
  | { kind: "left_off" }
  | { kind: "status" }
  | { kind: "approve"; allow: boolean; note?: string }
  | { kind: "task"; goal: string }
  | { kind: "busy"; text: string }
  | { kind: "nothing" };

const STOP = /^\W*(?:please\W+)?(stop|cancel|abort|halt|hold on|wait|pause|enough|kill it|freeze)\b/i;
const LEFT_OFF = /\b(where (did|do|were) we (leave|left) off|where were we|what were we (doing|working on)|catch me up|what('s| is) left)\b/i;
const STATUS = /^\W*(status|progress|update|how('s| is) it going|what are you (doing|working on)|how far along)\b/i;
const YES = /^\W*(yes|yeah|yep|yup|sure|ok(ay)?|allow( it)?|approve(d)?|go ahead|do it|fine|proceed)\b/i;
const NO = /^\W*(no|nope|nah|don'?t|do not|deny|decline|reject|skip( it)?|not that)\b/i;

export function classify(text: string, ctx: { running: boolean; pendingApproval: boolean }): Intent {
  const t = text.trim();
  if (!t) return { kind: "nothing" };
  if (STOP.test(t)) return { kind: "stop" };
  if (ctx.pendingApproval) {
    if (YES.test(t)) return { kind: "approve", allow: true };
    if (NO.test(t)) {
      // "No, write it by hand" keeps the reason: it becomes the decision record.
      const note = t.replace(NO, "").replace(/^[\s,.:;-]+/, "").trim();
      return { kind: "approve", allow: false, ...(note ? { note } : {}) };
    }
  }
  if (LEFT_OFF.test(t)) return { kind: "left_off" };
  if (STATUS.test(t)) return { kind: "status" };
  if (ctx.running) return { kind: "busy", text: t };
  return { kind: "task", goal: t.replace(/[.!\s]+$/, "") };
}
