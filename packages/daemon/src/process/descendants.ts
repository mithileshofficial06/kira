import { execFile } from "node:child_process";

interface ProcRow {
  pid: number;
  ppid: number;
}

/** Runs a command and returns its stdout and its own PID (so it can be left out of the table). */
function run(file: string, args: string[]): Promise<{ stdout: string; pid: number | undefined }> {
  return new Promise((resolve, reject) => {
    // Capped: this runs inside the kill path, and a slow machine must not delay a "stop".
    const child = execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 5_000 }, (err, stdout) =>
      err ? reject(err) : resolve({ stdout, pid: child.pid }),
    );
  });
}

async function processTable(): Promise<ProcRow[]> {
  const { stdout, pid: self } =
    process.platform === "win32"
      ? await run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
        ])
      : await run("ps", ["-A", "-o", "pid=,ppid="]);
  // The listing process is a child of ours; it is not part of any tree we care about.
  return parseRows(stdout).filter((r) => r.pid !== self && r.ppid !== self);
}

function parseRows(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [a, b] = line.trim().split(/\s+/);
    const pid = Number(a);
    const ppid = Number(b);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && pid > 0) rows.push({ pid, ppid });
  }
  return rows;
}

/** All descendants of `root` (not including root), found by walking parent PIDs. */
export async function listDescendants(root: number): Promise<number[]> {
  const rows = await processTable();
  const children = new Map<number, number[]>();
  for (const { pid, ppid } of rows) {
    if (pid === ppid) continue; // System Idle Process on Windows
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const stack = [...(children.get(root) ?? [])];
  const seen = new Set<number>([root]);
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}
