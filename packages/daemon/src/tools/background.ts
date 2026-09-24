import { PtyProcess, type KillReport } from "../process/pty-process.js";
import { stripAnsi } from "../util/text.js";

interface Entry {
  id: string;
  command: string;
  proc: PtyProcess;
  output: string;
}

const MAX_BUFFER = 200_000;

/**
 * Long-running processes (dev servers, watchers) started by the agent. The
 * run owns them: stopAll() is called on finish, failure and interrupt.
 */
export class BackgroundManager {
  private readonly entries = new Map<string, Entry>();
  private next = 1;

  start(command: string, cwd: string, onTerminal?: (id: string, data: string) => void): Entry {
    const id = `bg${this.next++}`;
    const proc = PtyProcess.spawn(command, { cwd });
    const entry: Entry = { id, command, proc, output: "" };
    proc.onData((d) => {
      entry.output = (entry.output + stripAnsi(d)).slice(-MAX_BUFFER);
      onTerminal?.(id, d);
    });
    this.entries.set(id, entry);
    return entry;
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  list(): { id: string; command: string; running: boolean }[] {
    return [...this.entries.values()].map((e) => ({ id: e.id, command: e.command, running: !e.proc.hasExited }));
  }

  async stop(id: string): Promise<KillReport | undefined> {
    const e = this.entries.get(id);
    if (!e) return undefined;
    this.entries.delete(id);
    return e.proc.kill();
  }

  async stopAll(): Promise<KillReport[]> {
    return Promise.all([...this.entries.keys()].map((id) => this.stop(id))).then((r) =>
      r.filter((x): x is KillReport => x !== undefined),
    );
  }
}
