import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAlive, killTree, waitForExit } from "../src/process/kill-tree.js";

const NEST = join(__dirname, "fixtures", "nest.cjs");

function spawnNested(depth: number): Promise<{ pids: number[] }> {
  return new Promise((resolve, reject) => {
    const root = spawn(process.execPath, [NEST, String(depth)], {
      stdio: ["ignore", "pipe", "inherit"],
      detached: process.platform !== "win32", // own process group on POSIX
    });
    const pids: number[] = [];
    let buf = "";
    root.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (const m of buf.matchAll(/PID (\d+)\n/g)) {
        const pid = Number(m[1]);
        if (!pids.includes(pid)) pids.push(pid);
      }
      if (pids.length === depth + 1) resolve({ pids });
    });
    root.on("error", reject);
    setTimeout(() => reject(new Error(`only saw ${pids.length} of ${depth + 1} pids`)), 10_000);
  });
}

describe("killTree", () => {
  it("kills a 3-deep nested process tree with no orphans", async () => {
    const { pids } = await spawnNested(2);
    expect(pids).toHaveLength(3);
    expect(pids.every(isAlive)).toBe(true);

    await killTree(pids[0]!);
    await waitForExit(pids);

    expect(pids.filter(isAlive)).toEqual([]);
  }, 20_000);

  it("is a no-op for a pid that already exited", async () => {
    const { pids } = await spawnNested(0);
    await killTree(pids[0]!);
    await waitForExit(pids);
    await expect(killTree(pids[0]!)).resolves.toBeUndefined();
  }, 20_000);
});
