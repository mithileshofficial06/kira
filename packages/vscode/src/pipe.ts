import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Same scheme as the daemon's pipeName (kept separate so the extension bundle never pulls in daemon runtime code). */
export function pipeName(workspace: string, nonce = randomBytes(4).toString("hex")): string {
  const h = createHash("sha256").update(workspace.toLowerCase()).digest("hex").slice(0, 12);
  return process.platform === "win32" ? `\\\\.\\pipe\\kira-${h}-${nonce}` : join(tmpdir(), `kira-${h}-${nonce}.sock`);
}
