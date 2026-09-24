/**
 * Flight Deck webview. Runs the daemon's own reducer over the event stream
 * and renders: run header (state, autonomy, provider/rate limit, budget),
 * approvals, plan tree, step timeline, terminal mirror (xterm), live diff,
 * verification ladder, memory, and the final report.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { KiraEvent } from "../../../daemon/src/control/events.js";
import { emptyDeck, pendingApprovals, reduceDeck, type DeckState } from "../../../daemon/src/daemon/deck.js";
import { escapeHtml as esc, renderSections } from "./render.js";

interface VsCodeApi {
  postMessage(m: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type Incoming =
  | { type: "snapshot"; deck: DeckState }
  | { type: "event"; event: KiraEvent }
  | { type: "pendingAdrs"; items: { id: number; title: string; body: string; adrId?: string }[] }
  | { type: "connection"; status: "connected" | "starting" | "stopped"; message?: string };

const vscode = acquireVsCodeApi();
let deck: DeckState = emptyDeck();
let pendingAdrs: { id: number; title: string; body: string; adrId?: string }[] = [];
let connection: { status: string; message?: string } = { status: "starting" };

// ---- layout ----------------------------------------------------------------------
const app = document.getElementById("app")!;
app.innerHTML = `
  <header id="s-header"></header>
  <section id="s-approvals" class="approvals"></section>
  <section id="s-controls" class="controls"></section>
  <section id="s-report"></section>
  <div class="grid">
    <div class="col">
      <details open><summary>Plan</summary><div id="s-plan"></div></details>
      <details open><summary>Steps</summary><div id="s-steps" class="timeline"></div></details>
    </div>
    <div class="col">
      <details open><summary>Terminal</summary><div id="terminal" class="terminal"></div></details>
      <details open><summary>Changes</summary><div id="s-diff"></div></details>
      <details open><summary>Verification</summary><div id="s-verify"></div></details>
      <details open><summary>Memory</summary><div id="s-memory"></div></details>
    </div>
  </div>`;

// ---- terminal mirror -------------------------------------------------------------
const css = getComputedStyle(document.body);
const term = new Terminal({
  convertEol: false,
  disableStdin: true,
  fontSize: 12,
  scrollback: 5_000,
  fontFamily: css.getPropertyValue("--vscode-editor-font-family") || "Consolas, monospace",
  theme: {
    background: css.getPropertyValue("--vscode-terminal-background").trim() || css.getPropertyValue("--vscode-editor-background").trim() || "#1e1e1e",
    foreground: css.getPropertyValue("--vscode-terminal-foreground").trim() || css.getPropertyValue("--vscode-editor-foreground").trim() || "#cccccc",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal")!);
const refit = () => {
  try {
    fit.fit();
  } catch {
    /* hidden */
  }
};
new ResizeObserver(refit).observe(document.getElementById("terminal")!);

// ---- rendering -------------------------------------------------------------------
const last = new Map<string, string>();
let scheduled = false;
function render(): void {
  scheduled = false;
  const sections = renderSections(deck, { pendingAdrs, connection, now: Date.now() });
  for (const [id, html] of Object.entries(sections)) {
    if (last.get(id) === html) continue;
    // Keep what the human is typing in a section that is about to re-render.
    const el = document.getElementById(id)!;
    const drafts = new Map<string, string>();
    el.querySelectorAll<HTMLInputElement>("input[data-draft]").forEach((i) => drafts.set(i.dataset.draft!, i.value));
    el.innerHTML = html;
    el.querySelectorAll<HTMLInputElement>("input[data-draft]").forEach((i) => {
      const v = drafts.get(i.dataset.draft!);
      if (v !== undefined) i.value = v;
    });
    last.set(id, html);
  }
}
function schedule(): void {
  if (!scheduled) {
    scheduled = true;
    requestAnimationFrame(render);
  }
}
// The rate-limit countdown ticks without events.
setInterval(() => {
  if (deck.run?.state === "RATE_LIMITED") {
    last.delete("s-header");
    schedule();
  }
}, 1_000);

// ---- messages --------------------------------------------------------------------
window.addEventListener("message", (ev: MessageEvent<Incoming>) => {
  const m = ev.data;
  switch (m.type) {
    case "snapshot":
      deck = m.deck;
      term.reset();
      term.write(deck.terminal);
      break;
    case "event":
      deck = reduceDeck(deck, m.event);
      if (m.event.type === "terminal") term.write(m.event.data);
      if (m.event.type === "run_started") term.reset();
      break;
    case "pendingAdrs":
      pendingAdrs = m.items;
      break;
    case "connection":
      connection = { status: m.status, ...(m.message ? { message: m.message } : {}) };
      break;
  }
  schedule();
});

// ---- actions ---------------------------------------------------------------------
document.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!btn) return;
  const a = btn.dataset.action;
  if (a === "allow" || a === "deny") {
    const id = btn.dataset.id!;
    const note = (document.querySelector<HTMLInputElement>(`input[data-draft="note-${CSS.escape(id)}"]`)?.value ?? "").trim();
    vscode.postMessage({ type: "approve", id, allow: a === "allow", ...(note ? { note } : {}) });
    btn.closest(".approval")?.classList.add("sent");
  } else if (a === "stop") {
    vscode.postMessage({ type: "stop" });
  } else if (a === "start") {
    const input = document.querySelector<HTMLInputElement>('input[data-draft="goal"]');
    const goal = input?.value.trim();
    if (goal) {
      vscode.postMessage({ type: "start", goal });
      input!.value = "";
    }
  } else if (a === "reject-memory" || a === "keep-memory") {
    vscode.postMessage({ type: a === "reject-memory" ? "memoryReject" : "memoryKeep", id: Number(btn.dataset.id) });
  } else if (a === "open-file") {
    vscode.postMessage({ type: "openFile", path: btn.dataset.path });
  }
});
document.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (ev.key === "Enter" && t.dataset?.draft === "goal") document.querySelector<HTMLElement>('[data-action="start"]')?.click();
  if (ev.key === "Enter" && t.dataset?.draft?.startsWith("note-")) {
    // Enter in a reason field means "deny, because…".
    document.querySelector<HTMLElement>(`[data-action="deny"][data-id="${CSS.escape(t.dataset.draft.slice(5))}"]`)?.click();
  }
});

// For tests and the preview harness.
Object.assign(window, { __kira: { get deck() { return deck; }, pending: () => pendingApprovals(deck), esc } });
vscode.postMessage({ type: "ready" });
render();
