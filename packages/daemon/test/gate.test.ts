import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCommand, Gate } from "../src/tools/gate.js";
import { PathDeniedError, resolveInWorkspace } from "../src/tools/workspace.js";

describe("classifyCommand", () => {
  it.each([
    ["git push origin main", "network-write"],
    ["git reset --hard HEAD~1", "force"],
    ["rm -rf dist", "destructive"],
    ["rmdir /s /q build", "destructive"],
    ["Remove-Item -Path out -Recurse -Force", "destructive"],
    ["npm install react-dropzone", "dependency-install"],
    ["npm i -D vitest", "dependency-install"],
    ["pnpm add zod", "dependency-install"],
    ["pip install requests", "dependency-install"],
    ["npm create vite@latest app -- --template react-ts", "remote-code"],
    ["npx some-tool", "remote-code"],
    ["curl -X POST https://api.example.com", "network-write"],
    ["npx prisma migrate dev", "remote-code"],
    ["npm install -g typescript", "outside-repo"],
  ])("gates %s as %s", (cmd, category) => {
    expect(classifyCommand(cmd).gated).toBe(category);
  });

  it.each(["npm install", "npm ci", "npm run build", "npm test", "git status", "git diff", "dir", "node index.js"])(
    "lets %s through",
    (cmd) => {
      expect(classifyCommand(cmd)).toEqual({});
    },
  );

  it.each(["type .env", "cat .env.local", "set", "Get-ChildItem env:"])("refuses %s outright", (cmd) => {
    expect(classifyCommand(cmd).denied).toBeDefined();
  });
});

describe("Gate", () => {
  const signal = new AbortController().signal;

  it("asks the approver only for gated commands and respects a no", async () => {
    const asked: string[] = [];
    const gate = new Gate(async (req) => {
      asked.push(req.summary);
      return false;
    });
    expect(await gate.checkCommand("run_command", "npm run build", signal)).toEqual({ allow: true });
    const d = await gate.checkCommand("run_command", "git push", signal);
    expect(d.allow).toBe(false);
    expect(asked).toEqual(["git push"]);
  });

  it("never asks about denied commands", async () => {
    const gate = new Gate(async () => {
      throw new Error("should not be asked");
    });
    expect((await gate.checkCommand("run_command", "type .env", signal)).allow).toBe(false);
  });
});

describe("resolveInWorkspace", () => {
  const ws = join(__dirname, "ws");

  it("resolves relative paths with either slash style", () => {
    expect(resolveInWorkspace(ws, "src/a.ts", "write")).toBe(join(ws, "src", "a.ts"));
    expect(resolveInWorkspace(ws, "src\\a.ts", "write")).toBe(join(ws, "src", "a.ts"));
  });

  it.each(["../secret.txt", "src/../../x", join(__dirname, "..", "..", "package.json")])("rejects %s (outside)", (p) => {
    expect(() => resolveInWorkspace(ws, p, "read")).toThrow(PathDeniedError);
  });

  it.each([".env", "app/.env.local", ".git/config", ".kira/memory.db"])("protects %s", (p) => {
    expect(() => resolveInWorkspace(ws, p, "read")).toThrow(PathDeniedError);
  });

  it("allows reading node_modules but not writing it", () => {
    expect(() => resolveInWorkspace(ws, "node_modules/x/package.json", "read")).not.toThrow();
    expect(() => resolveInWorkspace(ws, "node_modules/x/index.js", "write")).toThrow(PathDeniedError);
  });

  it("does not mistake .envrc-like names for .env", () => {
    expect(() => resolveInWorkspace(ws, "src/environment.ts", "write")).not.toThrow();
  });
});
