/**
 * Kira's assistant (right-hand side bar). The orb follows the voice loop:
 *   offline · muted · idle (waiting for "Kira") · hearing (your level) ·
 *   thinking · speaking · working (a run is going).
 * Below it: what Kira is saying or doing, the conversation, the current run
 * with approvals and Stop, and a box to type to Kira.
 */
import type { KiraEvent } from "../../../daemon/src/control/events.js";
import { emptyDeck, pendingApprovals, reduceDeck, type DeckState } from "../../../daemon/src/daemon/deck.js";
import type { VoiceStatus, VoiceUiEvent } from "../../../daemon/src/daemon/protocol.js";
import { escapeHtml as esc } from "./render.js";

interface VsCodeApi {
  postMessage(m: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type Incoming =
  | { type: "connection"; status: "connected" | "starting" | "offline"; message?: string }
  | { type: "snapshot"; deck: DeckState }
  | { type: "event"; event: KiraEvent }
  | { type: "voice"; event: VoiceUiEvent }
  | { type: "voiceStatus"; status: VoiceStatus };

type Mode = "offline" | "muted" | "idle" | "hearing" | "thinking" | "speaking" | "working";

const vscode = acquireVsCodeApi();

// ---- state ------------------------------------------------------------------------
let deck: DeckState = emptyDeck();
let connection: { status: string; message?: string } = { status: "offline" };
let voiceOn = false;
let voiceDevice = "";
let speechActive = false;
let level = 0;
let speaking: { id: string; text: string } | undefined;
let thinkingSince = 0;
const said = new Map<string, string>(); // speech id -> text
type Line = { who: "you" | "kira" | "note"; text: string; at: number };
const lines: Line[] = [];

// ---- layout ----------------------------------------------------------------------
const app = document.getElementById("app")!;
app.innerHTML = `
  <div class="stage">
    <canvas id="orb" aria-hidden="true"></canvas>
    <div id="caption" class="caption" role="status" aria-live="polite"></div>
    <div id="sub" class="sub"></div>
  </div>
  <section id="run" class="run" hidden></section>
  <section id="chat" class="chat" aria-label="Conversation"></section>
  <form id="composer" class="composer">
    <button type="button" id="mic" class="icon" title="Voice on/off" aria-label="Voice on/off"></button>
    <input id="input" type="text" placeholder="Type to Kira…" autocomplete="off" aria-label="Message Kira">
    <button type="submit" class="icon send" title="Send" aria-label="Send">➤</button>
  </form>
  <div class="footer"><a href="#" id="deck">Flight Deck</a></div>`;

const $ = (id: string) => document.getElementById(id)!;
const canvas = $("orb") as HTMLCanvasElement;
const caption = $("caption");
const sub = $("sub");
const runEl = $("run");
const chat = $("chat");
const input = $("input") as HTMLInputElement;
const micBtn = $("mic") as HTMLButtonElement;

$("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  vscode.postMessage({ type: "ask", text });
});
micBtn.addEventListener("click", () => vscode.postMessage({ type: "mic", on: !voiceOn }));
$("deck").addEventListener("click", (ev) => {
  ev.preventDefault();
  vscode.postMessage({ type: "flightDeck" });
});
runEl.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button");
  if (!b) return;
  if (b.dataset.act === "stop") vscode.postMessage({ type: "stop" });
  if (b.dataset.act === "allow" || b.dataset.act === "deny") vscode.postMessage({ type: "approve", id: b.dataset.id, allow: b.dataset.act === "allow" });
});

// ---- messages --------------------------------------------------------------------
window.addEventListener("message", (m: MessageEvent<Incoming>) => {
  const msg = m.data;
  switch (msg.type) {
    case "connection":
      connection = msg;
      if (msg.status !== "connected") {
        voiceOn = false;
        speaking = undefined;
      }
      break;
    case "snapshot":
      deck = msg.deck;
      break;
    case "event":
      deck = reduceDeck(deck, msg.event);
      onRunEvent(msg.event);
      break;
    case "voiceStatus":
      voiceOn = msg.status.running;
      voiceDevice = msg.status.input ?? voiceDevice;
      break;
    case "voice":
      onVoice(msg.event);
      break;
  }
  render();
});

function add(who: Line["who"], text: string): void {
  const t = text.trim();
  if (!t) return;
  lines.push({ who, text: t, at: Date.now() });
  if (lines.length > 80) lines.splice(0, lines.length - 80);
  renderChat();
}

function onVoice(e: VoiceUiEvent): void {
  switch (e.type) {
    case "ready":
      voiceOn = true;
      voiceDevice = e.input;
      break;
    case "level":
      level = e.rms;
      speechActive = e.speech;
      return; // the animation reads these; no re-render needed
    case "wake":
      thinkingSince = 0;
      break;
    case "utterance":
      add("you", e.text);
      thinkingSince = Date.now();
      speechActive = false;
      break;
    case "typed":
      add("you", e.text);
      thinkingSince = Date.now();
      break;
    case "stop":
      add("you", e.heard || "Stop");
      break;
    case "say":
      said.set(e.id, e.text);
      add("kira", e.text);
      thinkingSince = 0;
      break;
    case "speaking":
      if (e.state === "start") speaking = { id: e.id, text: said.get(e.id) ?? "" };
      else if (speaking?.id === e.id) speaking = undefined;
      break;
  }
}

function onRunEvent(e: KiraEvent): void {
  if (e.type === "run_started") {
    thinkingSince = 0;
    add("note", `Started: ${e.goal}`);
  } else if (e.type === "report") {
    add("note", `${e.report.status.toUpperCase()}: ${e.report.summary.split("\n")[0]}`);
  }
}

const runActive = () => !!deck.run && !deck.report && deck.run.state !== "IDLE";

function mode(): Mode {
  if (connection.status !== "connected") return "offline";
  if (speaking) return "speaking";
  if (voiceOn && speechActive) return "hearing";
  if (thinkingSince && Date.now() - thinkingSince < 20_000) return "thinking";
  if (runActive()) return "working";
  return voiceOn ? "idle" : "muted";
}

function lastNarration(): string {
  for (let i = deck.steps.length - 1; i >= 0; i--) {
    const n = deck.steps[i]!.narration.at(-1);
    if (n) return n;
  }
  return deck.run?.detail ?? "";
}

// ---- render ----------------------------------------------------------------------
let lastMode: Mode | undefined;

function render(): void {
  const m = mode();
  document.body.dataset.mode = m;
  const captions: Record<Mode, string> = {
    offline: connection.status === "starting" ? "Starting…" : "Kira is offline",
    muted: "Voice is off",
    idle: "Say “Kira, …”",
    hearing: "Listening…",
    thinking: "Thinking…",
    speaking: speaking?.text ?? "",
    working: deck.run ? `Working: ${deck.run.goal}` : "Working…",
  };
  caption.textContent = captions[m];
  sub.textContent =
    m === "offline"
      ? connection.message ?? "Run  npm run kira -- --voice  in a VS Code terminal."
      : m === "muted"
        ? "Click the mic to talk, or type below."
        : m === "working"
          ? lastNarration().slice(0, 220)
          : m === "idle" && voiceDevice
            ? `Mic: ${voiceDevice}`
            : "";
  micBtn.textContent = voiceOn ? "🎙" : "🔇";
  micBtn.classList.toggle("on", voiceOn);
  micBtn.disabled = connection.status !== "connected";
  input.disabled = connection.status !== "connected";
  renderRun();
  lastMode = m;
}

function renderRun(): void {
  const r = deck.run;
  if (!r) {
    runEl.hidden = true;
    return;
  }
  runEl.hidden = false;
  const active = runActive();
  const pending = pendingApprovals(deck);
  const status = deck.report ? deck.report.status : r.state.toLowerCase().replace(/_/g, " ");
  const step = deck.steps.at(-1)?.n;
  runEl.innerHTML = `
    <div class="run-head">
      <span class="pill ${deck.report ? (deck.report.status === "done" ? "good" : "warn") : "busy"}">${esc(status)}</span>
      ${step ? `<span class="muted">step ${step}</span>` : ""}
      ${active ? `<button class="danger" data-act="stop" title="Stop the run (Ctrl+Alt+End)">Stop</button>` : ""}
    </div>
    <div class="goal">${esc(r.goal)}</div>
    ${pending
      .map(
        (a) => `<div class="approval">
          <div><b>Kira wants to ${esc(a.request.category.replace(/-/g, " "))}</b></div>
          <div class="small">${esc(a.request.summary)}</div>
          <div class="row"><button data-act="allow" data-id="${esc(a.id)}">Allow</button><button class="secondary" data-act="deny" data-id="${esc(a.id)}">Deny</button><span class="muted small">or say “yes” / “no”</span></div>
        </div>`,
      )
      .join("")}`;
}

let renderedLines = 0;
function renderChat(): void {
  if (renderedLines > lines.length) {
    chat.innerHTML = "";
    renderedLines = 0;
  }
  for (const l of lines.slice(renderedLines)) {
    const div = document.createElement("div");
    div.className = `msg ${l.who}`;
    div.textContent = l.text;
    chat.appendChild(div);
  }
  while (chat.children.length > 80) chat.firstElementChild?.remove();
  renderedLines = lines.length;
  chat.scrollTop = chat.scrollHeight;
}

// ---- the orb ---------------------------------------------------------------------
const ctx = canvas.getContext("2d")!;
const blobs = [
  { hue: 190, speed: 0.7, phase: 0, lobes: 3 },
  { hue: 285, speed: -0.55, phase: 2.1, lobes: 4 },
  { hue: 330, speed: 0.45, phase: 4.2, lobes: 2 },
  { hue: 220, speed: -0.8, phase: 1.3, lobes: 5 },
];
let energy = 0;
let spin = 0;
let t0 = performance.now();

function targetEnergy(m: Mode, t: number): number {
  switch (m) {
    case "offline":
      return 0.02;
    case "muted":
      return 0.05;
    case "idle":
      return 0.1 + 0.04 * Math.sin(t * 1.6);
    case "hearing": {
      // rms 0.003 (quiet) .. 0.15 (loud) on a log scale -> 0.25 .. 1
      const db = Math.log10(Math.max(level, 0.003) / 0.003) / Math.log10(50);
      return 0.25 + 0.75 * Math.min(1, db);
    }
    case "thinking":
      return 0.3 + 0.08 * Math.sin(t * 5);
    case "speaking": {
      // Syllable-like pulses, since Kira's own audio is not metered.
      const s = Math.abs(Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1) + 0.4 * Math.sin(t * 11.7));
      return 0.3 + 0.5 * Math.min(1, s);
    }
    case "working":
      return 0.18 + 0.05 * Math.sin(t * 2.2);
  }
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - t0) / 1000);
  t0 = now;
  const t = now / 1000;
  const m = mode();
  if (m !== lastMode) render();
  const target = targetEnergy(m, t);
  energy += (target - energy) * Math.min(1, dt * (target > energy ? 14 : 5));
  spin += dt * (m === "thinking" ? 2.6 : m === "working" ? 1.2 : m === "offline" ? 0.1 : 0.6);

  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const R = size * 0.34;
  const grey = m === "offline" || m === "muted";

  // Glow behind the sphere.
  const glow = ctx.createRadialGradient(c, c, R * 0.6, c, c, R * (1.35 + energy * 0.35));
  glow.addColorStop(0, `hsla(${grey ? 220 : 250}, ${grey ? 5 : 80}%, 60%, ${0.18 + energy * 0.3})`);
  glow.addColorStop(1, "hsla(250, 80%, 60%, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(c, c, R * 1.8, 0, Math.PI * 2);
  ctx.fill();

  // The sphere: a dark glass ball, so the colors read on light and dark themes alike.
  const ball = ctx.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.1, c, c, R);
  ball.addColorStop(0, "#1d2033");
  ball.addColorStop(1, "#05060c");
  ctx.fillStyle = ball;
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, R * 0.985, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalCompositeOperation = "lighter";
  for (const b of blobs) {
    const a = spin * b.speed + b.phase;
    const off = R * (0.12 + energy * 0.22);
    const bx = c + Math.cos(a) * off;
    const by = c + Math.sin(a * 1.3) * off;
    const r = R * (0.5 + energy * 0.42);
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const th = (i / 64) * Math.PI * 2;
      const wob = 1 + (0.06 + energy * 0.22) * Math.sin(th * b.lobes + t * (1.5 + energy * 4) * Math.sign(b.speed) + b.phase);
      const x = bx + Math.cos(th) * r * wob;
      const y = by + Math.sin(th) * r * wob;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, r * 1.1);
    const sat = grey ? 8 : 90;
    g.addColorStop(0, `hsla(${b.hue}, ${sat}%, 62%, ${0.55 + energy * 0.35})`);
    g.addColorStop(0.6, `hsla(${b.hue}, ${sat}%, 50%, ${0.25 + energy * 0.2})`);
    g.addColorStop(1, `hsla(${b.hue}, ${sat}%, 40%, 0)`);
    ctx.fillStyle = g;
    ctx.fill();
  }
  ctx.restore();

  // Glass highlight and rim.
  const hl = ctx.createRadialGradient(c - R * 0.35, c - R * 0.45, 0, c - R * 0.35, c - R * 0.45, R * 0.6);
  hl.addColorStop(0, "rgba(255,255,255,0.22)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hl;
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(255,255,255,${0.08 + energy * 0.15})`;
  ctx.stroke();

  // Working: a slow ring of progress dots around the sphere.
  if (m === "working" || m === "thinking") {
    ctx.fillStyle = m === "thinking" ? "rgba(190,160,255,0.8)" : "rgba(120,200,255,0.7)";
    for (let i = 0; i < 3; i++) {
      const a = spin * 1.5 + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(c + Math.cos(a) * R * 1.16, c + Math.sin(a) * R * 1.16, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  requestAnimationFrame(frame);
}

render();
requestAnimationFrame(frame);
vscode.postMessage({ type: "ready" });
