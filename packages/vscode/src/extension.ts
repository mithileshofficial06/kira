import * as vscode from "vscode";
import type { KiraEvent } from "../../daemon/src/control/events.js";
import { pendingApprovals } from "../../daemon/src/daemon/deck.js";
import { Methods, type MemoryItemView, type StartResult, type VoiceStatus } from "../../daemon/src/daemon/protocol.js";
import { DaemonClient } from "./daemon-client.js";
import { FlightDeckPanel, type FromWebview } from "./panel.js";

let client: DaemonClient | undefined;
let starting: Promise<DaemonClient> | undefined;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let mic: vscode.StatusBarItem;
/** Polls voice/status while listening, so a sidecar that dies does not leave a stale mic. */
let voicePoll: ReturnType<typeof setInterval> | undefined;
let context: vscode.ExtensionContext;
/** Approvals already shown as a notification, so each is asked once. */
const notified = new Set<string>();

/** Read-only view for integration tests and other extensions. */
export interface KiraApi {
  deck(): DaemonClient["deck"] | undefined;
  daemonConnected(): boolean;
  panelOpen(): boolean;
  voiceListening(): boolean;
}

export function activate(ctx: vscode.ExtensionContext): KiraApi {
  context = ctx;
  output = vscode.window.createOutputChannel("Kira");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "kira.flightDeck";
  setStatus("idle");
  status.show();
  mic = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  mic.command = "kira.stopVoice";

  ctx.subscriptions.push(
    output,
    status,
    mic,
    vscode.commands.registerCommand("kira.start", startRun),
    vscode.commands.registerCommand("kira.stop", stopRun),
    vscode.commands.registerCommand("kira.flightDeck", () => void openDeck()),
    vscode.commands.registerCommand("kira.leftOff", leftOff),
    vscode.commands.registerCommand("kira.remember", remember),
    vscode.commands.registerCommand("kira.startVoice", startVoice),
    vscode.commands.registerCommand("kira.stopVoice", stopVoice),
    vscode.commands.registerCommand("kira.restartDaemon", async () => {
      client?.dispose();
      client = undefined;
      await ensureClient();
    }),
    { dispose: () => client?.dispose() },
    { dispose: () => setMic(undefined) },
  );
  return { deck: () => client?.deck, daemonConnected: () => !!client, panelOpen: () => !!FlightDeckPanel.current, voiceListening: () => !!voicePoll };
}

export function deactivate(): void {
  client?.dispose();
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function ensureClient(): Promise<DaemonClient> {
  if (client) return client;
  const root = workspaceRoot();
  if (!root) throw new Error("Open a folder first: Kira works on one workspace at a time.");
  FlightDeckPanel.current?.post({ type: "connection", status: "starting" });
  starting ??= DaemonClient.start(context.extensionPath, root, output)
    .then((c) => {
      client = c;
      c.onEvent(onEvent);
      c.onExit(() => {
        client = undefined;
        setMic(undefined);
        setStatus("idle");
        FlightDeckPanel.current?.post({ type: "connection", status: "stopped", message: "The daemon exited. Kira: Restart Daemon to reconnect." });
        void vscode.window.showWarningMessage("The Kira daemon stopped.", "Restart").then((a) => {
          if (a) void vscode.commands.executeCommand("kira.restartDaemon");
        });
      });
      FlightDeckPanel.current?.post({ type: "connection", status: "connected" });
      FlightDeckPanel.current?.post({ type: "snapshot", deck: c.deck });
      return c;
    })
    .finally(() => {
      starting = undefined;
    });
  return starting;
}

async function withClient<T>(fn: (c: DaemonClient) => Promise<T>): Promise<T | undefined> {
  try {
    return await fn(await ensureClient());
  } catch (err) {
    const msg = (err as Error).message;
    output.appendLine(`[kira] ${msg}`);
    void vscode.window.showErrorMessage(`Kira: ${msg}`);
    return undefined;
  }
}

async function startRun(goalArg?: string): Promise<void> {
  const goal =
    typeof goalArg === "string" && goalArg.trim()
      ? goalArg
      : await vscode.window.showInputBox({ title: "Kira", prompt: "What should Kira do?", placeHolder: "e.g. add a login page with session cookies, then verify it in the browser" });
  if (!goal?.trim()) return;
  const cfg = vscode.workspace.getConfiguration("kira");
  await openDeck();
  const r = await withClient((c) =>
    c.request<StartResult>(Methods.start, {
      goal,
      autonomy: cfg.get<number>("autonomy", 3),
      verify: cfg.get<boolean>("verify", true),
      maxCostUsd: cfg.get<number>("maxCostUsd", 2),
    }),
  );
  if (r) output.appendLine(`[kira] started ${r.runId}: ${goal}`);
}

async function stopRun(): Promise<void> {
  if (!client) return;
  setStatus("stopping");
  await withClient((c) => c.request(Methods.stop));
}

async function leftOff(): Promise<void> {
  const r = await withClient((c) => c.request<{ text: string }>(Methods.leftOff));
  if (!r) return;
  output.appendLine(`[kira] where we left off:\n${r.text}`);
  // Not awaited: a notification with a button settles only when dismissed, and the command should return now.
  void vscode.window.showInformationMessage(r.text, { modal: false }, "Open Flight Deck").then((a) => {
    if (a) void openDeck();
  });
}

async function remember(): Promise<void> {
  const kind = await vscode.window.showQuickPick(
    [
      { label: "Preference", description: "style, libraries, conventions: always in Kira's prompt", value: "preference" as const },
      { label: "Fact", description: "something true about this project", value: "fact" as const },
    ],
    { title: "Kira: Remember" },
  );
  if (!kind) return;
  const text = await vscode.window.showInputBox({ title: `Kira: remember a ${kind.value}`, prompt: "One sentence" });
  if (!text?.trim()) return;
  const r = await withClient((c) => c.request<{ id: number }>(Methods.remember, { kind: kind.value, text }));
  if (r) void vscode.window.showInformationMessage(`Kira will remember that.`);
}

async function startVoice(): Promise<void> {
  const r = await withClient((c) => c.request<VoiceStatus>(Methods.voiceStart));
  if (!r) return;
  setMic(r);
  output.appendLine(`[kira] voice listening: in ${r.input ?? "?"}, out ${r.output ?? "?"}, wake ${r.wake ?? "?"}`);
  void vscode.window.showInformationMessage(`Kira is listening. Say "${r.wake ?? "Kira"}, …", or "stop" to interrupt.`);
}

async function stopVoice(): Promise<void> {
  if (!client) return setMic(undefined);
  const r = await withClient((c) => c.request<VoiceStatus>(Methods.voiceStop));
  setMic(r);
}

/** Shows the mic while voice runs; undefined or not running hides it and stops polling. */
function setMic(v: VoiceStatus | undefined): void {
  if (!v?.running) {
    if (voicePoll) clearInterval(voicePoll);
    voicePoll = undefined;
    mic?.hide();
    if (v?.error) void vscode.window.showWarningMessage(`Kira voice stopped: ${v.error}`);
    return;
  }
  mic.text = `$(mic-filled) Kira${v.ackP50Ms !== undefined ? ` · ${(v.ackP50Ms / 1000).toFixed(1)}s` : ""}`;
  mic.tooltip = `Kira is listening (${v.input ?? "default mic"}). Click to stop voice.${v.samples ? ` Median acknowledgement ${v.ackP50Ms} ms over ${v.samples}.` : ""}`;
  mic.show();
  voicePoll ??= setInterval(() => {
    const c = client;
    if (!c) return setMic(undefined);
    c.request<VoiceStatus>(Methods.voiceStatus).then(
      (s) => {
        if (!s.running) output.appendLine(`[kira] voice stopped${s.error ? `: ${s.error}` : ""}`);
        setMic(s);
      },
      () => setMic(undefined),
    );
  }, 5_000);
}

async function openDeck(): Promise<void> {
  const panel = FlightDeckPanel.show(context.extensionUri, onWebviewMessage);
  if (client) panel.post({ type: "snapshot", deck: client.deck });
}

async function onWebviewMessage(m: FromWebview): Promise<void> {
  switch (m.type) {
    case "ready":
      if (client) {
        FlightDeckPanel.current?.post({ type: "connection", status: "connected" });
        FlightDeckPanel.current?.post({ type: "snapshot", deck: client.deck });
        void refreshMemory();
      } else {
        FlightDeckPanel.current?.post({ type: "connection", status: "stopped", message: "Start a run to launch the daemon." });
      }
      return;
    case "approve":
      await withClient((c) => c.request(Methods.approve, { id: m.id, allow: m.allow, note: m.note }));
      return;
    case "stop":
      await stopRun();
      return;
    case "start":
      await startRun(m.goal);
      return;
    case "memoryReject":
      await withClient((c) => c.request(Methods.memoryReject, { id: m.id }));
      await refreshMemory();
      return;
    case "memoryKeep":
      await withClient((c) => c.request(Methods.memoryKeep, { id: m.id }));
      await refreshMemory();
      return;
    case "refreshMemory":
      await refreshMemory();
      return;
    case "openFile": {
      const root = workspaceRoot();
      if (root) await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.Uri.file(root), m.path), { preview: true, preserveFocus: true });
      return;
    }
  }
}

async function refreshMemory(): Promise<void> {
  if (!client) return;
  const items = await client.request<MemoryItemView[]>(Methods.memoryList, { kind: "adr", review: "pending" }).catch(() => []);
  FlightDeckPanel.current?.post({ type: "pendingAdrs", items });
}

function onEvent(e: KiraEvent): void {
  FlightDeckPanel.current?.post({ type: "event", event: e });
  const deck = client?.deck;
  if (!deck) return;

  if (e.type === "report") {
    setStatus("idle", `${e.report.status}`);
    void refreshMemory();
    const s = e.report.status;
    const say = s === "done" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void say(`Kira ${s.toUpperCase()}: ${e.report.summary.split("\n")[0]!.slice(0, 200)}`, "Open Flight Deck").then((a) => {
      if (a) void openDeck();
    });
    return;
  }
  if (e.type === "approval") {
    setStatus("approval");
    // In the panel the approval card is enough; otherwise ask where the human will see it.
    if (!FlightDeckPanel.current?.visible && !notified.has(e.id)) {
      notified.add(e.id);
      void askInline(e.id, e.request.category, e.request.summary);
    }
    return;
  }
  if (e.type === "state" || (e.type === "agent" && e.event.type === "step")) {
    const state = deck.run?.state ?? "IDLE";
    const step = deck.steps.at(-1)?.n;
    if (pendingApprovals(deck).length) setStatus("approval");
    else if (state === "RATE_LIMITED") setStatus("rate", "waiting out a rate limit");
    else if (state !== "IDLE") setStatus("busy", `${state.toLowerCase().replace("_", " ")}${step ? ` · step ${step}` : ""}`);
  }
}

async function askInline(id: string, category: string, summary: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(`Kira wants to ${category.replace(/-/g, " ")}:\n${summary}`, { modal: false }, "Allow", "Deny…", "Open Flight Deck");
  if (choice === "Open Flight Deck") return void openDeck();
  if (!choice || !client) return;
  if (!pendingApprovals(client.deck).some((a) => a.id === id)) return; // answered elsewhere meanwhile
  const note = choice === "Deny…" ? await vscode.window.showInputBox({ title: "Why not? (Kira records this as a decision)", prompt: "Optional" }) : undefined;
  await withClient((c) => c.request(Methods.approve, { id, allow: choice === "Allow", note }));
}

function setStatus(kind: "idle" | "busy" | "approval" | "rate" | "stopping", text?: string): void {
  const icon = { idle: "$(hubot)", busy: "$(sync~spin)", approval: "$(bell-dot)", rate: "$(watch)", stopping: "$(debug-stop)" }[kind];
  status.text = `${icon} Kira${text ? `: ${text}` : kind === "approval" ? ": approval needed" : kind === "stopping" ? ": stopping" : ""}`;
  status.tooltip = kind === "busy" ? "Kira is working. Click for the Flight Deck; Ctrl+Alt+End stops." : "Open the Kira Flight Deck";
  status.backgroundColor = kind === "approval" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
}
