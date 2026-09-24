/**
 * Kira on the phone: an HTTPS server on the laptop's Wi-Fi address that
 * serves one page (orb, conversation, run, push-to-talk) and its API.
 *
 *   GET  /                 the page (static; the token lives in its URL fragment)
 *   GET  /events?t=TOKEN   server-sent events: snapshot, run events, voice activity, Kira's audio
 *   POST /audio            push-to-talk audio, 16 kHz mono int16 PCM
 *   POST /ask              {"text"}: typed to Kira
 *   POST /hush | /stop     stop talking | stop the run
 *   POST /approve          {"id", "allow"}
 *   POST /voice            {"on"}: the laptop's voice loop on or off
 *
 * Every call except the page needs the pairing token (x-kira-token header, or
 * ?t= for the event stream, which cannot send headers). While a phone is
 * connected, Kira's voice plays on the phone instead of the laptop.
 * Server-sent events rather than WebSockets: iOS refuses WebSockets to a
 * self-signed certificate even after the page itself was trusted.
 */
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiraEvent } from "../control/events.js";
import type { DeckState } from "../daemon/deck.js";
import type { VoiceStatus } from "../daemon/protocol.js";
import type { VoiceUiEvent } from "../voice/bridge.js";
import { certificateFor, lanAddresses, pairingToken } from "./cert.js";

/** What the phone link needs from the daemon. KiraDaemon implements it. */
export interface PhoneHost {
  deckState(): DeckState;
  onEvent(fn: (e: KiraEvent) => void): () => void;
  onVoiceUi(fn: (e: VoiceUiEvent) => void): () => void;
  voiceStatus(): VoiceStatus;
  voiceStart(): Promise<VoiceStatus>;
  voiceStop(): Promise<VoiceStatus>;
  voiceAudio(pcm: Buffer): boolean;
  voiceOutput(target: "laptop" | "remote" | "both"): void;
  voiceHush(): void;
  ask(text: string): unknown;
  stopRun(): Promise<unknown>;
  approveRequest(id: string, allow: boolean, note?: string): unknown;
}

/** What the page receives on /events. */
export type PhoneMessage =
  | { kind: "snapshot"; deck: DeckState; voice: VoiceStatus }
  | { kind: "event"; event: KiraEvent }
  | { kind: "voice"; event: VoiceUiEvent }
  | { kind: "voiceStatus"; status: VoiceStatus };

const MAX_AUDIO = 4 * 1024 * 1024; // about two minutes of 16 kHz int16
const here = dirname(fileURLToPath(import.meta.url));

export interface PhoneLink {
  urls: string[];
  token: string;
  /** The URL to open on the phone (pairing included). */
  pairUrl: string;
  close(): Promise<void>;
}

export async function startPhoneLink(host: PhoneHost, opts: { port?: number; log?: (l: string) => void } = {}): Promise<PhoneLink> {
  const log = opts.log ?? (() => {});
  const port = opts.port ?? 7443;
  const ips = lanAddresses();
  const { key, cert } = await certificateFor(ips);
  const token = pairingToken();
  const page = await buildPage();
  const streams = new Set<ServerResponse>();

  const authed = (req: IncomingMessage, url: URL) => {
    const given = String(req.headers["x-kira-token"] ?? url.searchParams.get("t") ?? "");
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const send = (m: PhoneMessage) => {
    const line = `data: ${JSON.stringify(m)}\n\n`;
    for (const s of streams) s.write(line);
  };

  const offEvent = host.onEvent((e) => {
    if (e.type === "terminal" || e.type === "diff") return; // the phone shows the conversation, not the terminal
    send({ kind: "event", event: e });
    if (e.type === "run_started" || e.type === "report") send({ kind: "voiceStatus", status: host.voiceStatus() });
  });
  const offVoice = host.onVoiceUi((e) => {
    if (e.type === "level") return; // the laptop mic's level: the phone meters its own
    send({ kind: "voice", event: e });
    if (e.type === "ready") send({ kind: "voiceStatus", status: host.voiceStatus() });
  });

  const server: Server = createServer({ key, cert }, (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log(`phone: ${(err as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "https://kira");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src blob:", "Referrer-Policy": "no-referrer" });
      return void res.end(page);
    }
    if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
    if (!authed(req, url)) return json(res, 401, { error: "not paired: scan the QR code in Kira's terminal" });

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(`data: ${JSON.stringify({ kind: "snapshot", deck: { ...host.deckState(), terminal: "" }, voice: host.voiceStatus() } satisfies PhoneMessage)}\n\n`);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
      streams.add(res);
      if (streams.size === 1) {
        host.voiceOutput("remote");
        log("phone connected: Kira now speaks on the phone");
      }
      req.on("close", () => {
        clearInterval(heartbeat);
        streams.delete(res);
        if (streams.size === 0) {
          host.voiceOutput("laptop");
          log("phone disconnected: Kira speaks on the laptop again");
        }
      });
      return;
    }
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

    switch (url.pathname) {
      case "/audio": {
        const body = await readBody(req, MAX_AUDIO);
        if (!body) return json(res, 413, { error: "too long" });
        if (!host.voiceAudio(body.subarray(0, body.length - (body.length % 2)))) return json(res, 409, { error: "voice is off on the laptop" });
        return json(res, 200, { ok: true });
      }
      case "/ask": {
        const p = await readJson(req);
        const text = typeof p.text === "string" ? p.text : "";
        if (!text.trim()) return json(res, 400, { error: "text is required" });
        return json(res, 200, host.ask(text) ?? { ok: true });
      }
      case "/hush":
        host.voiceHush();
        return json(res, 200, { ok: true });
      case "/stop":
        await host.stopRun();
        return json(res, 200, { ok: true });
      case "/approve": {
        const p = await readJson(req);
        if (typeof p.id !== "string") return json(res, 400, { error: "id is required" });
        return json(res, 200, host.approveRequest(p.id, !!p.allow, "(answered on the phone)") ?? { ok: true });
      }
      case "/voice": {
        const p = await readJson(req);
        const status = p.on ? await host.voiceStart() : await host.voiceStop();
        if (p.on) host.voiceOutput("remote");
        send({ kind: "voiceStatus", status });
        return json(res, 200, status);
      }
    }
    return json(res, 404, { error: "not found" });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const urls = (ips.length ? ips : ["127.0.0.1"]).map((ip) => `https://${ip}:${port}/`);
  return {
    urls,
    token,
    pairUrl: `${urls[0]}#t=${token}`,
    close: async () => {
      offEvent();
      offVoice();
      for (const s of streams) s.end();
      streams.clear();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n > limit) {
        req.destroy();
        resolve(undefined);
      } else parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, 64 * 1024);
  try {
    const v = JSON.parse(body?.toString("utf8") || "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The page: one HTML file with its script bundled in (built once at startup). */
async function buildPage(): Promise<string> {
  const { build } = await import("esbuild");
  const dir = [join(here, "web"), join(here, "..", "..", "src", "remote", "web")].find((d) => existsSync(join(d, "phone.ts")));
  if (!dir) throw new Error("the phone page source (src/remote/web/phone.ts) is missing");
  const out = await build({ entryPoints: [join(dir, "phone.ts")], bundle: true, write: false, format: "iife", target: "es2020", minify: true, logLevel: "silent" });
  const js = out.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(join(dir, "phone.css"), "utf8");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
<meta name="theme-color" content="#07080f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Kira">
<title>Kira</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script>${js}</script>
</body>
</html>`;
}
