import { execFile } from "node:child_process";

export class GitError extends Error {
  override name = "GitError";
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim().split("\n")[0]}`);
  }
}

export interface GitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** Runs git and returns trimmed stdout. Never goes through a shell. */
export function git(args: string[], opts: GitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(args, stderr || err.message, typeof err.code === "number" ? err.code : null));
        else resolve(stdout.replace(/\s+$/, ""));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
