import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KiraEvent } from "../src/control/events.js";
import { emptyDeck } from "../src/daemon/deck.js";
import type { VoiceUiEvent } from "../src/voice/bridge.js";
import { startPhoneLink, type PhoneHost, type PhoneLink } from "../src/remote/phone.js";

const PORT = 17_000 + Math.floor(Math.random() * 2000);
let base: string;
let link: PhoneLink;
const calls: { name: string; arg?: unknown }[] = [];
let emitEvent: (e: KiraEvent) => void = () => {};
let emitVoice: (e: VoiceUiEvent) => void = () => {};

const host: PhoneHost = {
  deckState: () => ({ ...emptyDeck(), terminal: "lots of terminal output" }),
  onEvent: (fn) => ((emitEvent = fn), () => {}),
  onVoiceUi: (fn) => ((emitVoice = fn), () => {}),
  voiceStatus: () => ({ running: true, samples: 0 }),
  voiceStart: async () => ({ running: true, samples: 0 }),
  voiceStop: async () => ({ running: false, samples: 0 }),
  voiceAudio: (pcm) => (calls.push({ name: "audio", arg: pcm.length }), true),
  voiceOutput: (t) => void calls.push({ name: "output", arg: t }),
  voiceHush: () => void calls.push({ name: "hush" }),
  ask: (text) => (calls.push({ name: "ask", arg: text }), { ok: true }),
  stopRun: async () => void calls.push({ name: "stop" }),
  approveRequest: (id, allow) => (calls.push({ name: "approve", arg: `${id}:${allow}` }), { ok: true }),
};

function call(method: string, path: string, opts: { token?: string; body?: Buffer | string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, method, path, rejectUnauthorized: false, headers: opts.token ? { "x-kira-token": opts.token } : {} },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "kira-phone-"));
  process.env.LOCALAPPDATA = base; // cert and token go here, not in the real profile
  link = await startPhoneLink(host, { port: PORT });
}, 60_000);
afterAll(async () => {
  await link?.close();
  rmSync(base, { recursive: true, force: true });
});

describe("phone link", () => {
  it("serves the page to anyone, but nothing else without the pairing token", async () => {
    const page = await call("GET", "/");
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/<script>[\s\S]{2000,}<\/script>/);
    expect((await call("POST", "/ask", { body: '{"text":"hi"}' })).status).toBe(401);
    expect((await call("POST", "/ask", { token: "0".repeat(link.token.length), body: '{"text":"hi"}' })).status).toBe(401);
    expect(link.pairUrl).toContain(`#t=${link.token}`);
  });

  it("streams the conversation, sends Kira's voice to the phone while connected, and takes push-to-talk audio", async () => {
    const got: string[] = [];
    let close: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port: PORT, path: `/events?t=${link.token}`, rejectUnauthorized: false }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          for (const m of d.split("\n\n")) if (m.startsWith("data: ")) got.push(m.slice(6));
          resolve();
        });
      });
      req.end();
      close = () => req.destroy();
    });
    await opened;
    const snap = JSON.parse(got[0]!) as { kind: string; deck: { terminal: string } };
    expect(snap.kind).toBe("snapshot");
    expect(snap.deck.terminal).toBe(""); // the phone doesn't get the terminal stream
    expect(calls).toContainEqual({ name: "output", arg: "remote" });

    emitVoice({ type: "say", id: "s1", text: "Hello." });
    emitVoice({ type: "level", rms: 0.1, speech: true }); // the laptop mic's level: not for the phone
    emitVoice({ type: "audio_out", rate: 24000, pcm: "AAAA" });
    emitEvent({ type: "terminal", id: "t", data: "npm install…" });
    await new Promise((r) => setTimeout(r, 200));
    const kinds = got.slice(1).map((g) => JSON.parse(g) as { kind: string; event: { type: string } }).map((m) => `${m.kind}:${m.event.type}`);
    expect(kinds).toEqual(["voice:say", "voice:audio_out"]);

    expect((await call("POST", "/audio", { token: link.token, body: Buffer.alloc(32001) })).status).toBe(200);
    expect(calls).toContainEqual({ name: "audio", arg: 32000 }); // whole int16 samples only
    expect((await call("POST", "/ask", { token: link.token, body: '{"text":"what is running?"}' })).status).toBe(200);
    expect((await call("POST", "/approve", { token: link.token, body: '{"id":"ap1","allow":true}' })).status).toBe(200);
    expect((await call("POST", "/hush", { token: link.token })).status).toBe(200);
    expect(calls.map((c) => c.name)).toEqual(expect.arrayContaining(["ask", "approve", "hush"]));

    close();
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c.name === "output").at(-1)?.arg).toBe("laptop");
  });
});
