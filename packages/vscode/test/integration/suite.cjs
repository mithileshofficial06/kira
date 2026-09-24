// Runs inside the VS Code extension host (see run.mjs).
const assert = require("node:assert/strict");
const vscode = require("vscode");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

async function until(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("kira-dev.kira-agent");
  assert.ok(ext, "extension is installed");
  const api = await ext.activate();

  // Commands are registered.
  const commands = await vscode.commands.getCommands(true);
  for (const c of ["kira.start", "kira.stop", "kira.flightDeck", "kira.leftOff", "kira.remember", "kira.startVoice", "kira.stopVoice", "kira.openAssistant", "kira.restartDaemon"]) {
    assert.ok(commands.includes(c), `${c} is registered`);
  }

  // The Flight Deck opens.
  await vscode.commands.executeCommand("kira.flightDeck");
  await until(() => api.panelOpen(), 10_000, "the Flight Deck panel");
  const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  await until(() => tabs().includes("Kira Flight Deck"), 10_000, `the panel tab (tabs: ${tabs().join(", ")})`);

  // Starting a run launches the daemon, connects over the pipe and streams to the panel.
  // With no API key the run must still end in a report the panel can show.
  await vscode.commands.executeCommand("kira.start", "Call finish with outcome done and summary 'integration check'.");
  await until(() => api.daemonConnected(), 60_000, "the daemon to connect");
  await until(() => !!api.deck()?.report, 120_000, "the run's report");
  const deck = api.deck();
  assert.equal(deck.run.goal, "Call finish with outcome done and summary 'integration check'.");
  assert.equal(deck.run.workspace.toLowerCase(), process.env.KIRA_TEST_WORKSPACE.toLowerCase());
  assert.equal(deck.run.state, "IDLE");
  // This checks plumbing, not the model: with keys a real model may end "stuck" or "stalled" on a scratch
  // workspace. Whatever the outcome, the panel must get a report that says what happened.
  assert.ok(deck.report.summary.trim(), `report ${deck.report.status} has a summary`);

  // Memory answers through the daemon.
  await vscode.commands.executeCommand("kira.leftOff");
  // Voice starts through the daemon when a Mistral key is configured; without one it must fail cleanly.
  await vscode.commands.executeCommand("kira.startVoice");
  console.log(`[kira integration] voice listening: ${api.voiceListening()}`);
  if (api.voiceListening()) {
    await vscode.commands.executeCommand("kira.stopVoice");
    assert.equal(api.voiceListening(), false);
  }
  console.log(`[kira integration] report: ${deck.report.status} — ${deck.report.summary.split("\n")[0]}`);

  // `npm run kira` in a terminal of this window: the extension attaches to that daemon and opens the assistant.
  const hookFile = path.join(process.env.LOCALAPPDATA ?? "", "kira", "vscode-hooks", `${process.pid}.json`);
  await until(() => fs.existsSync(hookFile), 10_000, "the terminal link to be advertised");
  const hook = JSON.parse(fs.readFileSync(hookFile, "utf8")).pipe;
  const env = { ...process.env, KIRA_VSCODE_HOOK: hook };
  delete env.ELECTRON_RUN_AS_NODE;
  const cli = cp.spawn("node", ["--import", "tsx", "src/scripts/kira.ts", "--workspace", process.env.KIRA_TEST_WORKSPACE], {
    cwd: path.join(ext.extensionPath, "..", "daemon"),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let cliOut = "";
  cli.stdout.on("data", (d) => (cliOut += d));
  cli.stderr.on("data", (d) => (cliOut += d));
  try {
    await until(() => api.attached(), 60_000, "the extension to attach to the terminal's daemon");
    await until(() => api.assistantVisible(), 15_000, "the assistant view in the side bar");
    await until(() => cliOut.includes("assistant opened in VS Code"), 10_000, `the CLI to confirm (output: ${cliOut})`);
    cli.stdin.write("exit\n");
    await until(() => !api.daemonConnected(), 30_000, "the extension to notice the terminal session ended");
    console.log("[kira integration] terminal session attached, assistant shown, detached on exit");
  } finally {
    if (cli.exitCode === null) cli.kill();
  }
};
