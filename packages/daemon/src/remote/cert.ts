/**
 * The phone link's HTTPS identity. Phone browsers only give a page the
 * microphone over HTTPS, so Kira makes a self-signed certificate for the
 * laptop's Wi-Fi addresses (the phone asks once to trust it), and a pairing
 * token. Both are kept, so a paired phone stays paired across restarts.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { generate } from "selfsigned";

export function remoteDir(): string {
  const d = join(process.env.LOCALAPPDATA || join(homedir(), ".cache"), "kira", "remote");
  mkdirSync(d, { recursive: true });
  return d;
}

const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier/i;

/** The laptop's addresses a phone on the same Wi-Fi can reach, Wi-Fi first. */
export function lanAddresses(): string[] {
  const found: { ip: string; score: number }[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal || !PRIVATE.test(a.address)) continue;
      found.push({ ip: a.address, score: /wi-?fi|wlan|wireless/i.test(name) ? 0 : 1 });
    }
  }
  return found.sort((a, b) => a.score - b.score).map((f) => f.ip);
}

interface Stored {
  key: string;
  cert: string;
  ips: string[];
  expires: number;
}

/** A certificate valid for `ips` (made again when an address changes or it nears expiry). */
export async function certificateFor(ips: string[]): Promise<{ key: string; cert: string }> {
  const file = join(remoteDir(), "cert.json");
  if (existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as Stored;
      if (ips.every((ip) => s.ips.includes(ip)) && s.expires - Date.now() > 30 * 86_400_000) return s;
    } catch {
      // unreadable: make a new one
    }
  }
  const notAfterDate = new Date(Date.now() + 365 * 86_400_000);
  const pems = await generate([{ name: "commonName", value: "Kira on this laptop" }], {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }, ...ips.map((ip) => ({ type: 7 as const, ip }))] },
    ],
  });
  const stored: Stored = { key: pems.private, cert: pems.cert, ips, expires: notAfterDate.getTime() };
  writeFileSync(file, JSON.stringify(stored));
  return stored;
}

/** The pairing token (kept; delete %LOCALAPPDATA%\kira\remote\token to unpair every phone). */
export function pairingToken(): string {
  const file = join(remoteDir(), "token");
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{32,}$/.test(t)) return t;
  }
  const t = randomBytes(24).toString("hex");
  writeFileSync(file, t);
  return t;
}
