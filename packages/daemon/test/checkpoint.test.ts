import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/checkpoint/git.js";
import { CheckpointManager } from "../src/checkpoint/manager.js";

let ws: string;
const g = (...args: string[]) => git(args, { cwd: ws });
const read = (f: string) => readFile(join(ws, f), "utf8");
const put = async (f: string, s: string) => {
  await mkdir(join(ws, f, ".."), { recursive: true });
  await writeFile(join(ws, f), s);
};

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kira-ckpt-"));
  await g("init", "-q", "-b", "main");
  await g("config", "user.name", "test");
  await g("config", "user.email", "test@example.com");
  await g("config", "core.autocrlf", "false");
  await put(".gitignore", "node_modules/\n.env\n");
  await put("src/a.ts", "export const a = 1;\n");
  await put("README.md", "# demo\n");
  await g("add", "-A");
  await g("commit", "-q", "-m", "init");
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("CheckpointManager", () => {
  it("snapshots and restores files: modified, added, deleted, untracked", async () => {
    const cm = await CheckpointManager.open(ws);
    await put("notes.txt", "untracked but not ignored\n");
    const c1 = await cm.create("run1", 1);

    // The agent then makes a mess.
    await put("src/a.ts", "export const a = 999;\n");
    await put("src/new.ts", "export const n = 1;\n");
    await unlink(join(ws, "README.md"));
    await unlink(join(ws, "notes.txt"));
    await cm.create("run1", 2);

    const report = await cm.restore("run1", 1);

    expect(await read("src/a.ts")).toBe("export const a = 1;\n");
    expect(await read("README.md")).toBe("# demo\n");
    expect(await read("notes.txt")).toBe("untracked but not ignored\n");
    expect(existsSync(join(ws, "src/new.ts"))).toBe(false);
    expect(report.removed).toEqual(["src/new.ts"]);
    expect(report.restored.sort()).toEqual(["README.md", "notes.txt", "src/a.ts"]);
    expect(c1.ref).toBe("refs/kira/checkpoints/run1/1");
  });

  it("never touches the user's index, HEAD or branch history", async () => {
    const cm = await CheckpointManager.open(ws);
    await put("src/a.ts", "export const a = 2;\n");
    await g("add", "src/a.ts"); // the user's own staged change
    const stagedBefore = await g("diff", "--cached");
    const headBefore = await g("rev-parse", "HEAD");
    const logBefore = await g("log", "--oneline");

    await cm.create("run2", 1);
    await put("src/b.ts", "x\n");
    await cm.create("run2", 2);
    await cm.restore("run2", 1);

    expect(await g("diff", "--cached")).toBe(stagedBefore);
    expect(await g("rev-parse", "HEAD")).toBe(headBefore);
    expect(await g("log", "--oneline")).toBe(logBefore);
    expect(await g("branch", "--list")).toBe("* main");
  });

  it("leaves ignored files (node_modules, .env) alone in both directions", async () => {
    const cm = await CheckpointManager.open(ws);
    await put("node_modules/x/index.js", "v1");
    await put(".env", "SECRET=1");
    await cm.create("run3", 1);
    await put("node_modules/x/index.js", "v2");
    await cm.restore("run3", 1);

    expect(await read("node_modules/x/index.js")).toBe("v2");
    expect(await read(".env")).toBe("SECRET=1");
    const tree = await g("ls-tree", "-r", "--name-only", "refs/kira/checkpoints/run3/1");
    expect(tree).not.toMatch(/node_modules|\.env/);
  });

  it("the rewind itself can be undone", async () => {
    const cm = await CheckpointManager.open(ws);
    await cm.create("run4", 1);
    await put("src/a.ts", "agent work\n");
    const { undo } = await cm.restore("run4", 1);
    expect(await read("src/a.ts")).toBe("export const a = 1;\n");

    await cm.restore(undo.runId, undo.step);
    expect(await read("src/a.ts")).toBe("agent work\n");
  });

  it("lists checkpoints in step order, chains parents, and drops them", async () => {
    const cm = await CheckpointManager.open(ws);
    for (const step of [1, 2, 10]) {
      await put("src/a.ts", `step ${step}\n`);
      await cm.create("run5", step);
    }
    const list = await cm.list("run5");
    expect(list.map((c) => c.step)).toEqual([1, 2, 10]);
    expect(await g("rev-parse", `${list[2]!.sha}^`)).toBe(list[1]!.sha);

    await cm.drop("run5");
    expect(await cm.list("run5")).toEqual([]);
  });

  it("works in a repo with no commits yet", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "kira-ckpt-fresh-"));
    try {
      const cm = await CheckpointManager.open(fresh, { initIfMissing: true });
      await writeFile(join(fresh, "a.txt"), "1");
      await cm.create("r", 1);
      await writeFile(join(fresh, "a.txt"), "2");
      await cm.restore("r", 1);
      expect(await readFile(join(fresh, "a.txt"), "utf8")).toBe("1");
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
