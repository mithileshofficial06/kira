import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { sleep, throwIfAborted } from "../util/abort.js";
import { defineTool } from "./types.js";
import { resolveInWorkspace, toRel } from "./workspace.js";

const MAX_READ_CHARS = 20_000;

export const readFileTool = defineTool({
  name: "read_file",
  effect: "read",
  description: "Read a text file in the workspace. Use startLine/maxLines for large files.",
  schema: z.object({
    path: z.string().describe("Workspace-relative path"),
    startLine: z.number().min(1).optional().describe("1-based first line (default 1)"),
    maxLines: z.number().min(1).max(2000).optional().describe("Lines to return (default 400)"),
  }),
  async run({ path, startLine = 1, maxLines = 400 }, ctx) {
    throwIfAborted(ctx.signal);
    const abs = resolveInWorkspace(ctx.workspace, path, "read");
    const text = await readFile(abs, "utf8");
    const lines = text.split(/\r?\n/);
    const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);
    const body = slice.map((l, i) => `${String(startLine + i).padStart(5)}  ${l}`).join("\n").slice(0, MAX_READ_CHARS);
    const more = startLine - 1 + slice.length < lines.length ? `\n[${lines.length} lines total; more available]` : "";
    return { content: `${toRel(ctx.workspace, abs)}\n${body}${more}` };
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  effect: "write",
  description: "Create or overwrite a text file in the workspace with the full content given. Creates parent folders.",
  schema: z.object({
    path: z.string().describe("Workspace-relative path"),
    content: z.string().describe("Complete new file content"),
  }),
  async run({ path, content }, ctx) {
    throwIfAborted(ctx.signal);
    const abs = resolveInWorkspace(ctx.workspace, path, "write");
    await mkdir(dirname(abs), { recursive: true });
    // Editors and dev-server watchers briefly lock files on Windows (EBUSY/EPERM).
    for (let attempt = 0; ; attempt++) {
      try {
        await writeFile(abs, content, "utf8");
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== "EBUSY" && code !== "EPERM")) throw err;
        await sleep(100 * 2 ** attempt, ctx.signal);
      }
    }
    const rel = toRel(ctx.workspace, abs);
    ctx.log(`wrote ${rel} (${content.length} chars)`);
    return { content: `Wrote ${rel} (${content.split("\n").length} lines).` };
  },
});

const SKIP_DIRS = new Set(["node_modules", ".git", ".kira", "dist", "build", ".next", "coverage"]);

export const listDirTool = defineTool({
  name: "list_dir",
  effect: "read",
  description: "List files and folders in a workspace directory, up to `depth` levels. Skips node_modules, .git and build output.",
  schema: z.object({
    path: z.string().optional().describe("Workspace-relative directory (default: workspace root)"),
    depth: z.number().min(1).max(4).optional().describe("Levels to descend (default 2)"),
  }),
  async run({ path = ".", depth = 2 }, ctx) {
    const root = resolveInWorkspace(ctx.workspace, path, "read");
    if (!(await stat(root)).isDirectory()) return { content: `${path} is not a directory`, isError: true };
    const out: string[] = [];
    const walk = async (dir: string, level: number, indent: string) => {
      throwIfAborted(ctx.signal);
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
      );
      for (const e of entries) {
        if (out.length >= 500) return;
        if (e.name.startsWith(".env")) continue;
        if (e.isDirectory()) {
          const skipped = SKIP_DIRS.has(e.name);
          out.push(`${indent}${e.name}/${skipped ? " (skipped)" : ""}`);
          if (!skipped && level < depth) await walk(`${dir}/${e.name}`, level + 1, indent + "  ");
        } else {
          out.push(`${indent}${e.name}`);
        }
      }
    };
    await walk(root, 1, "");
    return { content: out.length ? out.join("\n") : "(empty)" };
  },
});
