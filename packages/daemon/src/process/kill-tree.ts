import { execFile } from "node:child_process";
import { sleep } from "../util/abort.js";

/**
 * Kills a process and every descendant.
 *
 * On Windows, children do not die with their parent: a plain process.kill()
 * orphans npm -> node -> dev server. `taskkill /T` walks the tree. Job Objects
 * are the stronger long-term answer (they also catch processes that detach),
 * but taskkill covers the Phase 0 case with no native code.
 */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      // Exit code 128 means "not found": the tree is already gone, which is success.
      execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL"); // negative pid = whole process group
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Polls until none of `pids` is alive, or throws after `timeoutMs`. */
export async function waitForExit(pids: number[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const signal = new AbortController().signal;
  for (;;) {
    const alive = pids.filter(isAlive);
    if (alive.length === 0) return;
    if (Date.now() > deadline) throw new Error(`Processes still alive after ${timeoutMs}ms: ${alive.join(", ")}`);
    await sleep(100, signal);
  }
}
