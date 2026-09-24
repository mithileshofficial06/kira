/**
 * Deterministic stub detection over a unified diff. Runs in L5 beside the
 * model critic: a planted `// TODO: implement` is caught even when the critic
 * is throttled, misses it, or is too lenient.
 */

export interface StubFinding {
  file: string;
  line: number;
  text: string;
  rule: string;
}

const RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "todo-implement", pattern: /\b(TODO|FIXME|XXX)\b[:\s-]*(implement|fill in|finish|write this)/i },
  { rule: "not-implemented", pattern: /\bnot\s+(yet\s+)?implemented\b/i },
  { rule: "stub-marker", pattern: /(\/\/|#|\/\*)\s*(stub|placeholder)\b/i },
  { rule: "throw-todo", pattern: /\bthrow\s+new\s+\w*Error\s*\(\s*["'`]\s*(TODO|TBD|stub)/i },
  { rule: "python-pass-todo", pattern: /^\s*(pass|\.\.\.)\s*#\s*(TODO|FIXME)/i },
  { rule: "fake-return", pattern: /return\s+(null|undefined|\[\]|\{\}|0|""|''|true|false)\s*;?\s*(\/\/|#)\s*(TODO|FIXME|stub|fake|placeholder)/i },
];

/** Files where stub-like text is expected, not a defect. */
const IGNORE_FILE = /(^|\/)(CHANGELOG|TODO)(\.md)?$|\.(md|txt)$|(^|\/)(test|tests|__tests__)\/.*fixture/i;

/** Scans only added lines ("+"), with their new-file line numbers. */
export function findStubs(patch: string): StubFinding[] {
  const out: StubFinding[] = [];
  let file = "";
  let line = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      const text = raw.slice(1);
      if (!IGNORE_FILE.test(file)) {
        const hit = RULES.find((r) => r.pattern.test(text));
        if (hit) out.push({ file, line, text: text.trim().slice(0, 200), rule: hit.rule });
      }
      line++;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      line++;
    }
  }
  return out;
}
