# Windows process trees: findings

Measured on Windows 11, Node 24.19, node-pty 1.1.0. These findings shape `src/process/` and the PTY session. Each one was found by a test, not assumed.

## 1. Plain Node → Node chains do not orphan

`child.kill()` on the root of node → node → node took down all three. libuv puts every process spawned by Node into a Job Object with `KILL_ON_JOB_CLOSE`, so when the root dies, its job closes and the tree goes with it.

**Consequence:** a test that only uses `child_process.spawn` proves nothing about Kira's real case.

## 2. ConPTY trees are not in libuv's job

Commands run inside a PTY (`node-pty` → ConPTY → `cmd.exe` → …) are outside libuv's job, so Kira kills them itself (§3).

**Not covered yet:** processes that detach from the console (`start`, daemonized workers). Job Objects created by Kira (native helper) are the upgrade path. They would also catch processes spawned *after* the snapshot in §3.

## 3. Kira's kill sequence (PTY sessions)

1. Snapshot descendants of the shell PID (CIM process table).
2. `taskkill /T /F /PID <shell>`, which walks the tree by parent PID.
3. Kill any snapshot PID still alive. This catches children whose parent already died, which `/T` cannot see.
4. Close the pseudo-console (`term.kill()`, see §6).
5. Verify every snapshot PID is gone, or report the survivors.

Proven by `test/chaos.test.ts`: 10 random interrupts in a row across a 10-step run (writes, short commands, a background server, a nested tree), each followed by zero stray descendants and a working tree identical to the last checkpoint.

## 4. node-pty argument quoting

On Windows, `pty.spawn(file, string[])` re-quotes each argv entry, so a quoted path inside an entry is mangled (`"\"C:\\...\""`). Pass the command line as a **single string** (`pty.spawn("cmd.exe", '/d /s /c "node \"C:\\path\" 2"')`).

## 5. The default ConPTY kill is noisy

With the system ConPTY, `term.kill()` forks `conpty_console_list_agent.js` to list console processes. It often crashes with `AttachConsole failed` on stderr. Kira uses **`useConptyDll: true`** (node-pty's bundled ConPTY), whose `kill()` closes the pseudo-console directly with no agent.

## 6. Every PTY leaks a console host unless it is closed

Found by the chaos test: after a command exits normally, its `conhost.exe` / `OpenConsole.exe` stays alive as a child of the daemon until `term.kill()` releases the pseudo-console. With four commands per run, that meant four stray processes per run. `PtyProcess` now closes the console on exit and after every kill.

## 7. The bundled console host stalls 3 s on startup

`OpenConsole.exe` sends a Device Attributes query (`ESC [ c`) and waits about 3 s for the terminal to answer. Nothing answers in a headless PTY, so every command took about 3.2 s. `PtyProcess` replies `ESC [ ? 1 ; 0 c` (VT100) on the first query.

| Setup | `node -e "console.log('hi')"` |
|---|---|
| System ConPTY | ~1,130 ms |
| Bundled ConPTY, no DA reply | ~3,170 ms |
| Bundled ConPTY + DA reply | **~150 ms** |
