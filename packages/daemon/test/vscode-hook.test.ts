import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advertiseHook, announce, findHook, HOOK_ENV, hookDir, newHookPipe, type AttachRequest } from "../src/daemon/vscode-hook.js";
import { projectVocabulary } from "../src/voice/vocab.js";

describe("VS Code terminal link", () => {
  let base: string;
  const saved = process.env.LOCALAPPDATA;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "kira-hook-"));
    process.env.LOCALAPPDATA = base;
  });
  afterEach(() => {
    process.env.LOCALAPPDATA = saved;
    rmSync(base, { recursive: true, force: true });
  });

  it("prefers the window named in the environment", () => {
    expect(findHook("C:/x", "C:/x", { [HOOK_ENV]: "pipe-from-env" })).toBe("pipe-from-env");
  });

  it("outside a VS Code terminal, finds nothing", () => {
    advertiseHook({ pipe: "p", pid: process.pid, folders: [base] });
    expect(findHook(base, base, {})).toBeUndefined();
  });

  it("picks the window whose folder holds the workspace, and drops dead windows", () => {
    const proj = join(base, "proj");
    const other = join(base, "other");
    mkdirSync(proj);
    mkdirSync(other);
    advertiseHook({ pipe: "other-window", pid: process.pid, folders: [other] });
    writeFileSync(join(hookDir(), "999999.json"), JSON.stringify({ pipe: "dead", pid: 999999, folders: [proj] }));
    writeFileSync(join(hookDir(), `${process.ppid}.json`), JSON.stringify({ pipe: "this-window", pid: process.ppid, folders: [proj] }));
    const env = { TERM_PROGRAM: "vscode" };
    expect(findHook(join(proj, "sub"), base, env)).toBe("this-window");
    expect(findHook(join(base, "elsewhere"), base, env)).toBeUndefined(); // two windows, neither holds it: don't guess
  });

  it("announces the daemon and waits for the window to accept", async () => {
    const pipe = newHookPipe();
    let got: AttachRequest | undefined;
    const server = createServer((s) =>
      s.on("data", (d) => {
        got = JSON.parse(d.toString());
        s.end('{"ok":true}\n');
      }),
    );
    await new Promise<void>((r) => server.listen(pipe, r));
    try {
      expect(await announce(pipe, { pipe: "daemon-pipe", token: "t", workspace: "w", pid: 1 })).toBe(true);
      expect(got).toMatchObject({ type: "attach", pipe: "daemon-pipe", token: "t" });
      expect(await announce(newHookPipe(), { pipe: "x", token: "t", workspace: "w", pid: 1 }, 500)).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("project vocabulary", () => {
  it("lists dependencies and file names, without spaces or junk folders", () => {
    const ws = mkdtempSync(join(tmpdir(), "kira-vocab-"));
    try {
      writeFileSync(join(ws, "package.json"), JSON.stringify({ name: "shop", dependencies: { dayjs: "1", "@tanstack/react-query": "5" } }));
      mkdirSync(join(ws, "src", "components"), { recursive: true });
      writeFileSync(join(ws, "src", "components", "LoginForm.tsx"), "");
      writeFileSync(join(ws, "my notes.txt"), "");
      mkdirSync(join(ws, "node_modules", "left-pad"), { recursive: true });
      const v = projectVocabulary(ws);
      expect(v).toEqual(expect.arrayContaining(["shop", "dayjs", "react-query", "LoginForm.tsx", "LoginForm", "components"]));
      expect(v.some((w) => /\s/.test(w))).toBe(false);
      expect(v).not.toContain("left-pad");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
