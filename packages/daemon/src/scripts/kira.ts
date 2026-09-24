/**
 * Kira without VS Code: wake it by voice (or type), in any folder.
 *
 *   npm run kira -- --voice --workspace C:\path\to\project
 *   npm run kira -- --voice --always-listen --workspace DIR  (no wake word at all)
 *   npm run kira -- --workspace C:\path\to\project        (type goals instead)
 *
 * Say "Kira, <task>". "Kira, stop" (or just "stop" during a run) interrupts.
 * Questions ("Kira, what can you do?") get a spoken answer instead of a run.
 * After Kira answers or asks something, reply without saying "Kira" again.
 * "Kira, where did we leave off?" and "Kira, status" answer out loud.
 * Approvals: say "yes" / "no, <reason>", or type y / n in this terminal.
 *
 * Run it in a VS Code terminal (with the Kira extension installed) and Kira's
 * assistant opens in that window's right-hand side bar: an orb that listens,
 * thinks and speaks, the conversation, and the run's progress. --no-vscode opts out.
 */
import { config as loadEnv } from "dotenv";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { AutonomyLevel } from "../control/autonomy.js";
import type { KiraEvent } from "../control/events.js";
import { findConfig, loadModelsConfig } from "../config/models.js";
import { pendingApprovals } from "../daemon/deck.js";
import { KiraDaemon, pipeName } from "../daemon/server.js";
import { announce, findHook } from "../daemon/vscode-hook.js";
import { openMemory } from "../memory/run-memory.js";
import { ProviderRegistry } from "../providers/registry.js";
import { createVerifier } from "../verify/ladder.js";

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    voice: { type: "boolean", default: false },
    "always-listen": { type: "boolean", default: false },
    autonomy: { type: "string", default: "3" },
    "init-git": { type: "boolean", default: false },
    "no-verify": { type: "boolean", default: false },
    "voice-args": { type: "string", default: "" },
    "no-vscode": { type: "boolean", default: false },
  },
});
const workspace = resolve(values.workspace ?? process.cwd());
if (!existsSync(workspace)) {
  console.error(`No such folder: ${workspace}`);
  process.exit(2);
}

const configPath = findConfig();
loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });
const config = loadModelsConfig(configPath);
const registry = new ProviderRegistry(config);
const mistralKey = process.env[config.providers.mistral?.apiKeyEnv ?? "MISTRAL_API_KEY"]?.trim();

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const memory = await openMemory(workspace, registry, config);
// In a VS Code terminal, the window shows the assistant: it connects to this daemon over a local pipe.
const hook = values["no-vscode"] ? undefined : findHook(workspace);
const pipe = hook ? pipeName(workspace) : "";
const token = hook ? randomBytes(24).toString("hex") : "";
const daemon = new KiraDaemon({
  workspace,
  pipe,
  token,
  chatFor: (role) => (req, signal, onFallback) => registry.chat(role, req, signal, onFallback),
  pricing: config.pricing,
  verifier: () => (values["no-verify"] ? undefined : createVerifier({ workspace, registry })),
  memory,
  initGit: values["init-git"],
  defaults: { autonomy: Number(values.autonomy) as AutonomyLevel },
  log: (l) => console.log(dim(l)),
  ...(mistralKey ? { voice: { mistralApiKey: mistralKey, args: [...(values["always-listen"] ? ["--always-listen"] : []), ...(values["voice-args"] ? values["voice-args"].split(" ") : [])] } } : {}),
});

daemon.onEvent((k: KiraEvent) => {
  switch (k.type) {
    case "run_started":
      console.log(bold(`\n▶ ${k.goal}`));
      break;
    case "state":
      console.log(dim(`[${k.state}${k.detail ? `: ${k.detail.slice(0, 100)}` : ""}]`));
      break;
    case "approval":
      console.log(bold(`\n[approval] ${k.request.category}: ${k.request.summary}\n  say "yes" / "no, <reason>", or type y / n`));
      break;
    case "verification":
      for (const g of k.report.gates) console.log(`  [${g.level}] ${g.status.toUpperCase()} ${g.summary}`);
      break;
    case "report":
      console.log(bold(`\n■ ${k.report.status.toUpperCase()}: `) + k.report.summary.split("\n")[0]);
      break;
    case "agent": {
      const e = k.event;
      if (e.type === "narration") console.log(`kira: ${e.text}`);
      else if (e.type === "tool_call") console.log(dim(`  → ${e.text}`));
      else if (e.type === "tool_result" && e.text.startsWith("ERROR")) console.log(dim(`  ← ${e.text.slice(0, 160)}`));
      break;
    }
  }
});

console.log(`[kira] workspace: ${workspace}`);
if (hook) {
  await daemon.listen();
  const shown = await announce(hook, { pipe, token, workspace, pid: process.pid });
  console.log(shown ? "[kira] assistant opened in VS Code (right side bar)." : dim("[kira] could not reach the Kira extension in VS Code; continuing in this terminal."));
}
if (values.voice) {
  if (!mistralKey) {
    console.error("Voice needs MISTRAL_API_KEY in .env (Voxtral speech).");
    process.exit(2);
  }
  console.log("[kira] starting voice (first start downloads the local wake model, ~75 MB)…");
  const st = await daemon.voiceStart();
  console.log(`[kira] listening on "${st.input}", speaking on "${st.output}" (voice ${st.voice}).`);
  console.log(
    values["always-listen"]
      ? '[kira] always listening: just talk. Say "stop" to interrupt a run.'
      : '[kira] say "Kira, …" to start; after Kira answers, reply without the name. "stop" interrupts a run.',
  );
} else {
  console.log('[kira] type a goal and press Enter ("stop" interrupts, "exit" quits).');
}

// Typed input: goals when idle, y/n for approvals, "stop", "exit".
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  const deck = daemon.deckState();
  const pending = pendingApprovals(deck);
  if (/^(exit|quit)$/i.test(t)) return void shutdown();
  if (/^stop$/i.test(t)) return void daemon.stopRun();
  if (pending.length && /^(y|yes|n|no)\b/i.test(t)) {
    const allow = /^y/i.test(t);
    const note = t.replace(/^(y|yes|n|no)\b[\s,:-]*/i, "");
    daemon.approveRequest(pending[0]!.id, allow, note || undefined);
    return;
  }
  if (daemon.running) return void console.log(dim('(busy: type "stop" first)'));
  try {
    daemon.startRun(t);
  } catch (err) {
    console.log((err as Error).message);
  }
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  console.log("\n[kira] shutting down cleanly…");
  const st = daemon.voiceStatus();
  if (st.samples) console.log(`[kira] voice: median end-of-speech → first word ${st.ackP50Ms?.toFixed(0)} ms over ${st.samples} utterance(s)`);
  rl.close();
  await daemon.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
