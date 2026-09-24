/**
 * Starts the Kira daemon as a child process and talks to it over its named
 * pipe. The daemon outlives window reloads' worth of work inside one session
 * and exits when this extension host closes its stdin.
 *
 * Or attaches to a daemon someone else started (`npm run kira` in a VS Code
 * terminal): then the extension is only a client, and the daemon's life is
 * the terminal's.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { createMessageConnection, SocketMessageReader, SocketMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import type { KiraEvent } from "../../daemon/src/control/events.js";
import { emptyDeck, reduceDeck, type DeckState } from "../../daemon/src/daemon/deck.js";
import { Methods, type EventNotification, type HelloResult, type VoiceUiEvent } from "../../daemon/src/daemon/protocol.js";
import { pipeName } from "./pipe.js";

export class DaemonClient implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<KiraEvent>();
  readonly onEvent = this.emitter.event;
  private readonly exitEmitter = new vscode.EventEmitter<void>();
  readonly onExit = this.exitEmitter.event;
  private readonly voiceEmitter = new vscode.EventEmitter<VoiceUiEvent>();
  readonly onVoice = this.voiceEmitter.event;
  deck: DeckState = emptyDeck();
  workspace = "";
  private disposed = false;
  private exited = false;

  /** proc is undefined when attached to a daemon this extension did not start. */
  private constructor(
    private readonly proc: ChildProcess | undefined,
    private readonly conn: MessageConnection,
    socket: Socket,
  ) {
    conn.onNotification(Methods.event, (n: EventNotification) => {
      this.deck = reduceDeck(this.deck, n.event);
      this.emitter.fire(n.event);
    });
    conn.onNotification(Methods.voiceEvent, (e: VoiceUiEvent) => this.voiceEmitter.fire(e));
    const gone = () => {
      if (!this.disposed && !this.exited) {
        this.exited = true;
        this.exitEmitter.fire();
      }
    };
    if (proc) proc.once("exit", gone);
    else socket.once("close", gone);
  }

  get attached(): boolean {
    return !this.proc;
  }

  /** Connects to a running daemon's pipe and authenticates with its session token. */
  static async attach(pipe: string, token: string, output: vscode.OutputChannel): Promise<DaemonClient> {
    return DaemonClient.connectTo(undefined, pipe, token, output);
  }

  private static async connectTo(proc: ChildProcess | undefined, pipe: string, token: string, output: vscode.OutputChannel): Promise<DaemonClient> {
    const socket = connect(pipe);
    await new Promise<void>((r, j) => socket.once("connect", r).once("error", j));
    const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    const client = new DaemonClient(proc, conn, socket);
    conn.listen();
    const hello = await conn.sendRequest<HelloResult>(Methods.hello, { token, client: "vscode" });
    client.deck = hello.deck;
    client.workspace = hello.workspace;
    output.appendLine(`[kira] ${proc ? "daemon ready" : "attached to the daemon"} (pid ${hello.pid}) for ${hello.workspace}`);
    return client;
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

    return DaemonClient.connectTo(proc, pipe, token, output);
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
    const proc = this.proc;
    if (proc) {
      // Closing stdin asks the daemon to stop any run cleanly and exit. An attached daemon belongs to its terminal.
      proc.stdin?.end();
      const t = setTimeout(() => proc.kill(), 20_000);
      proc.once("exit", () => clearTimeout(t));
    }
    this.emitter.dispose();
    this.exitEmitter.dispose();
    this.voiceEmitter.dispose();
  }
}

/** Where the daemon package was when this extension was built (set by esbuild), for an installed VSIX. */
declare const __KIRA_DAEMON_DIR__: string | undefined;

/** The built daemon if present, else its TypeScript source through tsx (monorepo development). */
function daemonCommand(extensionPath: string, configured: string): { args: string[]; cwd: string } {
  if (configured) return { args: [configured], cwd: dirname(configured) };
  const beside = join(extensionPath, "..", "daemon");
  const recorded = typeof __KIRA_DAEMON_DIR__ === "string" ? __KIRA_DAEMON_DIR__ : "";
  const pkg = existsSync(join(beside, "package.json")) || !recorded ? beside : recorded;
  const built = join(pkg, "dist", "daemon", "main.js");
  if (existsSync(built)) return { args: [built], cwd: pkg };
  return { args: ["--import", "tsx", join(pkg, "src", "daemon", "main.ts")], cwd: pkg };
}
