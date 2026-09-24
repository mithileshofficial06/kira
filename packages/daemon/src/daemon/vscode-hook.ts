/**
 * How `npm run kira` in a VS Code terminal finds that VS Code window and
 * shows Kira's assistant in it.
 *
 * The extension listens on a local pipe (the "hook") and advertises it two ways:
 * - KIRA_VSCODE_HOOK in the environment of terminals it opens (exact window), and
 * - a file per window in %LOCALAPPDATA%/kira/vscode-hooks listing its folders,
 *   for terminals opened before the extension started.
 * The CLI connects and sends one line: its daemon's pipe and session token. The
 * extension attaches to that daemon as an ordinary client and opens the assistant.
 * Nothing listens beyond this machine; the token never leaves the pipe.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export const HOOK_ENV = "KIRA_VSCODE_HOOK";

export interface HookInfo {
  pipe: string;
  pid: number;
  folders: string[];
}

export interface AttachRequest {
  type: "attach";
  pipe: string;
  token: string;
  workspace: string;
  pid: number;
}

export function hookDir(): string {
  const base = process.env.LOCALAPPDATA || join(homedir(), ".cache");
  return join(base, "kira", "vscode-hooks");
}

export function newHookPipe(): string {
  const n = randomBytes(6).toString("hex");
  return process.platform === "win32" ? `\\\\.\\pipe\\kira-vscode-${n}` : join(tmpdir(), `kira-vscode-${n}.sock`);
}

/** The extension: advertise this window's hook. Returns a function that removes the file. */
export function advertiseHook(info: HookInfo): () => void {
  const dir = hookDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${info.pid}.json`);
  writeFileSync(file, JSON.stringify(info));
  return () => rmSync(file, { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const norm = (p: string) => {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};
const inside = (child: string, parent: string) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/**
 * The CLI: the hook of the VS Code window this terminal belongs to, if any.
 * The environment variable wins; otherwise, inside a VS Code terminal, the
 * window whose folder holds the workspace (or the only window open).
 */
export function findHook(workspace: string, cwd = process.cwd(), env = process.env): string | undefined {
  if (env[HOOK_ENV]) return env[HOOK_ENV];
  if (env.TERM_PROGRAM !== "vscode") return undefined;
  const dir = hookDir();
  if (!existsSync(dir)) return undefined;
  const hooks: HookInfo[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const h = JSON.parse(readFileSync(join(dir, f), "utf8")) as HookInfo;
      if (alive(h.pid)) hooks.push(h);
      else rmSync(join(dir, f), { force: true });
    } catch {
      // half-written or foreign file: skip
    }
  }
  const match = hooks.find((h) => h.folders.some((f) => inside(workspace, f) || inside(cwd, f)));
  return match?.pipe ?? (hooks.length === 1 ? hooks[0]!.pipe : undefined);
}

/** The CLI: ask the VS Code window behind `hook` to attach to this daemon. Resolves true once it accepted. */
export function announce(hook: string, req: Omit<AttachRequest, "type">, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((done) => {
    const sock = connect(hook);
    let buf = "";
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      sock.destroy();
      done(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("error", () => finish(false));
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) finish(/"ok":\s*true/.test(buf));
    });
    sock.once("connect", () => sock.write(JSON.stringify({ type: "attach", ...req } satisfies AttachRequest) + "\n"));
  });
}
