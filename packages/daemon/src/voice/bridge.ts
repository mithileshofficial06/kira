/**
 * The daemon side of voice (spec §9.2): runs the Python sidecar as a child
 * process, routes what it hears, and speaks what the run needs to say.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { KiraEvent } from "../control/events.js";
import { pendingApprovals, type DeckState } from "../daemon/deck.js";
import { scrubSecrets } from "../process/pty-process.js";
import type { ChatFn } from "../agent/loop.js";
import { Conversation } from "./converse.js";
import { classify, TASK } from "./intents.js";
import { narrate, statusLine } from "./narrator.js";
import { projectVocabulary } from "./vocab.js";

/** What the sidecar sends (see packages/voice/kira_voice/protocol.py). */
export type VoiceEvent =
  | { type: "ready"; input: string; output: string; wake: string; voice: string }
  | { type: "wake"; at: number }
  | { type: "utterance"; text: string; heard: string; source: string; endOfSpeechAt: number }
  | { type: "stop"; heard: string; endOfSpeechAt: number }
  | { type: "speaking"; state: "start" | "end"; id: string }
  | { type: "latency"; kind: "ack" | "stop"; ms: number }
  | { type: "level"; rms: number; speech: boolean }
  | { type: "log"; level: string; msg: string };

/**
 * What a UI (the VS Code assistant) sees: the sidecar's events plus what Kira
 * decided to say, and typed messages the bridge answered.
 */
export type VoiceUiEvent = VoiceEvent | { type: "say"; id: string; text: string } | { type: "typed"; text: string };

/** The parts of the daemon voice needs. KiraDaemon implements it. */
export interface VoiceHost {
  deck(): DeckState;
  startRun(goal: string): Promise<{ runId: string }> | { runId: string };
  stopRun(): Promise<unknown>;
  approve(id: string, allow: boolean, note?: string): unknown;
  leftOff(): Promise<string>;
  onEvent(fn: (e: KiraEvent) => void): () => void;
  /** The utility model, for answering conversation. Without it Kira gives a fixed prompt. */
  chat?: ChatFn;
  workspace?: string;
}

export interface VoiceOptions {
  python?: string;
  /** Folder holding the kira_voice package. */
  packageDir?: string;
  mistralApiKey: string;
  args?: string[];
  /** Replaces `python -m kira_voice` (tests run a scripted fake sidecar). */
  command?: { file: string; args: string[] };
  log?: (line: string) => void;
  /** Every sidecar event, for the Flight Deck and tests. */
  onVoiceEvent?: (e: VoiceEvent) => void;
  /** Everything a UI shows (turns the sidecar's level meter on). */
  onUiEvent?: (e: VoiceUiEvent) => void;
}

const here = dirname(fileURLToPath(import.meta.url));
/** First start loads the local Whisper model, which can take a while on a cold disk. */
const READY_TIMEOUT_MS = 90_000;

export function defaultVoicePackage(): string {
  return join(here, "..", "..", "..", "voice");
}

export function defaultVoicePython(): string {
  if (process.env.KIRA_VOICE_PYTHON) return process.env.KIRA_VOICE_PYTHON;
  const venv = join(process.env.LOCALAPPDATA ?? "", "kira", "voice-venv", "Scripts", "python.exe");
  return existsSync(venv) ? venv : "python";
}

export class VoiceBridge {
  private proc: ChildProcess | undefined;
  private unsubscribe: (() => void) | undefined;
  private speechSeq = 0;
  readonly latencies: { kind: string; ms: number }[] = [];
  ready: Extract<VoiceEvent, { type: "ready" }> | undefined;
  private readonly conversation: Conversation;

  constructor(
    private readonly host: VoiceHost,
    private readonly opts: VoiceOptions,
  ) {
    this.conversation = new Conversation(host.chat, host.workspace ?? "");
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const log = this.opts.log ?? (() => {});
    const cmd = this.opts.command ?? { file: this.opts.python ?? defaultVoicePython(), args: ["-m", "kira_voice", ...(this.opts.args ?? [])] };
    const proc = spawn(cmd.file, cmd.args, {
      cwd: this.opts.packageDir ?? defaultVoicePackage(),
      // The sidecar gets exactly one secret: the key it needs for Voxtral.
      env: { ...scrubSecrets(process.env), KIRA_MISTRAL_API_KEY: this.opts.mistralApiKey, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stderr?.on("data", (d: Buffer) => log(`[voice] ${d.toString().trimEnd()}`));
    const ready = new Promise<void>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code) => reject(new Error(`voice sidecar exited with code ${code} before it was ready`)));
      createInterface({ input: proc.stdout! }).on("line", (line) => {
        let ev: VoiceEvent;
        try {
          ev = JSON.parse(line) as VoiceEvent;
        } catch {
          return log(`[voice] ${line}`);
        }
        if (ev.type === "ready") {
          this.ready = ev;
          resolve();
        }
        this.onVoice(ev);
      });
    });
    this.unsubscribe = this.host.onEvent((e) => this.onRunEvent(e));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`voice sidecar was not ready within ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS);
    });
    ready.catch(() => {}); // it may still reject after the race is settled
    try {
      await Promise.race([ready, timeout]);
    } catch (err) {
      await this.stop();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    this.sync();
    if (this.opts.onUiEvent) this.send({ type: "meter", on: true });
    if (this.host.workspace) {
      try {
        this.send({ type: "vocab", words: projectVocabulary(this.host.workspace) });
      } catch (err) {
        log(`[voice] could not read the project's vocabulary: ${(err as Error).message}`);
      }
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    const exited = new Promise<void>((r) => p.once("exit", () => r()));
    p.stdin?.end();
    const t = setTimeout(() => p.kill(), 5_000);
    await exited;
    clearTimeout(t);
  }

  /** listen: the human is expected to answer, so the next sentence needs no wake word. */
  say(text: string, listen = false): void {
    this.opts.log?.(`kira says: ${text}`);
    const id = `s${++this.speechSeq}`;
    this.opts.onUiEvent?.({ type: "say", id, text });
    this.send({ type: "say", id, text, ...(listen ? { listen: true } : {}) });
  }

  /** A typed message (the assistant's text box): answered exactly as if it had been said. */
  async ask(text: string): Promise<void> {
    this.opts.onUiEvent?.({ type: "typed", text });
    await this.route(text);
  }

  /** Tests: speak `text` into a sidecar started with --source inject, as if a person said it. */
  hear(text: string): void {
    this.send({ type: "hear", text });
  }

  private send(cmd: Record<string, unknown>): void {
    if (this.running) this.proc!.stdin!.write(JSON.stringify(cmd) + "\n");
  }

  /** Tells the sidecar whether a run is going (a bare "stop" only counts then) and whether an approval waits for yes or no. */
  private sync(): void {
    const d = this.host.deck();
    this.send({ type: "state", running: !!d.run && !d.report && d.run.state !== "IDLE", awaiting: pendingApprovals(d).length > 0 });
  }

  private onRunEvent(e: KiraEvent): void {
    if (e.type === "state" || e.type === "report" || e.type === "run_started" || e.type === "approval" || e.type === "approval_resolved") this.sync();
    const line = narrate(e, this.host.deck());
    // After a question or the result, the human is likely to answer.
    if (line) this.say(line, e.type === "approval" || e.type === "report");
  }

  private onVoice(ev: VoiceEvent): void {
    this.opts.onUiEvent?.(ev);
    if (ev.type === "level") return;
    this.opts.onVoiceEvent?.(ev);
    const log = this.opts.log ?? (() => {});
    switch (ev.type) {
      case "latency":
        this.latencies.push({ kind: ev.kind, ms: ev.ms });
        return;
      case "log":
        log(`[voice] ${ev.level}: ${ev.msg}`);
        return;
      case "stop":
        void this.host.stopRun();
        return;
      case "utterance":
        log(`heard: ${ev.text}`);
        void this.route(ev.text);
        return;
    }
  }

  private async route(text: string): Promise<void> {
    const deck = this.host.deck();
    const running = !!deck.run && !deck.report && deck.run.state !== "IDLE";
    const pending = pendingApprovals(deck);
    const intent = classify(text, { running, pendingApproval: pending.length > 0 });
    switch (intent.kind) {
      case "stop":
        await this.host.stopRun();
        return;
      case "approve": {
        const a = pending[0]!;
        this.host.approve(a.id, intent.allow, intent.note ? `${intent.note} (said by voice)` : "(said by voice)");
        this.say(intent.allow ? "Okay, going ahead." : "Okay, I won't.");
        return;
      }
      case "left_off":
        this.say(await this.host.leftOff(), true);
        return;
      case "status":
        this.say(statusLine(deck), true);
        return;
      case "busy":
        this.say(`I'm still working on: ${deck.run?.goal.slice(0, 80)}. Say stop first, or ask for status.`, true);
        return;
      case "task":
        await this.startTask(intent.goal);
        return;
      case "chat": {
        // A waiting approval is answered first: don't turn an unclear answer into a new task.
        if (pending.length && !TASK.test(intent.text)) return this.say("Sorry, was that a yes or a no?", true);
        const r = await this.conversation.respond(intent.text, deck);
        if ("reply" in r) return this.say(r.reply, true);
        const now = this.host.deck();
        if (!!now.run && !now.report && now.run.state !== "IDLE") {
          return this.say(`That sounds like a new task, but I'm still working on: ${now.run.goal.slice(0, 80)}. Say stop first.`, true);
        }
        this.say(`On it: ${r.task.slice(0, 120)}.`);
        await this.startTask(r.task);
        return;
      }
      case "nothing":
        return;
    }
  }

  private async startTask(goal: string): Promise<void> {
    try {
      await this.host.startRun(goal);
    } catch (err) {
      this.say(`I couldn't start that: ${(err as Error).message}`, true);
    }
  }
}

/** Median of the recorded latencies of one kind (the spec's p50). */
export function p50(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
}
