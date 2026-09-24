# Windows process trees: findings

Measured on Windows 11, Node 24.19, node-pty 1.1.0. These findings shape `src/process/` and the PTY session.

## 1. Plain Node → Node chains do not orphan

`child.kill()` on the root of node → node → node took down all three. libuv puts every process spawned by Node into a Job Object with `KILL_ON_JOB_CLOSE`, so when the root dies, its job closes and the tree goes with it.

**Consequence:** a test that only uses `child_process.spawn` proves nothing about Kira's real case.

## 2. ConPTY trees are not in libuv's job

Commands run inside a PTY (`node-pty` → ConPTY → `cmd.exe` → …) are outside libuv's job. `pty.kill()` still killed a 3-deep tree in testing, because node-pty enumerates the processes attached to the console and kills them. It also printed a noisy `AttachConsole failed` from `conpty_console_list_agent.js`.

**Not covered:** processes that detach from the console (`start`, daemonized workers, some dev-server helpers). They are not attached to the pseudo-console, so neither mechanism reaches them.

## 3. Kira's kill sequence (PTY sessions)

1. Snapshot descendants of the shell PID.
2. `pty.kill()`.
3. `taskkill /T /F /PID <shell>`, which walks the tree by parent PID.
4. Kill any snapshot PID still alive. This catches children whose parent already died, which `/T` cannot see.
5. Verify every snapshot PID is gone, or report the survivors.

Job Objects created by Kira itself (native helper) are the Phase 1 upgrade. They also catch processes spawned *after* the snapshot.

## 4. node-pty argument quoting

On Windows, `pty.spawn(file, string[])` re-quotes each argv entry, so a quoted path inside an entry is mangled (`"\"C:\\...\""`). Pass the command line as a **single string** (`pty.spawn("cmd.exe", '/c node "C:\\path" 2')`).

## 5. node-pty keeps Node alive

After the shell exits, the ConPTY agent can keep the event loop alive. The PTY session must dispose of the terminal explicitly on exit.
