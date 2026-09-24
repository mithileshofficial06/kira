import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAlive } from "../src/process/kill-tree.js";
import { PtyProcess, runInPty } from "../src/process/pty-process.js";
import { AbortedError } from "../src/util/abort.js";
import { stripAnsi } from "../src/util/text.js";

const NEST = join(__dirname, "fixtures", "nest.cjs");
const cwd = __dirname;
const NODE = `"${process.execPath}"`;

describe("runInPty", () => {
  it("captures output and a zero exit code", async () => {
    const r = await runInPty("echo kira-pty-ok", { cwd, signal: new AbortController().signal });
    expect(r.exitCode).toBe(0);
    expect(stripAnsi(r.output)).toContain("kira-pty-ok");
  }, 20_000);

  it("propagates a non-zero exit code", async () => {
    const r = await runInPty(`${NODE} -e "process.exit(3)"`, { cwd, signal: new AbortController().signal });
    expect(r.exitCode).toBe(3);
  }, 20_000);

  it("kills the tree and reports timedOut when the command runs too long", async () => {
    const r = await runInPty(`${NODE} -e "setInterval(()=>{},1000)"`, {
      cwd,
      timeoutMs: 1_500,
      signal: new AbortController().signal,
    });
    expect(r.timedOut).toBe(true);
    expect(r.kill?.survivors).toEqual([]);
  }, 30_000);

  it("rejects with AbortedError promptly when aborted", async () => {
    const ac = new AbortController();
    const p = runInPty(`${NODE} -e "setInterval(()=>{},1000)"`, { cwd, signal: ac.signal });
    setTimeout(() => ac.abort("user said stop"), 1_000);
    const started = Date.now();
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe("PtyProcess.kill", () => {
  it("leaves zero survivors from a 3-deep tree started inside the PTY", async () => {
    const proc = PtyProcess.spawn(`${NODE} "${NEST}" 2`, { cwd });
    const pids = await new Promise<number[]>((resolve, reject) => {
      let buf = "";
      proc.onData((d) => {
        buf += stripAnsi(d);
        const found = [...new Set([...buf.matchAll(/PID (\d+)/g)].map((m) => Number(m[1])))];
        if (found.length === 3) resolve(found);
      });
      setTimeout(() => reject(new Error(`tree did not start: ${JSON.stringify(buf)}`)), 15_000);
    });
    expect(pids.every(isAlive)).toBe(true);

    const report = await proc.kill();

    expect(report.survivors).toEqual([]);
    expect(pids.filter(isAlive)).toEqual([]);
    for (const pid of pids) expect(report.pids).toContain(pid);
  }, 40_000);
});
