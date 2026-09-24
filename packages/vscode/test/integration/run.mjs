// Runs the extension inside a real VS Code (the installed one if found, else a
// downloaded copy) against a scratch workspace, with a throwaway profile.
//   node test/integration/run.mjs
import { runTests } from "@vscode/test-electron";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Launched from inside VS Code (an extension host or its terminal), this is set and would start Code.exe as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = join(here, "..", "..");
execFileSync(process.execPath, ["esbuild.mjs"], { cwd: extensionDevelopmentPath, stdio: "inherit" });

// KIRA_VSCODE_DOWNLOAD=1 uses a cached, isolated download (.vscode-test/) instead of the installed VS Code,
// which refuses to start a second instance while it has an update pending.
const installed = process.env.KIRA_VSCODE_DOWNLOAD ? undefined : [
  process.env.KIRA_VSCODE,
  join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
  "C:/Program Files/Microsoft VS Code/Code.exe",
].find((p) => p && existsSync(p));

const workspace = mkdtempSync(join(tmpdir(), "kira-vscode-ws-"));
const userData = mkdtempSync(join(tmpdir(), "kira-vscode-user-"));
writeFileSync(join(workspace, "README.md"), "# scratch\n");
execFileSync("git", ["init", "-q"], { cwd: workspace });

try {
  await runTests({
    ...(installed ? { vscodeExecutablePath: installed } : {}),
    extensionDevelopmentPath,
    extensionTestsPath: join(here, "suite.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--user-data-dir", userData, "--skip-welcome", "--skip-release-notes"],
    extensionTestsEnv: { KIRA_TEST_WORKSPACE: workspace },
  });
} finally {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
  rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
}
