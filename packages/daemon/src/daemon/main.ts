/**
 * Daemon entry point. Started by the VS Code extension:
 *
 *   node dist/daemon/main.js --workspace <dir> --pipe <name>
 *   (session token in KIRA_DAEMON_TOKEN)
 *
 * Prints "KIRA_DAEMON_READY <pipe>" once listening. Exits when its parent
 * goes away (stdin closes), so a crashed VS Code never leaves it orphaned.
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findConfig, loadModelsConfig } from "../config/models.js";
import { openMemory } from "../memory/run-memory.js";
import { ProviderRegistry } from "../providers/registry.js";
import { createVerifier } from "../verify/ladder.js";
import { KiraDaemon, pipeName } from "./server.js";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    pipe: { type: "string" },
    "init-git": { type: "boolean", default: false },
  },
});
if (!values.workspace) {
  console.error("--workspace is required");
  process.exit(2);
}
const workspace = resolve(values.workspace);
const token = process.env.KIRA_DAEMON_TOKEN;
// Nothing the agent runs may see the session token.
delete process.env.KIRA_DAEMON_TOKEN;
if (!token) {
  console.error("KIRA_DAEMON_TOKEN is not set");
  process.exit(2);
}

// Config: the workspace's own kira.models.json, else the one shipped beside the daemon.
const here = dirname(fileURLToPath(import.meta.url));
let configPath: string;
try {
  configPath = findConfig(workspace);
} catch {
  configPath = findConfig(here);
}
const envFile = join(dirname(configPath), ".env");
if (existsSync(envFile)) loadEnv({ path: envFile, quiet: true });
const config = loadModelsConfig(configPath);
const registry = new ProviderRegistry(config);
const log = (line: string) => process.stderr.write(`[kira-daemon] ${line}\n`);
if (registry.chain("executor").length === 0) log(`no API key for any executor model (looked in ${envFile}); runs will fail until one is set`);

const memory = await openMemory(workspace, registry, config);
const pipe = values.pipe ?? pipeName(workspace);
const daemon = new KiraDaemon({
  workspace,
  pipe,
  token,
  chatFor: (role) => (req, signal, onFallback) => registry.chat(role, req, signal, onFallback),
  pricing: config.pricing,
  verifier: () => createVerifier({ workspace, registry }),
  memory,
  initGit: values["init-git"],
  log,
  ...(process.env[config.providers.mistral?.apiKeyEnv ?? "MISTRAL_API_KEY"]?.trim()
    ? { voice: { mistralApiKey: process.env[config.providers.mistral?.apiKeyEnv ?? "MISTRAL_API_KEY"]!.trim() } }
    : {}),
});
await daemon.listen();
process.stdout.write(`KIRA_DAEMON_READY ${pipe}\n`);

let closing = false;
const shutdown = async (why: string) => {
  if (closing) return;
  closing = true;
  log(`shutting down: ${why}`);
  const force = setTimeout(() => process.exit(1), 20_000);
  await daemon.close().catch((err: unknown) => log(`close failed: ${(err as Error).message}`));
  clearTimeout(force);
  process.exit(0);
};
process.stdin.on("end", () => void shutdown("parent closed stdin"));
process.stdin.on("close", () => void shutdown("parent closed stdin"));
process.stdin.resume();
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
