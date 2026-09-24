import { z } from "zod";
import { runInPty } from "../process/pty-process.js";
import { sleep } from "../util/abort.js";
import { stripAnsi, truncateMiddle } from "../util/text.js";
import { defineTool, type ToolContext, type ToolResult } from "./types.js";
import { resolveInWorkspace } from "./workspace.js";

const MAX_OUTPUT_CHARS = 6_000;

async function gated(tool: string, command: string, ctx: ToolContext): Promise<ToolResult | undefined> {
  const d = await ctx.gate.checkCommand(tool, command, ctx.signal);
  return d.allow ? undefined : { content: d.reason, isError: true };
}

export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run a shell command to completion and return its exit code and output. On Windows this is cmd.exe. " +
    "Do NOT use for servers or watchers that never exit: use start_background instead.",
  schema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe("Workspace-relative working directory (default: workspace root)"),
    timeoutSeconds: z.number().min(1).max(900).optional().describe("Kill after this long (default 300)"),
  }),
  async run({ command, cwd, timeoutSeconds = 300 }, ctx) {
    const denied = await gated("run_command", command, ctx);
    if (denied) return denied;
    const dir = resolveInWorkspace(ctx.workspace, cwd ?? ".", "read");
    ctx.log(`$ ${command}`);
    const r = await runInPty(command, { cwd: dir, timeoutMs: timeoutSeconds * 1000, signal: ctx.signal });
    const output = truncateMiddle(stripAnsi(r.output).trim(), MAX_OUTPUT_CHARS);
    const status = r.timedOut ? `TIMED OUT after ${timeoutSeconds}s (process tree killed)` : `exit code ${r.exitCode}`;
    ctx.log(`  -> ${status} in ${(r.durationMs / 1000).toFixed(1)}s`);
    return { content: `${status}\n${output || "(no output)"}`, isError: r.timedOut || r.exitCode !== 0 };
  },
});

const URL_PATTERN = /https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?[^\s]*/i;

export const startBackgroundTool = defineTool({
  name: "start_background",
  description:
    "Start a long-running process (dev server, watcher) and return once it looks ready: its output matches " +
    "readyPattern or prints a localhost URL, or waitSeconds pass. Returns an id for background_output/stop_background.",
  schema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe("Workspace-relative working directory"),
    readyPattern: z.string().optional().describe("Regex that signals readiness, e.g. 'ready in'"),
    waitSeconds: z.number().min(1).max(120).optional().describe("Max wait for readiness (default 30)"),
  }),
  async run({ command, cwd, readyPattern, waitSeconds = 30 }, ctx) {
    const denied = await gated("start_background", command, ctx);
    if (denied) return denied;
    const dir = resolveInWorkspace(ctx.workspace, cwd ?? ".", "read");
    let ready: RegExp;
    try {
      ready = readyPattern ? new RegExp(readyPattern, "i") : URL_PATTERN;
    } catch {
      return { content: `readyPattern is not a valid regex: ${readyPattern}`, isError: true };
    }
    ctx.log(`$ ${command} &`);
    const entry = ctx.background.start(command, dir);
    const deadline = Date.now() + waitSeconds * 1000;
    let state = "still starting";
    while (Date.now() < deadline) {
      if (entry.proc.hasExited) {
        state = `EXITED with code ${await entry.proc.exited}`;
        break;
      }
      if (ready.test(entry.output)) {
        state = "ready";
        break;
      }
      await sleep(250, ctx.signal);
    }
    const url = entry.output.match(URL_PATTERN)?.[0];
    ctx.log(`  -> ${entry.id}: ${state}${url ? ` at ${url}` : ""}`);
    return {
      content: `id=${entry.id} state=${state}${url ? ` url=${url}` : ""}\n${truncateMiddle(entry.output.trim(), 3_000)}`,
      isError: state.startsWith("EXITED"),
    };
  },
});

export const backgroundOutputTool = defineTool({
  name: "background_output",
  description: "Return the recent output of a background process and whether it is still running.",
  schema: z.object({ id: z.string() }),
  async run({ id }, ctx) {
    const e = ctx.background.get(id);
    if (!e) return { content: `No background process ${id}. Running: ${JSON.stringify(ctx.background.list())}`, isError: true };
    return { content: `${e.proc.hasExited ? "exited" : "running"}\n${truncateMiddle(e.output.trim(), MAX_OUTPUT_CHARS)}` };
  },
});

export const stopBackgroundTool = defineTool({
  name: "stop_background",
  description: "Stop a background process and its whole process tree.",
  schema: z.object({ id: z.string() }),
  async run({ id }, ctx) {
    const report = await ctx.background.stop(id);
    if (!report) return { content: `No background process ${id}.`, isError: true };
    ctx.log(`  stopped ${id}`);
    return report.survivors.length
      ? { content: `Stopped ${id}, but PIDs survived: ${report.survivors.join(", ")}`, isError: true }
      : { content: `Stopped ${id} (${report.pids.length} processes).` };
  },
});

export const httpGetTool = defineTool({
  name: "http_get",
  description: "HTTP GET a localhost URL (e.g. a dev server) and return the status and the start of the body.",
  schema: z.object({ url: z.string().url() }),
  async run({ url }, ctx) {
    const host = new URL(url).hostname;
    if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      return { content: "http_get only allows localhost URLs.", isError: true };
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) });
      const body = await res.text();
      ctx.log(`  GET ${url} -> ${res.status}`);
      return {
        content: `status ${res.status} ${res.headers.get("content-type") ?? ""}\n${truncateMiddle(body, 2_000)}`,
        isError: !res.ok,
      };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      return { content: `Request failed: ${(err as Error).message}`, isError: true };
    }
  },
});

export const finishTool = defineTool({
  name: "finish",
  description:
    "Call when the goal is verifiably achieved, or when you cannot continue without a human decision. " +
    "Say exactly what was done, how it was verified, and anything left open. Do not claim success you did not verify.",
  schema: z.object({
    outcome: z.enum(["done", "blocked", "failed"]),
    summary: z.string().min(1),
  }),
  async run({ outcome, summary }) {
    return { content: "Run finished.", finished: { outcome, summary } };
  },
});
