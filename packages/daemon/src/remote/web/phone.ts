/**
 * Kira on the phone. Hold the button and talk (or tap once: it sends when you
 * stop talking), and Kira answers through the phone's speaker. Shows the orb,
 * what Kira is saying, the conversation and the current run, with Stop and
 * Allow/Deny.
 */
import type { KiraEvent } from "../../control/events.js";
import { emptyDeck, pendingApprovals, reduceDeck, type DeckState } from "../../daemon/deck.js";
import type { VoiceStatus } from "../../daemon/protocol.js";
import { startOrb, type OrbMode } from "../../ui/orb.js";
import type { VoiceUiEvent } from "../../voice/bridge.js";
import type { PhoneMessage } from "../phone.js";

// ---- pairing ---------------------------------------------------------------------
const fromHash = new URLSearchParams(location.hash.slice(1)).get("t");
let token = "";
try {
  if (fromHash) localStorage.setItem("kira-token", fromHash);
  token = fromHash ?? localStorage.getItem("kira-token") ?? "";
} catch {
  token = fromHash ?? "";
}

// ---- state -----------------------------------------------------------------------
let deck: DeckState = emptyDeck();
let voice: VoiceStatus = { running: false, samples: 0 };
let connected = false;
let thinkingSince = 0;
let level = 0;
let saying = "";
const said = new Map<string, string>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---- layout ----------------------------------------------------------------------
document.getElementById("app")!.innerHTML = `
  <header><span class="name">Kira</span><span id="conn" class="conn"></span></header>
  <div class="stage">
    <canvas id="orb"></canvas>
    <div id="caption" class="caption" role="status" aria-live="polite"></div>
    <div id="sub" class="sub"></div>
  </div>
  <section id="run" class="run" hidden></section>
  <section id="chat" class="chat" aria-label="Conversation"></section>
  <div id="sound" class="banner" hidden>Tap anywhere to turn on Kira's voice</div>
  <footer>
    <form id="composer" class="composer">
      <input id="input" type="text" placeholder="Type to Kira…" autocomplete="off" enterkeyhint="send" aria-label="Message Kira">
      <button type="submit" class="send" aria-label="Send">➤</button>
    </form>
    <button id="talk" class="talk" aria-label="Hold to talk to Kira"><span class="dot"></span></button>
    <div id="hint" class="hint">Hold to talk · tap to talk hands-free</div>
  </footer>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const caption = $("caption");
const sub = $("sub");
const runEl = $("run");
const chat = $("chat");
const talk = $<HTMLButtonElement>("talk");
const hint = $("hint");
const input = $<HTMLInputElement>("input");

// ---- API ---------------------------------------------------------------------------
async function api(path: string, body?: unknown, raw?: ArrayBuffer): Promise<Record<string, unknown>> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "x-kira-token": token, "Content-Type": raw ? "application/octet-stream" : "application/json" },
    body: raw ?? JSON.stringify(body ?? {}),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(j.error ?? r.statusText));
  return j;
}

function note(text: string): void {
  add("note", text);
}

// ---- events from the laptop ------------------------------------------------------
function connect(): void {
  if (!token) {
    caption.textContent = "Not paired";
    sub.textContent = "Scan the QR code shown in Kira's terminal on the laptop.";
    return;
  }
  const es = new EventSource(`/events?t=${encodeURIComponent(token)}`);
  es.onopen = () => {
    connected = true;
    render();
  };
  es.onerror = () => {
    connected = false;
    render();
  };
  es.onmessage = (m) => {
    const msg = JSON.parse(m.data as string) as PhoneMessage;
    switch (msg.kind) {
      case "snapshot":
        deck = msg.deck;
        voice = msg.voice;
        break;
      case "event":
        deck = reduceDeck(deck, msg.event);
        onRunEvent(msg.event);
        break;
      case "voiceStatus":
        voice = msg.status;
        break;
      case "voice":
        onVoice(msg.event);
        break;
    }
    render();
  };
}

function onVoice(e: VoiceUiEvent): void {
  switch (e.type) {
    case "utterance":
      add("you", e.text);
      thinkingSince = Date.now();
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
      if (e.state === "start") saying = said.get(e.id) ?? "";
      break;
    case "audio_out":
      play(e.pcm, e.rate);
      break;
    case "audio_hush":
      stopPlayback();
      break;
    case "ready":
      voice = { ...voice, running: true };
      break;
  }
}

function onRunEvent(e: KiraEvent): void {
  if (e.type === "run_started") {
    thinkingSince = 0;
    note(`Started: ${e.goal}`);
  } else if (e.type === "report") {
    note(`${e.report.status.toUpperCase()}: ${e.report.summary.split("\n")[0]}`);
  }
}

// ---- Kira's voice on the phone -------------------------------------------------------
let ac: AudioContext | undefined;
let nextAt = 0;
const sources = new Set<AudioBufferSourceNode>();

function audio(): AudioContext {
  ac ??= new AudioContext();
  if (ac.state === "suspended") void ac.resume();
  return ac;
}

function play(b64: string, rate: number): void {
  const a = audio();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  if (!pcm.length) return;
  const buf = a.createBuffer(1, pcm.length, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
  const src = a.createBufferSource();
  src.buffer = buf;
  src.connect(a.destination);
  const at = Math.max(a.currentTime + 0.03, nextAt);
  src.start(at);
  nextAt = at + buf.duration;
  sources.add(src);
  src.onended = () => sources.delete(src);
  $("sound").hidden = a.state === "running";
}

function stopPlayback(): void {
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      // already ended
    }
  }
  sources.clear();
  nextAt = 0;
}

const playing = () => !!ac && ac.currentTime < nextAt;

// iOS and Android only allow sound after a touch: unlock on the first one.
document.addEventListener(
  "pointerdown",
  () => {
    audio();
    $("sound").hidden = true;
  },
  { capture: true },
);

// ---- your voice ------------------------------------------------------------------
type Rec = { stream: MediaStream; node: ScriptProcessorNode; src: MediaStreamAudioSourceNode; chunks: Float32Array[]; rate: number; handsFree: boolean; heardAt: number; quietSince: number; started: number };
let rec: Rec | undefined;
let pressAt = 0;

async function startRecording(): Promise<void> {
  const a = audio();
  stopPlayback();
  void api("/hush").catch(() => undefined);
  let stream: MediaStream;
  try {
    // The phone's own echo cancelling, noise suppression and gain: a clean, steady voice for transcription.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (err) {
    note(`Microphone blocked: ${(err as Error).message}. Allow the microphone for this page in the browser settings.`);
    return;
  }
  const src = a.createMediaStreamSource(stream);
  const node = a.createScriptProcessor(4096, 1, 1);
  const r: Rec = { stream, node, src, chunks: [], rate: a.sampleRate, handsFree: false, heardAt: 0, quietSince: 0, started: performance.now() };
  node.onaudioprocess = (ev) => {
    const d = ev.inputBuffer.getChannelData(0);
    r.chunks.push(new Float32Array(d));
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i]! * d[i]!;
    level = Math.sqrt(sum / d.length);
    const now = performance.now();
    // Hands-free (tapped once): send after the speaker goes quiet, like the laptop's end of sentence.
    if (level > 0.02) {
      r.heardAt ||= now;
      r.quietSince = 0;
    } else if (r.heardAt) r.quietSince ||= now;
    if (r.handsFree && r.heardAt && r.quietSince && now - r.quietSince > 1300) void stopRecording(true);
    if (now - r.started > 45_000) void stopRecording(true);
  };
  src.connect(node);
  node.connect(a.destination); // some browsers only run the processor when it is connected
  rec = r;
  render();
}

async function stopRecording(send: boolean): Promise<void> {
  const r = rec;
  if (!r) return;
  rec = undefined;
  level = 0;
  r.node.onaudioprocess = null;
  r.src.disconnect();
  r.node.disconnect();
  for (const t of r.stream.getTracks()) t.stop();
  render();
  if (!send) return;
  const pcm = to16k(r.chunks, r.rate);
  thinkingSince = Date.now();
  render();
  try {
    await api("/audio", undefined, pcm.buffer as ArrayBuffer);
  } catch (err) {
    thinkingSince = 0;
    note(`Couldn't send that: ${(err as Error).message}`);
  }
}

/** Joins the recording and resamples it to 16 kHz int16 (averaging, which also filters what 16 kHz can't hold). */
function to16k(chunks: Float32Array[], rate: number): Int16Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const ratio = rate / 16000;
  const out = new Int16Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j]!;
    out[i] = Math.max(-1, Math.min(1, s / (b - a))) * 32767;
  }
  return out;
}

talk.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  if (rec) return void stopRecording(true); // second tap in hands-free mode: send now
  pressAt = performance.now();
  void startRecording();
});
const release = () => {
  if (!rec || !pressAt) return;
  const held = performance.now() - pressAt;
  pressAt = 0;
  if (held >= 350) void stopRecording(true); // held: push-to-talk
  else {
    rec.handsFree = true; // tapped: keep listening until they stop talking
    render();
  }
};
talk.addEventListener("pointerup", release);
talk.addEventListener("pointercancel", release);
talk.addEventListener("contextmenu", (e) => e.preventDefault());

$("composer").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.blur();
  api("/ask", { text }).catch((err: Error) => note(`Couldn't send that: ${err.message}`));
});

runEl.addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button");
  if (!b) return;
  if (b.dataset.act === "stop") void api("/stop").catch(() => undefined);
  if (b.dataset.act === "allow" || b.dataset.act === "deny") void api("/approve", { id: b.dataset.id, allow: b.dataset.act === "allow" }).catch(() => undefined);
  if (b.dataset.act === "voice") void api("/voice", { on: true }).catch((err: Error) => note(err.message));
});

// ---- render ----------------------------------------------------------------------
type Line = { who: "you" | "kira" | "note"; text: string };
const lines: Line[] = [];
function add(who: Line["who"], text: string): void {
  const t = text.trim();
  if (!t) return;
  lines.push({ who, text: t });
  const div = document.createElement("div");
  div.className = `msg ${who}`;
  div.textContent = t;
  chat.appendChild(div);
  while (chat.children.length > 60) chat.firstElementChild?.remove();
  chat.scrollTop = chat.scrollHeight;
}

const runActive = () => !!deck.run && !deck.report && deck.run.state !== "IDLE";

function mode(): OrbMode {
  if (!connected) return "offline";
  if (rec) return "hearing";
  if (playing()) return "speaking";
  if (thinkingSince && Date.now() - thinkingSince < 20_000) return "thinking";
  if (runActive()) return "working";
  return voice.running ? "idle" : "muted";
}

function lastNarration(): string {
  for (let i = deck.steps.length - 1; i >= 0; i--) {
    const n = deck.steps[i]!.narration.at(-1);
    if (n) return n;
  }
  return deck.run?.detail ?? "";
}

let lastMode: OrbMode | undefined;
function render(): void {
  const m = mode();
  lastMode = m;
  document.body.dataset.mode = m;
  $("conn").className = `conn ${connected ? "on" : ""}`;
  $("conn").textContent = connected ? "connected" : token ? "reconnecting…" : "not paired";
  const captions: Record<OrbMode, string> = {
    offline: token ? "Can't reach the laptop" : "Not paired",
    muted: "Voice is off on the laptop",
    idle: "Hold the button and talk",
    hearing: rec?.handsFree ? "Listening… (tap to send)" : "Listening… (let go to send)",
    thinking: "Thinking…",
    speaking: saying,
    working: deck.run ? `Working: ${deck.run.goal}` : "Working…",
  };
  caption.textContent = captions[m];
  sub.textContent =
    m === "offline"
      ? token
        ? "Is Kira running with --phone, and is this phone on the same Wi-Fi?"
        : "Scan the QR code shown in Kira's terminal on the laptop."
      : m === "working"
        ? lastNarration().slice(0, 200)
        : "";
  talk.classList.toggle("rec", !!rec);
  talk.disabled = !connected || !voice.running;
  hint.textContent = rec ? (rec.handsFree ? "Tap to send now" : "Let go to send") : "Hold to talk · tap to talk hands-free";
  renderRun();
}

function renderRun(): void {
  const r = deck.run;
  if (!r && voice.running) {
    runEl.hidden = true;
    return;
  }
  runEl.hidden = false;
  if (!r) {
    runEl.innerHTML = `<div class="row"><span>Voice is off on the laptop.</span><button data-act="voice">Turn on</button></div>`;
    return;
  }
  const active = runActive();
  const status = deck.report ? deck.report.status : r.state.toLowerCase().replace(/_/g, " ");
  const step = deck.steps.at(-1)?.n;
  runEl.innerHTML = `
    <div class="row">
      <span class="pill ${deck.report ? (deck.report.status === "done" ? "good" : "warn") : "busy"}">${esc(status)}</span>
      ${step ? `<span class="muted">step ${step}</span>` : ""}
      ${active ? `<button class="danger" data-act="stop">Stop</button>` : ""}
    </div>
    <div class="goal">${esc(r.goal)}</div>
    ${pendingApprovals(deck)
      .map(
        (a) => `<div class="approval">
          <b>Kira wants to ${esc(a.request.category.replace(/-/g, " "))}</b>
          <div class="small">${esc(a.request.summary)}</div>
          <div class="row"><button data-act="allow" data-id="${esc(a.id)}">Allow</button><button class="secondary" data-act="deny" data-id="${esc(a.id)}">Deny</button></div>
        </div>`,
      )
      .join("")}`;
}

startOrb($<HTMLCanvasElement>("orb"), () => ({ mode: mode(), level }), (s) => {
  if (s.mode !== lastMode) render();
});
render();
connect();
