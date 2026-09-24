import { rm } from "node:fs/promises";
import { join } from "node:path";
import { git, GitError } from "./git.js";

export interface Checkpoint {
  runId: string;
  step: number;
  sha: string;
  ref: string;
}

export interface RestoreReport {
  /** Files written back from the checkpoint. */
  restored: string[];
  /** Files that did not exist at the checkpoint and were deleted. */
  removed: string[];
  /** Snapshot taken just before the rewind, so the rewind itself can be undone. */
  undo: Checkpoint;
}

const REF_ROOT = "refs/kira/checkpoints";
const AUTHOR = {
  GIT_AUTHOR_NAME: "kira",
  GIT_AUTHOR_EMAIL: "kira@localhost",
  GIT_COMMITTER_NAME: "kira",
  GIT_COMMITTER_EMAIL: "kira@localhost",
};

/**
 * Git-backed checkpoints on shadow refs (spec §4.1).
 *
 * Snapshots go through a private index file (GIT_INDEX_FILE), so the user's
 * staging area, HEAD and branch history are never touched. Scope is the
 * working tree as git sees it: tracked plus untracked-but-not-ignored files.
 * Ignored files (node_modules, .env, build output) are neither saved nor
 * restored; out-of-repo side effects are the gate's job, not this class's.
 */
export class CheckpointManager {
  private constructor(
    readonly workspace: string,
    private readonly gitDir: string,
  ) {}

  static async open(workspace: string, opts: { initIfMissing?: boolean } = {}): Promise<CheckpointManager> {
    let gitDir: string;
    try {
      gitDir = await git(["rev-parse", "--absolute-git-dir"], { cwd: workspace });
    } catch (err) {
      if (!opts.initIfMissing || !(err instanceof GitError)) throw err;
      await git(["init", "-q"], { cwd: workspace });
      gitDir = await git(["rev-parse", "--absolute-git-dir"], { cwd: workspace });
    }
    return new CheckpointManager(workspace, gitDir);
  }

  private get indexEnv(): NodeJS.ProcessEnv {
    return { GIT_INDEX_FILE: join(this.gitDir, "kira-index") };
  }

  private run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
    return git(args, { cwd: this.workspace, env: { ...this.indexEnv, ...AUTHOR, ...env } });
  }

  static ref(runId: string, step: number | string): string {
    if (!/^[\w.-]+$/.test(runId)) throw new Error(`Invalid run id "${runId}"`);
    return `${REF_ROOT}/${runId}/${step}`;
  }

  /** Writes the current working tree to a tree object via the private index. */
  private async snapshotTree(): Promise<string> {
    // `add -A` against the private index stages exactly what git would see:
    // tracked changes, deletions, and untracked files that are not ignored.
    await this.run(["add", "-A", "--", "."]);
    return this.run(["write-tree"]);
  }

  private async headSha(): Promise<string | undefined> {
    try {
      return await this.run(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
    } catch {
      return undefined; // unborn branch
    }
  }

  private async resolve(ref: string): Promise<string | undefined> {
    try {
      return await this.run(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    } catch {
      return undefined;
    }
  }

  /** Snapshots the working tree as checkpoint `step` of `runId`. */
  async create(runId: string, step: number | string, message = `kira checkpoint ${runId}/${step}`): Promise<Checkpoint> {
    const tree = await this.snapshotTree();
    const previous = (await this.list(runId)).at(-1);
    const parent = previous?.sha ?? (await this.headSha());
    const sha = await this.run(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
    const ref = CheckpointManager.ref(runId, step);
    await this.run(["update-ref", ref, sha]);
    return { runId, step: Number(step), sha, ref };
  }

  /** Checkpoints of a run, oldest first. */
  async list(runId: string): Promise<Checkpoint[]> {
    const out = await this.run(["for-each-ref", "--format=%(refname) %(objectname)", `${REF_ROOT}/${runId}/`]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, sha] = line.split(" ") as [string, string];
        const step = Number(ref.slice(ref.lastIndexOf("/") + 1));
        return { runId, step, sha, ref };
      })
      .filter((c) => Number.isFinite(c.step))
      .sort((a, b) => a.step - b.step);
  }

  /**
   * Makes the working tree match checkpoint `step` of `runId`. A snapshot of
   * the current state is taken first (returned as `undo`).
   */
  async restore(runId: string, step: number): Promise<RestoreReport> {
    const target = await this.resolve(CheckpointManager.ref(runId, step));
    if (!target) throw new Error(`No checkpoint ${runId}/${step}`);

    const undo = await this.create(`${runId}-undo`, Date.now(), `kira pre-rewind snapshot of ${runId} before restoring step ${step}`);

    // Files present now but absent at the target were created after it: delete them.
    const added = await this.run(["diff", "--name-only", "--no-renames", "-z", "--diff-filter=A", target, undo.sha]);
    const removed = added.split("\0").filter(Boolean);
    for (const f of removed) await rm(join(this.workspace, f), { force: true });

    // Everything else: load the target tree into the private index and write it out.
    const changed = await this.run(["diff", "--name-only", "--no-renames", "-z", "--diff-filter=DMT", target, undo.sha]);
    const restored = changed.split("\0").filter(Boolean);
    await this.run(["read-tree", target]);
    if (restored.length) {
      await git(["checkout-index", "-f", "-z", "--stdin"], {
        cwd: this.workspace,
        env: { ...this.indexEnv },
        input: restored.join("\0") + "\0",
      });
    }
    return { restored, removed, undo };
  }

  /** Deletes every checkpoint ref of a run (and its undo snapshots). */
  async drop(runId: string): Promise<void> {
    for (const id of [runId, `${runId}-undo`]) {
      for (const c of await this.list(id)) await this.run(["update-ref", "-d", c.ref]);
    }
  }
}
