import { execFile } from "node:child_process";

interface ProcRow {
  pid: number;
  ppid: number;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

async function processTable(): Promise<ProcRow[]> {
  if (process.platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }",
    ]);
    return parseRows(out);
  }
  return parseRows(await run("ps", ["-A", "-o", "pid=,ppid="]));
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
