/**
 * Kira's assistant: a webview in the right-hand (secondary) side bar. An orb
 * that follows the voice (listening, hearing you, thinking, speaking,
 * working), the conversation as it happens, the current run with its
 * approvals, and a box to type to Kira.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { KiraEvent } from "../../daemon/src/control/events.js";
import type { DeckState } from "../../daemon/src/daemon/deck.js";
import type { VoiceStatus, VoiceUiEvent } from "../../daemon/src/daemon/protocol.js";

export const ASSISTANT_VIEW = "kira.assistant";

/** Messages from the assistant webview. */
export type FromAssistant =
  | { type: "ready" }
  | { type: "ask"; text: string }
  | { type: "mic"; on: boolean }
  | { type: "stop" }
  | { type: "approve"; id: string; allow: boolean }
  | { type: "flightDeck" };

/** Messages to the assistant webview. */
export type ToAssistant =
  | { type: "connection"; status: "connected" | "starting" | "offline"; message?: string }
  | { type: "snapshot"; deck: DeckState }
  | { type: "event"; event: KiraEvent }
  | { type: "voice"; event: VoiceUiEvent }
  | { type: "voiceStatus"; status: VoiceStatus };

export class AssistantView implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /** Messages sent before the webview was ready, replayed once it is (the last state wins anyway). */
  private queue: ToAssistant[] = [];
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (m: FromAssistant) => void,
  ) {}

  get visible(): boolean {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: FromAssistant) => {
      if (m.type === "ready") {
        this.ready = true;
        const q = this.queue;
        this.queue = [];
        for (const x of q) void view.webview.postMessage(x);
      }
      this.onMessage(m);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  post(m: ToAssistant): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(m);
      return;
    }
    if (m.type === "voice" && m.event.type === "level") return; // stale levels are worthless
    this.queue.push(m);
    if (this.queue.length > 400) this.queue.splice(0, this.queue.length - 400);
  }

  /** Opens the side bar on Kira without taking focus from the terminal. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${ASSISTANT_VIEW}.focus`, { preserveFocus: true });
  }

  private html(w: vscode.Webview): string {
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f)).toString();
    const nonce = randomBytes(16).toString("base64");
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:; font-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media("assistant.css")}">
<title>Kira</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("assistant.js")}"></script>
</body>
</html>`;
  }
}
