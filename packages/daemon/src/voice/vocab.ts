/**
 * The project's own words, sent to the voice sidecar as Voxtral's context
 * bias, so "open login-form.tsx" or "swap moment for dayjs" come back spelled
 * the way the project spells them. Voxtral takes terms without spaces or commas.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", ".venv", "venv", "__pycache__", ".kira", ".turbo", ".cache"]);
const TERM = /^[^\s,]{2,40}$/;

export function projectVocabulary(workspace: string, limit = 60): string[] {
  const words: string[] = [];
  const add = (w: string) => {
    if (TERM.test(w) && !/^\d+$/.test(w)) words.push(w);
  };

  // Dependencies first: package names are what STT gets wrong most.
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as Record<string, unknown>;
    if (typeof pkg.name === "string") add(pkg.name);
    for (const k of ["dependencies", "devDependencies"]) for (const d of Object.keys((pkg[k] as object) ?? {})) add(d.replace(/^@[^/]+\//, ""));
  } catch {
    // no package.json: fine
  }

  // Then file and folder names, shallow first.
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env") continue;
      if (SKIP.has(e.name)) continue;
      add(e.name);
      if (e.isFile()) {
        const stem = e.name.replace(/\.[^.]+$/, "");
        if (stem !== e.name) add(stem);
      }
    }
    if (depth > 0) for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth - 1);
  };
  walk(workspace, 2);

  const seen = new Set<string>();
  return words.filter((w) => !seen.has(w.toLowerCase()) && !!seen.add(w.toLowerCase())).slice(0, limit);
}
