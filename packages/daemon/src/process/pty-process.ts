import * as pty from "node-pty";
import { AbortedError } from "../util/abort.js";
import { listDescendants } from "./descendants.js";
import { isAlive, killTree, waitForExit } from "./kill-tree.js";

const DA_QUERY = "\u001b[c";
const DA_REPLY = "\u001b[?1;0c";

export interface PtySpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

export interface KillReport {
  /** Every PID that was part of the tree when the kill started. */
  pids: number[];
  /** PIDs still alive after the full kill sequence. Should always be empty. */
  survivors: number[];
}

/**
 * A shell command running in a pseudo-terminal. Owns the whole process tree
 * underneath it and can tear it down completely (docs/notes/windows-process-trees.md).
 */
export class PtyProcess {
  private readonly term: pty.IPty;
  private readonly listeners = new Set<(data: string) => void>();
  private killing: Promise<KillReport> | undefined;
  readonly exited: Promise<number>;
  private exitCode: number | undefined;

  private constructor(command: string, opts: PtySpawnOptions) {
    const [file, args] = shellFor(command);
    this.term = pty.spawn(file, args, {
      name: "xterm-256color",
      cwd: opts.cwd,
      env: { ...scrubSecrets(process.env), ...opts.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" } as Record<string, string>,
      cols: opts.cols ?? 160,
      rows: opts.rows ?? 40,
      // node-pty's bundled ConPTY: its kill() closes the pseudo-console directly
      // instead of forking a console-list agent (which fails noisily with
      // "AttachConsole failed"). Kira kills the process tree itself.
      useConptyDll: true,
    });
    this.term.onData((d) => {
      // The console host asks "what terminal are you?" (Device Attributes) at
      // startup and stalls ~3s if nobody answers. Answer as a VT100 would.
      if (!this.answeredDA && d.includes(DA_QUERY)) {
        this.answeredDA = true;
        this.term.write(DA_REPLY);
      }
      for (const l of this.listeners) l(d);
    });
    this.exited = new Promise((resolve) => {
      this.term.onExit(({ exitCode }) => {
        this.exitCode = exitCode;
        // The shell is gone but the console host is not: close the pseudo-console
        // or a conhost/OpenConsole process is left behind for every command.
        this.closeConsole();
        resolve(exitCode);
      });
    });
  }

  private consoleClosed = false;
  private answeredDA = false;

  /** Releases the pseudo-terminal (ConPTY host on Windows). Safe to call repeatedly. */
  private closeConsole(): void {
    if (this.consoleClosed) return;
    this.consoleClosed = true;
    try {
      this.term.kill();
    } catch {
      /* already released */
    }
  }

  static spawn(command: string, opts: PtySpawnOptions): PtyProcess {
    return new PtyProcess(command, opts);
  }

  get pid(): number {
    return this.term.pid;
  }

  get hasExited(): boolean {
    return this.exitCode !== undefined;
  }

  onData(fn: (data: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  write(data: string): void {
    this.term.write(data);
  }

  /**
   * Kills the shell and every descendant, then verifies. Idempotent: concurrent
   * callers share one kill.
   */
  kill(): Promise<KillReport> {
    this.killing ??= this.killSequence();
    return this.killing;
  }

  private async killSequence(): Promise<KillReport> {
    const root = this.term.pid;
    // 1. Snapshot first: once the shell dies, its children are re-parented out of reach of /T.
    const snapshot = await listDescendants(root).catch(() => [] as number[]);
    const pids = [root, ...snapshot];
    // 2. Walk the tree from the shell, then 3. anything in the snapshot that survived.
    await killTree(root);
    await Promise.all(snapshot.filter(isAlive).map((p) => killTree(p)));
    // 4. Release the pseudo-console (SIGHUP on POSIX, closes the ConPTY host on Windows).
    this.closeConsole();
    // 5. Verify.
    try {
      await waitForExit(pids, 5_000);
    } catch {
      /* reported below */
    }
    return { pids, survivors: pids.filter(isAlive) };
  }
}

/** Variable names that hold credentials: API keys, tokens, secrets, passwords. */
const SECRET_NAME = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_|$)|^KIRA_DAEMON_/i;

/**
 * Commands the agent runs never inherit credentials (spec §13): the daemon's
 * own environment holds the provider keys, and `echo %MISTRAL_API_KEY%` would
 * otherwise put one straight into the model's context.
 */
export function scrubSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_NAME.test(k)) out[k] = v;
  return out;
}

function shellFor(command: string): [string, string | string[]] {
  if (process.platform === "win32") {
    // A single string, not argv: node-pty re-quotes argv entries on Windows.
    // /d skips AutoRun, /s keeps the inner quoting of `command` intact.
    return [process.env.ComSpec ?? "cmd.exe", `/d /s /c "${command}"`];
  }
  return [process.env.SHELL ?? "/bin/bash", ["-c", command]];
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  /** Killed because it sat on an interactive question nobody can answer. */
  waitingForInput?: boolean;
  durationMs: number;
  kill?: KillReport;
}

export interface RunOptions extends PtySpawnOptions {
  timeoutMs?: number;
  signal: AbortSignal;
  /** Raw output as it arrives (for a live terminal mirror). */
  onData?: (data: string) => void;
  /** Kill the command if its output has been quiet this long and ends in an interactive prompt. */
  promptIdleMs?: number;
}

/**
 * The tail of a terminal that is waiting for a keypress: select menus
 * (create-vite, clack, inquirer), y/n questions, "press enter", "Ok to proceed?".
 */
const INTERACTIVE_PROMPT = /(\(y\/n\)|\[y\/n\]|\(yes\/no\)|press (any key|enter)|ok to proceed\??|need to install the following packages|[◆◇❯›●○]\s|\?\s*$|:\s*$|select|choose|which .{1,60}\?)/i;

export function looksLikePrompt(output: string): boolean {
  const tail = output
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trimEnd()
    .slice(-400);
  return tail.length > 0 && INTERACTIVE_PROMPT.test(tail.split("\n").slice(-6).join("\n"));
}

/**
 * Runs `command` to completion in a PTY. On abort the tree is killed and the
 * promise rejects with AbortedError; on timeout the tree is killed and the
 * result says timedOut.
 */
export async function runInPty(command: string, opts: RunOptions): Promise<RunResult> {
  if (opts.signal.aborted) throw new AbortedError(opts.signal.reason);
  const started = Date.now();
  const proc = PtyProcess.spawn(command, opts);
  let output = "";
  let lastOutputAt = Date.now();
  proc.onData((d) => {
    output += d;
    lastOutputAt = Date.now();
    opts.onData?.(d);
  });

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    if (opts.timeoutMs) timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
  });
  let watchdog: NodeJS.Timeout | undefined;
  const prompted = new Promise<"prompt">((resolve) => {
    if (!opts.promptIdleMs) return;
    watchdog = setInterval(() => {
      if (Date.now() - lastOutputAt >= opts.promptIdleMs! && looksLikePrompt(output)) resolve("prompt");
    }, 500);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"abort">((resolve) => {
    onAbort = () => resolve("abort");
    opts.signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const outcome = await Promise.race([proc.exited, timedOut, aborted, prompted]);
    if (outcome === "abort") {
      await proc.kill();
      throw new AbortedError(opts.signal.reason);
    }
    if (outcome === "prompt") {
      const kill = await proc.kill();
      return { exitCode: null, output, timedOut: false, waitingForInput: true, durationMs: Date.now() - started, kill };
    }
    if (outcome === "timeout") {
      const kill = await proc.kill();
      return { exitCode: null, output, timedOut: true, durationMs: Date.now() - started, kill };
    }
    return { exitCode: outcome, output, timedOut: false, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    clearInterval(watchdog);
    if (onAbort) opts.signal.removeEventListener("abort", onAbort);
  }
}
