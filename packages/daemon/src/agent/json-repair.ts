/**
 * Parses tool-call arguments, repairing the mistakes models commonly make:
 * markdown fences, trailing commas, smart quotes, prose around the object.
 * Returns undefined if the text still is not a JSON object.
 */
export function parseToolArgs(raw: string): Record<string, unknown> | undefined {
  const attempts = [raw, repair(raw)];
  for (const text of attempts) {
    try {
      const v: unknown = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
      // Some models double-encode: "{\"path\":\"a\"}"
      if (typeof v === "string") return parseToolArgs(v);
    } catch {
      /* next attempt */
    }
  }
  return undefined;
}

function repair(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  s = s.replace(/,\s*([}\]])/g, "$1");
  if (s === "") s = "{}";
  return s;
}
