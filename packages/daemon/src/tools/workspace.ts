import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathDeniedError extends Error {
  override name = "PathDeniedError";
}

/** Paths no tool may read or write, whatever the autonomy level. Enforced here, not by prompt. */
const DENY_ALWAYS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i, // .env, .env.local, ... (credentials)
  /(^|\/)\.git(\/|$)/i, // repository internals; checkpoints go through the checkpoint manager
  /(^|\/)\.kira(\/|$)/i, // Kira's own state
];

/** Readable but not writable. */
const DENY_WRITE: RegExp[] = [/(^|\/)node_modules(\/|$)/i];

/** Workspace-relative path with forward slashes, for rules, logs and the model. */
export function toRel(workspace: string, abs: string): string {
  return relative(workspace, abs).split(sep).join("/");
}

/**
 * Resolves a model-supplied path inside the workspace, or throws.
 * Internally Kira uses forward slashes; conversion happens only here.
 */
export function resolveInWorkspace(workspace: string, p: string, mode: "read" | "write"): string {
  const abs = resolve(workspace, p.replace(/\\/g, "/"));
  const rel = toRel(workspace, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathDeniedError(`"${p}" is outside the workspace`);
  }
  if (DENY_ALWAYS.some((r) => r.test(rel))) throw new PathDeniedError(`"${p}" is protected and cannot be accessed`);
  if (mode === "write" && DENY_WRITE.some((r) => r.test(rel))) {
    throw new PathDeniedError(`"${p}" is read-only for Kira`);
  }
  return abs;
}
