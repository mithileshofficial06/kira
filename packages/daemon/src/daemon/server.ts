/**
 * The Kira daemon (spec §7): owns runs, processes and memory for one
 * workspace, and serves the VS Code extension over JSON-RPC on a named pipe
 * (a Unix socket elsewhere). The extension host is single-threaded and dies on
 * window reload; a 25-minute run cannot live there, so it lives here.
 *
 * Security: the pipe is local-only, and every connection must present the
 * per-session token in kira/hello before any other call is answered.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessageConnection,
  ResponseError,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { ChatFn } from "../agent/loop.js";
import type { AutonomyLevel } from "../control/autonomy.js";
import type { KiraEvent, RunReport } from "../control/events.js";
import { runSession, type Verifier } from "../control/runner.js";
import type { Price, Role } from "../config/models.js";
import type { KiraMemory } from "../memory/run-memory.js";
import { MemoryStore } from "../memory/store.js";
import type { ApprovalAnswer, Approver } from "../tools/index.js";
import { AbortedError } from "../util/abort.js";
import { p50, VoiceBridge, type VoiceHost, type VoiceOptions } from "../voice/bridge.js";
import { emptyDeck, reduceDeck, type DeckState } from "./deck.js";
import {
  Methods,
  PROTOCOL_VERSION,
  type ApproveParams,
  type HelloParams,
  type HelloResult,
  type MemoryItemView,
  type MemoryListParams,
  type RememberParams,
  type StartParams,
  type StartResult,
  type VoiceStatus,
} from "./protocol.js";

export interface DaemonOptions {
  workspace: string;
  pipe: string;
  token: string;
  chatFor: (role: Role) => ChatFn;
  pricing?: Record<string, Price>;
  verifier?: () => Verifier | undefined;
  memory?: KiraMemory;
  /** Initialize git in a workspace that has none (off by default: never behind the user's back). */
  initGit?: boolean;
  defaults?: { autonomy?: AutonomyLevel; plan?: boolean; verify?: boolean; maxSteps?: number; maxCostUsd?: number };
  log?: (line: string) => void;
  /** Enables voice/start: the sidecar's settings (the Mistral key for Voxtral, python path). */
  voice?: Omit<VoiceOptions, "log">;
}

/** A pipe name unique to this workspace and daemon instance. */
export function pipeName(workspace: string, nonce = randomBytes(4).toString("hex")): string {
  const h = createHash("sha256").update(workspace.toLowerCase()).digest("hex").slice(0, 12);
  return process.platform === "win32" ? `\\\\.\\pipe\\kira-${h}-${nonce}` : join(tmpdir(), `kira-${h}-${nonce}.sock`);
}

interface Client {
  conn: MessageConnection;
  authed: boolean;
}

export class KiraDaemon {
  private server: Server | undefined;
  private readonly clients = new Set<Client>();
  private deck: DeckState = emptyDeck();
  private seq = 0;
  private current: { controller: AbortController; done: Promise<RunReport> } | undefined;
  private readonly pending = new Map<string, (a: ApprovalAnswer) => void>();
  private approvalSeq = 0;

  constructor(private readonly opts: DaemonOptions) {}

  get snapshot(): DeckState {
    return this.deck;
  }

  get running(): boolean {
    return this.current !== undefined;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      server.once("error", reject);
      server.listen(this.opts.pipe, () => {
        server.off("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  /** Stops any run (cleanly: processes killed, step rewound), then closes every connection. */
  async close(): Promise<void> {
    if (this.current) {
      this.current.controller.abort("daemon shutting down");
      await this.current.done.catch(() => undefined);
    }
    await this.voice?.stop();
    for (const c of this.clients) c.conn.dispose();
    this.clients.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.opts.memory?.close();
  }

  private onConnection(socket: Socket): void {
    const conn = createMessageConnection(new SocketMessageReader(socket), new SocketMessageWriter(socket));
    const client: Client = { conn, authed: false };
    this.clients.add(client);
    const drop = () => {
      this.clients.delete(client);
      conn.dispose();
    };
    socket.on("close", drop);
    socket.on("error", drop);

    const authed =
      <P, R>(fn: (p: P) => R | Promise<R>) =>
      async (p: P): Promise<R> => {
        if (!client.authed) throw new ResponseError(-32001, "unauthorized: call kira/hello with the session token first");
        return fn(p);
      };

    conn.onRequest(Methods.hello, (p: HelloParams): HelloResult => {
      if (!tokenMatches(p?.token, this.opts.token)) {
        this.opts.log?.(`rejected a connection with a bad token (${p?.client ?? "unknown client"})`);
        // Let the error response flush, then hang up.
        setTimeout(() => socket.end(), 100).unref();
        throw new ResponseError(-32001, "unauthorized");
      }
      client.authed = true;
      return { version: PROTOCOL_VERSION, workspace: this.opts.workspace, pid: process.pid, deck: this.deck };
    });
    conn.onRequest(Methods.start, authed((p: StartParams) => this.start(p)));
    conn.onRequest(Methods.stop, authed(() => this.stop()));
    conn.onRequest(Methods.approve, authed((p: ApproveParams) => this.approve(p)));
    conn.onRequest(Methods.snapshot, authed(() => this.deck));
    conn.onRequest(
      Methods.leftOff,
      authed(async () => ({ text: this.opts.memory ? (await this.opts.memory.leftOff(new AbortController().signal)).text : "Memory is not enabled." })),
    );
    conn.onRequest(Methods.memoryList, authed((p: MemoryListParams) => this.memoryList(p)));
    conn.onRequest(
      Methods.memoryReject,
      authed((p: { id: number }) => {
        this.opts.memory?.store.reject(p.id);
        return { ok: true };
      }),
    );
    conn.onRequest(
      Methods.memoryKeep,
      authed((p: { id: number }) => {
        this.opts.memory?.store.keep(p.id);
        return { ok: true };
      }),
    );
    conn.onRequest(Methods.remember, authed((p: RememberParams) => this.remember(p)));
    conn.onRequest(Methods.voiceStart, authed(() => this.voiceStart()));
    conn.onRequest(Methods.voiceStop, authed(() => this.voiceStop()));
    conn.onRequest(Methods.voiceStatus, authed(() => this.voiceStatus()));
    conn.listen();
  }

  // ---- VoiceHost: what the voice bridge (and the headless CLI) drive -----------------
  private readonly subscribers = new Set<(e: KiraEvent) => void>();
  onEvent(fn: (e: KiraEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
  deckState(): DeckState {
    return this.deck;
  }
  startRun(goal: string, extra: Omit<StartParams, "goal"> = {}): StartResult {
    return this.start({ ...extra, goal });
  }
  stopRun(): Promise<{ stopped: boolean }> {
    return this.stop();
  }
  approveRequest(id: string, allow: boolean, note?: string): { ok: boolean } {
    return this.approve({ id, allow, ...(note ? { note } : {}) });
  }
  async leftOffText(): Promise<string> {
    return this.opts.memory ? (await this.opts.memory.leftOff(new AbortController().signal)).text : "Memory is not enabled.";
  }
  /** Done when the current run (if any) has finished. */
  async idle(): Promise<void> {
    await this.current?.done.catch(() => undefined);
  }

  private emit(event: KiraEvent): void {
    this.deck = reduceDeck(this.deck, event);
    for (const s of this.subscribers) {
      try {
        s(event);
      } catch (err) {
        this.opts.log?.(`event subscriber failed: ${(err as Error).message}`);
      }
    }
    const note = { seq: ++this.seq, event };
    for (const c of this.clients) if (c.authed) void c.conn.sendNotification(Methods.event, note).catch(() => undefined);
  }

  private start(p: StartParams): StartResult {
    if (this.current) throw new ResponseError(-32002, "a run is already in progress; stop it first");
    if (!p?.goal?.trim()) throw new ResponseError(-32602, "goal is required");
    const d = this.opts.defaults ?? {};
    const controller = new AbortController();
    const runId = `run-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
    const autonomy = (p.autonomy ?? d.autonomy ?? 3) as AutonomyLevel;
    const verify = p.verify ?? d.verify ?? true;
    const done = runSession({
      goal: p.goal.trim(),
      workspace: this.opts.workspace,
      runId,
      chatFor: this.opts.chatFor,
      approver: this.approver,
      signal: controller.signal,
      autonomy,
      plan: p.plan ?? d.plan ?? true,
      initGit: this.opts.initGit,
      limits: { maxSteps: p.maxSteps ?? d.maxSteps ?? 40, maxCostUsd: p.maxCostUsd ?? d.maxCostUsd ?? 2 },
      pricing: this.opts.pricing,
      verifier: verify ? this.opts.verifier?.() : undefined,
      memory: this.opts.memory,
      onEvent: (e) => this.emit(e),
    });
    this.current = { controller, done };
    void done
      .catch((err: unknown) => {
        this.opts.log?.(`run ${runId} crashed: ${(err as Error).stack ?? String(err)}`);
        this.emit({ type: "agent", event: { type: "note", step: 0, text: `run crashed: ${(err as Error).message}` } });
      })
      .finally(() => {
        this.current = undefined;
      });
    return { runId };
  }

  private async stop(): Promise<{ stopped: boolean }> {
    if (!this.current) return { stopped: false };
    this.current.controller.abort("stopped from the Flight Deck");
    await this.current.done.catch(() => undefined);
    return { stopped: true };
  }

  /** Human approvals go out as events; the answer comes back through run/approve. */
  private readonly approver: Approver = (request, signal) =>
    new Promise<ApprovalAnswer>((resolve, reject) => {
      const id = `ap${++this.approvalSeq}`;
      const onAbort = () => {
        this.pending.delete(id);
        this.emit({ type: "approval_resolved", id, allow: false, note: "run interrupted" });
        reject(new AbortedError(signal.reason));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, (answer) => {
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        this.emit({ type: "approval_resolved", id, allow: answer.allow, ...(answer.note ? { note: answer.note } : {}) });
        resolve(answer);
      });
      this.emit({ type: "approval", id, request });
    });

  private approve(p: ApproveParams): { ok: boolean } {
    const resolve = this.pending.get(p.id);
    if (!resolve) return { ok: false };
    resolve({ allow: !!p.allow, ...(p.note?.trim() ? { note: p.note.trim() } : {}) });
    return { ok: true };
  }

  private memoryList(p: MemoryListParams = {}): MemoryItemView[] {
    const store = this.opts.memory?.store;
    if (!store) return [];
    return store.list({ ...(p.kind ? { kind: p.kind } : {}), ...(p.review ? { review: p.review } : {}), limit: p.limit ?? 50 }).map((i) => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      body: i.body,
      review: i.review,
      createdAt: i.createdAt,
      ...(i.kind === "adr" ? { adrId: MemoryStore.adrId(i) } : {}),
    }));
  }

  // ---- voice ------------------------------------------------------------------------
  private voice: VoiceBridge | undefined;
  private voiceError: string | undefined;

  async voiceStart(): Promise<VoiceStatus> {
    if (this.voice?.running) return this.voiceStatus();
    if (!this.opts.voice) throw new ResponseError(-32004, "voice is not configured: set MISTRAL_API_KEY for Voxtral");
    const host: VoiceHost = {
      deck: () => this.deck,
      startRun: (goal) => this.startRun(goal),
      stopRun: () => this.stopRun(),
      approve: (id, allow, note) => this.approveRequest(id, allow, note),
      leftOff: () => this.leftOffText(),
      onEvent: (fn) => this.onEvent(fn),
      chat: this.opts.chatFor("utility"),
      workspace: this.opts.workspace,
    };
    this.voice = new VoiceBridge(host, { ...this.opts.voice, log: this.opts.log });
    this.voiceError = undefined;
    try {
      await this.voice.start();
    } catch (err) {
      this.voiceError = (err as Error).message;
      this.voice = undefined;
      throw new ResponseError(-32005, `voice failed to start: ${this.voiceError}`);
    }
    return this.voiceStatus();
  }

  /** Tests: a sidecar started with --source inject hears `text` as speech. */
  voiceHear(text: string): void {
    this.voice?.hear(text);
  }

  async voiceStop(): Promise<VoiceStatus> {
    await this.voice?.stop();
    this.voice = undefined;
    return this.voiceStatus();
  }

  voiceStatus(): VoiceStatus {
    const v = this.voice;
    const acks = v?.latencies.filter((l) => l.kind === "ack").map((l) => l.ms) ?? [];
    const med = p50(acks);
    return {
      running: !!v?.running,
      ...(v?.ready ? { input: v.ready.input, output: v.ready.output, wake: v.ready.wake, voice: v.ready.voice } : {}),
      ...(med !== undefined ? { ackP50Ms: med } : {}),
      samples: acks.length,
      ...(this.voiceError ? { error: this.voiceError } : {}),
    };
  }

  private async remember(p: RememberParams): Promise<{ id: number }> {
    const store = this.opts.memory?.store;
    if (!store) throw new ResponseError(-32003, "memory is not enabled");
    const text = p.text.trim();
    if (!text) throw new ResponseError(-32602, "text is required");
    const item = await store.add({ kind: p.kind === "fact" ? "fact" : "preference", title: text.slice(0, 120), body: text, source: "user" });
    this.emit({ type: "memory", items: [{ id: item.id, kind: item.kind, title: item.title }], note: "remembered" });
    return { id: item.id };
  }
}

function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
