import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAlive } from "../src/process/kill-tree.js";
import {
  httpGetTool,
  runCommandTool,
  startBackgroundTool,
  stopBackgroundTool,
} from "../src/tools/command-tools.js";
import { listDirTool, readFileTool, writeFileTool } from "../src/tools/fs-tools.js";
import { BackgroundManager, Gate, PHASE0_TOOLS, toToolSpec, type ToolContext } from "../src/tools/index.js";

let ws: string;
let ctx: ToolContext;
const approvals: string[] = [];

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), "kira-tools-"));
  await writeFile(join(ws, ".env"), "SECRET=1");
  ctx = {
    workspace: ws,
    signal: new AbortController().signal,
    gate: new Gate(async (req) => {
      approvals.push(req.summary);
      return false;
    }),
    background: new BackgroundManager(),
    log: () => {},
  };
});

afterAll(async () => {
  await ctx.background.stopAll();
  await rm(ws, { recursive: true, force: true });
});

describe("file tools", () => {
  it("writes, reads back with line numbers, and lists without .env", async () => {
    await writeFileTool.run({ path: "src/hello.ts", content: "export const a = 1;\nexport const b = 2;\n" }, ctx);
    const r = await readFileTool.run({ path: "src\\hello.ts" }, ctx);
    expect(r.content).toContain("    2  export const b = 2;");
    const ls = await listDirTool.run({}, ctx);
    expect(ls.content).toContain("src/");
    expect(ls.content).toContain("hello.ts");
    expect(ls.content).not.toContain(".env");
  });

  it("refuses to read .env", async () => {
    await expect(readFileTool.run({ path: ".env" }, ctx)).rejects.toThrow(/protected/);
  });
});

describe("run_command", () => {
  it("returns exit code and output", async () => {
    const r = await runCommandTool.run({ command: "echo tool-ok" }, ctx);
    expect(r.content).toMatch(/^exit code 0\n.*tool-ok/s);
    expect(r.isError).toBe(false);
  }, 20_000);

  it("sends gated commands to the approver and reports a refusal", async () => {
    const r = await runCommandTool.run({ command: "git push origin main" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/declined/);
    expect(approvals).toContain("git push origin main");
  });
});

describe("background processes", () => {
  it("starts a server, detects its URL, serves a GET, and stops with no survivors", async () => {
    const server = `"${process.execPath}" -e "require('http').createServer((q,s)=>s.end('kira-bg-ok')).listen(0,function(){console.log('listening http://localhost:'+this.address().port+'/')})"`;
    const started = await startBackgroundTool.run({ command: server, waitSeconds: 20 }, ctx);
    expect(started.content).toMatch(/state=ready/);
    const url = started.content.match(/url=(\S+)/)?.[1];
    expect(url).toBeDefined();

    const got = await httpGetTool.run({ url: url! }, ctx);
    expect(got.content).toMatch(/^status 200/);
    expect(got.content).toContain("kira-bg-ok");

    const id = started.content.match(/id=(\S+)/)![1]!;
    const pid = ctx.background.get(id)!.proc.pid;
    const stopped = await stopBackgroundTool.run({ id }, ctx);
    expect(stopped.isError).toBeFalsy();
    expect(isAlive(pid)).toBe(false);
  }, 40_000);

  it("http_get refuses non-localhost URLs", async () => {
    const r = await httpGetTool.run({ url: "https://example.com/" }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe("toToolSpec", () => {
  it("produces provider-safe JSON schemas for every Phase 0 tool", () => {
    for (const t of PHASE0_TOOLS) {
      const spec = toToolSpec(t);
      const json = JSON.stringify(spec.parameters);
      expect(spec.parameters.type).toBe("object");
      expect(json).not.toContain("$schema");
      expect(json).not.toContain("9007199254740991");
    }
  });
});
