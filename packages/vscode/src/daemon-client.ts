/**
 * Starts the Kira daemon as a child process and talks to it over its named
 * pipe. The daemon outlives window reloads' worth of work inside one session
 * and exits when this extension host closes its stdin.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import type { KiraEvent } from "../../daemon/src/control/events.js";
import { emptyDeck, reduceDeck, type DeckState } from "../../daemon/src/daemon/deck.js";
import { Methods, type EventNotification, type HelloResult } from "../../daemon/src/daemon/protocol.js";
import { pipeName } from "./pipe.js";

export class DaemonClient implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<KiraEvent>();
  readonly onEvent = this.emitter.event;
  private readonly exitEmitter = new vscode.EventEmitter<void>();
  readonly onExit = this.exitEmitter.event;
  deck: DeckState = emptyDeck();
  private disposed = false;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly conn: MessageConnection,
  ) {
    conn.onNotification(Methods.event, (n: EventNotification) => {
      this.deck = reduceDeck(this.deck, n.event);
      this.emitter.fire(n.event);
    });
    proc.once("exit", () => {
      if (!this.disposed) this.exitEmitter.fire();
    });
  }

  static async start(extensionPath: string, workspace: string, output: vscode.OutputChannel): Promise<DaemonClient> {
    const cfg = vscode.workspace.getConfiguration("kira");
    const node = cfg.get<string>("nodePath") || "node";
    const token = randomBytes(24).toString("hex");
    const pipe = pipeName(workspace);
    const { args, cwd } = daemonCommand(extensionPath, cfg.get<string>("daemonPath") ?? "");
    output.appendLine(`[kira] starting daemon: ${node} ${args.join(" ")}`);

    const proc = spawn(node, [...args, "--workspace", workspace, "--pipe", pipe], {
      cwd,
      env: { ...process.env, KIRA_DAEMON_TOKEN: token, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.stderr?.on("data", (d: Buffer) => output.append(d.toString()));

    await new Promise<void>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("the Kira daemon did not start within 30s (see the Kira output channel)")), 30_000);
      proc.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`could not start "${node}": ${err.message}. Set kira.nodePath to Node 22.13+.`));
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`the Kira daemon exited with code ${code} during startup (see the Kira output channel)`));
      });
      proc.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        if (buf.includes("KIRA_DAEMON_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const socket = connect(pipe);
    await new Promise<void>((r, j) => socket.once("connect", r).once("error", j));
    const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    const client = new DaemonClient(proc, conn);
    conn.listen();
    const hello = await conn.sendRequest<HelloResult>(Methods.hello, { token, client: "vscode" });
    client.deck = hello.deck;
    output.appendLine(`[kira] daemon ready (pid ${hello.pid}) for ${hello.workspace}`);
    return client;
  }

  request<R>(method: string, params: unknown = {}): Promise<R> {
    return this.conn.sendRequest<R>(method, params);
  }

  get running(): boolean {
    const s = this.deck.run?.state;
    return !!s && s !== "IDLE" && !this.deck.report;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.conn.dispose();
    // Closing stdin asks the daemon to stop any run cleanly and exit.
    this.proc.stdin?.end();
    const t = setTimeout(() => this.proc.kill(), 20_000);
    this.proc.once("exit", () => clearTimeout(t));
    this.emitter.dispose();
    this.exitEmitter.dispose();
  }
}

/** The built daemon if present, else its TypeScript source through tsx (monorepo development). */
function daemonCommand(extensionPath: string, configured: string): { args: string[]; cwd: string } {
  if (configured) return { args: [configured], cwd: dirname(configured) };
  const pkg = join(extensionPath, "..", "daemon");
  const built = join(pkg, "dist", "daemon", "main.js");
  if (existsSync(built)) return { args: [built], cwd: pkg };
  return { args: ["--import", "tsx", join(pkg, "src", "daemon", "main.ts")], cwd: pkg };
}
