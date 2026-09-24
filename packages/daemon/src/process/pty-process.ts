import * as pty from "node-pty";
import { AbortedError } from "../util/abort.js";
import { listDescendants } from "./descendants.js";
import { isAlive, killTree, waitForExit } from "./kill-tree.js";

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
      env: { ...process.env, ...opts.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" } as Record<string, string>,
      cols: opts.cols ?? 160,
      rows: opts.rows ?? 40,
    });
    this.term.onData((d) => {
      for (const l of this.listeners) l(d);
    });
    this.exited = new Promise((resolve) => {
      this.term.onExit(({ exitCode }) => {
        this.exitCode = exitCode;
        resolve(exitCode);
      });
    });
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
    // 2. POSIX: node-pty's own kill (SIGHUP to the session). On Windows it forks
    //    a console-list agent that often fails with "AttachConsole failed", and
    //    steps 3-4 already cover the tree, so it is skipped there.
    if (process.platform !== "win32") {
      try {
        this.term.kill();
      } catch {
        /* already gone */
      }
    }
    // 3. Walk the tree from the shell, then 4. anything in the snapshot that survived.
    await killTree(root);
    await Promise.all(snapshot.filter(isAlive).map((p) => killTree(p)));
    // 5. Verify.
    try {
      await waitForExit(pids, 5_000);
    } catch {
      /* reported below */
    }
    return { pids, survivors: pids.filter(isAlive) };
  }
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
  durationMs: number;
  kill?: KillReport;
}

export interface RunOptions extends PtySpawnOptions {
  timeoutMs?: number;
  signal: AbortSignal;
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
  proc.onData((d) => {
    output += d;
  });

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    if (opts.timeoutMs) timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"abort">((resolve) => {
    onAbort = () => resolve("abort");
    opts.signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    const outcome = await Promise.race([proc.exited, timedOut, aborted]);
    if (outcome === "abort") {
      await proc.kill();
      throw new AbortedError(opts.signal.reason);
    }
    if (outcome === "timeout") {
      const kill = await proc.kill();
      return { exitCode: null, output, timedOut: true, durationMs: Date.now() - started, kill };
    }
    return { exitCode: outcome, output, timedOut: false, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal.removeEventListener("abort", onAbort);
  }
}
