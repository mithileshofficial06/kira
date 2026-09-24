/**
 * The Flight Deck webview panel (spec §7). It renders the daemon's event
 * stream; every action it offers (approve, stop, start, reject a memory)
 * goes back to the daemon through the extension.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { KiraEvent } from "../../daemon/src/control/events.js";
import type { DeckState } from "../../daemon/src/daemon/deck.js";

/** Messages from the webview. */
export type FromWebview =
  | { type: "ready" }
  | { type: "approve"; id: string; allow: boolean; note?: string }
  | { type: "stop" }
  | { type: "start"; goal: string }
  | { type: "memoryReject"; id: number }
  | { type: "memoryKeep"; id: number }
  | { type: "refreshMemory" }
  | { type: "openFile"; path: string };

/** Messages to the webview. */
export type ToWebview =
  | { type: "snapshot"; deck: DeckState }
  | { type: "event"; event: KiraEvent }
  | { type: "pendingAdrs"; items: { id: number; title: string; body: string; adrId?: string }[] }
  | { type: "connection"; status: "connected" | "starting" | "stopped"; message?: string };

export class FlightDeckPanel implements vscode.Disposable {
  static current: FlightDeckPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, onMessage: (m: FromWebview) => void): FlightDeckPanel {
    if (FlightDeckPanel.current) {
      FlightDeckPanel.current.panel.reveal(undefined, true);
      return FlightDeckPanel.current;
    }
    FlightDeckPanel.current = new FlightDeckPanel(extensionUri, onMessage);
    return FlightDeckPanel.current;
  }

  private constructor(
    private readonly extensionUri: vscode.Uri,
    onMessage: (m: FromWebview) => void,
  ) {
    this.panel = vscode.window.createWebviewPanel("kira.flightDeck", "Kira Flight Deck", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "kira.svg");
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(onMessage),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  post(m: ToWebview): void {
    void this.panel.webview.postMessage(m);
  }

  dispose(): void {
    FlightDeckPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f)).toString();
    const nonce = randomBytes(16).toString("base64");
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${w.cspSource} data:; font-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media("xterm.css")}">
<link rel="stylesheet" href="${media("deck.css")}">
<title>Kira Flight Deck</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("deck.js")}"></script>
</body>
</html>`;
  }
}
