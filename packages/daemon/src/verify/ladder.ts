/**
 * The verification ladder (spec §4.3). Cheap gates first; the first failure
 * in L0–L4 stops the climb, so the model gets the cheapest useful feedback.
 * L5 (critic) runs only on work that passed everything else.
 *
 *   L0 typecheck · L1 build · L2 tests · L3 boots and serves 200 ·
 *   L4 renders real content in a browser · L5 cross-family critique + stub scan
 *
 * Per-project overrides: .kira/verify.json, or "kira": {"verify": {...}} in package.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ErrorRepeatTracker } from "../agent/error-hash.js";
import { CheckpointManager } from "../checkpoint/manager.js";
import type { Verifier } from "../control/runner.js";
import { runDirFor } from "../control/runner.js";
import { PtyProcess, runInPty } from "../process/pty-process.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { isAbortError, sleep } from "../util/abort.js";
import { stripAnsi, truncateMiddle } from "../util/text.js";
import { checkPage, judgePage, NoBrowserError } from "./browser.js";
import { chooseCritic, critique, type CriticChoice } from "./critic.js";
import { findStubs } from "./stubs.js";
import type { GateResult, LadderLevel, LadderReport } from "./types.js";

export interface VerifyConfig {
  /** Project folder, workspace-relative (default: detected from package.json and the run's changes). */
  root?: string;
  /** Command overrides; false skips the gate. */
  typecheck?: string | false;
  build?: string | false;
  test?: string | false;
  /** Dev-server command for L3/L4 (default: npm run dev, else npm start). */
  start?: string | false;
  /** URL to check (default: the first localhost URL the server prints). */
  url?: string;
  /** L4: text that must appear on the rendered page. */
  expectText?: string[];
  /** L4: a CSS selector that must be visible. */
  selector?: string;
}

export interface LadderDeps {
  workspace: string;
  config?: VerifyConfig;
  /** Picks the critic for a given executor label ("provider/model"). */
  critic?: (executor: string | undefined) => CriticChoice | undefined;
  checkpoints?: CheckpointManager;
  /** Levels to run (default all). */
  levels?: LadderLevel[];
  timeouts?: Partial<Record<"typecheck" | "build" | "test" | "boot", number>>;
}

export interface LadderInput {
  runId: string;
  round: number;
  goal: string;
  claim: string;
  baseSha: string | undefined;
  executor: string | undefined;
  signal: AbortSignal;
}

const URL_PATTERN = /https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?[^\s]*/i;
const ALL: LadderLevel[] = ["L0", "L1", "L2", "L3", "L4", "L5"];
/** Changes the critic is told about but does not read line by line. */
const REVIEW_NOISE = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lockb",
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/*.map",
];

interface PackageJson {
  scripts?: Record<string, string>;
  kira?: { verify?: VerifyConfig };
}

export function createVerifier(deps: Omit<LadderDeps, "critic"> & { registry?: ProviderRegistry; critic?: LadderDeps["critic"] }): Verifier {
  const repeats = new ErrorRepeatTracker();
  const critic = deps.critic ?? (deps.registry ? (exec: string | undefined) => chooseCritic(deps.registry!, exec) : undefined);
  return {
    verify: async (input) => {
      const report = await runLadder(input, { ...deps, critic });
      if (!report.passed) {
        const failed = report.gates.find((g) => g.status === "fail");
        if (failed && repeats.record(`${failed.level} ${failed.summary}\n${failed.details ?? ""}`) >= 3) {
          report.escalate = true;
          report.summary = `Same verification failure 3 times; escalating. ${report.summary}`;
        }
      }
      return report;
    },
  };
}

export async function runLadder(input: LadderInput, deps: LadderDeps): Promise<LadderReport> {
  const levels = new Set(deps.levels ?? ALL);
  const gates: GateResult[] = [];
  const concerns: string[] = [];
  const outDir = join(runDirFor(deps.workspace, input.runId), "verify");
  mkdirSync(outDir, { recursive: true });

  let checkpoints = deps.checkpoints;
  if (!checkpoints && input.baseSha) checkpoints = await CheckpointManager.open(deps.workspace).catch(() => undefined);
  const diff = input.baseSha && checkpoints ? await checkpoints.diffFrom(input.baseSha, { maxChars: 120_000 }) : undefined;

  const project = detectProject(deps.workspace, diff?.files.map((f) => f.path) ?? [], deps.config);
  const cfg = project.config;
  const scripts = project.pkg?.scripts ?? {};
  const t = { typecheck: 180_000, build: 300_000, test: 300_000, boot: 60_000, ...deps.timeouts };
  const failedSoFar = () => gates.some((g) => g.status === "fail");

  const command = async (level: LadderLevel, name: string, cmd: string | undefined, timeoutMs: number, skipWhy: string) => {
    if (!levels.has(level) || failedSoFar()) return;
    if (!cmd) {
      gates.push({ level, name, status: "skip", summary: skipWhy, durationMs: 0 });
      return;
    }
    const started = Date.now();
    const r = await runInPty(cmd, { cwd: project.root, timeoutMs, signal: input.signal });
    const out = stripAnsi(r.output).trim();
    const ok = !r.timedOut && r.exitCode === 0;
    gates.push({
      level,
      name,
      status: ok ? "pass" : "fail",
      summary: ok ? `\`${cmd}\` passed` : r.timedOut ? `\`${cmd}\` timed out after ${timeoutMs / 1000}s` : `\`${cmd}\` exited ${r.exitCode}`,
      ...(ok ? {} : { details: truncateMiddle(out, 3_000) }),
      durationMs: Date.now() - started,
    });
  };

  // ---- L0–L2: project scripts -------------------------------------------------
  await command("L0", "typecheck", pick(cfg.typecheck, typecheckCommand(project.root, scripts)), t.typecheck, "no typecheck script or tsconfig");
  await command("L1", "build", pick(cfg.build, scripts.build ? "npm run build" : undefined), t.build, "no build script");
  await command("L2", "tests", pick(cfg.test, scripts.test && !/no test specified/.test(scripts.test) ? "npm test" : undefined), t.test, "no test script");

  // ---- L3–L4: boot, serve, render ----------------------------------------------
  const startCmd = pick(cfg.start, scripts.dev ? "npm run dev" : scripts.start ? "npm start" : undefined);
  let server: PtyProcess | undefined;
  try {
    let url = cfg.url;
    if (levels.has("L3") && !failedSoFar()) {
      const started = Date.now();
      if (!startCmd && !url) {
        gates.push({ level: "L3", name: "boots and serves", status: "skip", summary: "no dev/start script or URL to check", durationMs: 0 });
      } else {
        let output = "";
        if (startCmd) {
          server = PtyProcess.spawn(startCmd, { cwd: project.root });
          server.onData((d) => (output += stripAnsi(d)));
        }
        const boot = await waitForServer(() => output, server, url, t.boot, input.signal);
        url = boot.url ?? url;
        gates.push({
          level: "L3",
          name: "boots and serves",
          status: boot.ok ? "pass" : "fail",
          summary: boot.summary,
          ...(boot.ok ? {} : { details: truncateMiddle(output.trim(), 3_000) }),
          durationMs: Date.now() - started,
        });
      }
    }

    if (levels.has("L4") && !failedSoFar()) {
      const started = Date.now();
      if (!url) {
        gates.push({ level: "L4", name: "renders content", status: "skip", summary: "nothing is served, so there is no page to check", durationMs: 0 });
      } else {
        try {
          const shot = join(outDir, `round-${input.round}-l4.png`);
          const page = await checkPage(url, { expectText: cfg.expectText, selector: cfg.selector, screenshotPath: shot, signal: input.signal });
          const why = judgePage(page);
          if (page.consoleErrors.length && !why) concerns.push(`L4: console errors on ${url}: ${page.consoleErrors[0]}`);
          gates.push({
            level: "L4",
            name: "renders content",
            status: why ? "fail" : "pass",
            summary: why ? `${url}: ${why}` : `${url} rendered ${page.text.length} characters of text${page.visibleMedia ? ` and ${page.visibleMedia} media` : ""}`,
            ...(why ? { details: pageDetails(page) } : {}),
            durationMs: Date.now() - started,
            artifacts: [shot],
          });
        } catch (err) {
          if (!(err instanceof NoBrowserError)) throw err;
          concerns.push("L4 was skipped: no browser available, so a blank page would not have been caught");
          gates.push({ level: "L4", name: "renders content", status: "skip", summary: err.message, durationMs: Date.now() - started });
        }
      }
    }
  } finally {
    if (server) await server.kill();
  }

  // ---- L5: stub scan + cross-family critic -------------------------------------
  if (levels.has("L5") && !failedSoFar()) {
    const started = Date.now();
    if (!diff) {
      concerns.push("L5 was skipped: no checkpoint to diff against");
      gates.push({ level: "L5", name: "critic", status: "skip", summary: "no diff available", durationMs: 0 });
    } else {
      // The critic reads source, not lockfiles or build output: a package-lock.json alone can fill its whole budget.
      const review = await checkpoints!.diffFrom(input.baseSha!, { maxChars: 120_000, exclude: REVIEW_NOISE });
      const hidden = diff.files.filter((f) => !review.files.some((r) => r.path === f.path)).map((f) => `${f.status} ${f.path}`);
      const stubs = findStubs(review.patch);
      const choice = deps.critic?.(input.executor);
      const blocking = stubs.map((s) => `${s.file}:${s.line} looks like a stub (${s.rule}): ${s.text}`);
      let criticLine = "no critic model configured";
      if (choice) {
        try {
          const patch = hidden.length
            ? `${review.patch}\n\n(Not shown: ${hidden.length} lockfile/generated file change(s): ${hidden.slice(0, 20).join(", ")})`
            : review.patch;
          const v = await critique(choice.chat, { goal: input.goal, claim: input.claim, patch, gateSummary: gatesLine(gates), stubs }, input.signal);
          blocking.push(...v.blocking);
          concerns.push(...v.concerns);
          criticLine = `${v.model ?? "critic"} ${v.pass ? "found no blocking issue" : `raised ${v.blocking.length} blocking issue(s)`}`;
          if (!choice.crossFamily) concerns.push(`the critic (${v.model}) is the same model family as the executor: a weaker, self-lenient review`);
        } catch (err) {
          if (isAbortError(err) || input.signal.aborted) throw err;
          concerns.push(`the critic was unavailable (${(err as Error).message.slice(0, 160)}), so only the static stub scan ran`);
          criticLine = "critic unavailable";
        }
      } else {
        concerns.push("no critic model is configured: only the static stub scan ran");
      }
      gates.push({
        level: "L5",
        name: "critic",
        status: blocking.length ? "fail" : "pass",
        summary: blocking.length
          ? `${blocking.length} blocking issue(s): ${blocking[0]}${blocking.length > 1 ? " …" : ""}`
          : `${review.files.length} changed file(s) reviewed${hidden.length ? ` (+${hidden.length} lockfile/generated not read)` : ""}; ${criticLine}; no stubs found`,
        ...(blocking.length ? { details: blocking.map((b) => `- ${b}`).join("\n") } : {}),
        durationMs: Date.now() - started,
      });
    }
  }

  const passed = !failedSoFar();
  return { passed, round: input.round, gates, concerns, summary: gatesLine(gates) };
}

function gatesLine(gates: GateResult[]): string {
  return gates.map((g) => `${g.level} ${g.status === "fail" ? `FAIL (${g.summary})` : g.status}`).join(" · ");
}

function pick(override: string | false | undefined, detected: string | undefined): string | undefined {
  if (override === false) return undefined;
  return override ?? detected;
}

function typecheckCommand(root: string, scripts: Record<string, string>): string | undefined {
  if (scripts.typecheck) return "npm run typecheck";
  const tsconfig = join(root, "tsconfig.json");
  if (!existsSync(tsconfig) || !existsSync(join(root, "node_modules", "typescript"))) return undefined;
  // Solution-style configs (only "references") check nothing with -p; the build script covers them.
  const raw = readFileSync(tsconfig, "utf8");
  if (/"references"\s*:/.test(raw) && /"files"\s*:\s*\[\s*\]/.test(raw)) return undefined;
  return "npx --no-install tsc --noEmit -p .";
}

async function waitForServer(
  output: () => string,
  server: PtyProcess | undefined,
  fixedUrl: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ ok: boolean; url?: string; summary: string }> {
  const deadline = Date.now() + timeoutMs;
  let url = fixedUrl;
  let last = "";
  while (Date.now() < deadline) {
    if (server?.hasExited) return { ok: false, summary: `the server exited with code ${await server.exited} before serving` };
    url ??= output().match(URL_PATTERN)?.[0];
    if (url) {
      try {
        const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
        await res.arrayBuffer();
        if (res.status === 200) return { ok: true, url, summary: `${url} returned 200` };
        last = `${url} returned ${res.status}`;
      } catch (err) {
        if (signal.aborted) throw err;
        last = `${url}: ${(err as Error).message}`;
      }
    }
    await sleep(400, signal);
  }
  return { ok: false, ...(url ? { url } : {}), summary: last || `no localhost URL appeared within ${timeoutMs / 1000}s` };
}

function pageDetails(p: Awaited<ReturnType<typeof checkPage>>): string {
  return [
    `status: ${p.status ?? "?"}`,
    `visible text (${p.text.length} chars): ${p.text.slice(0, 300) || "(none)"}`,
    `visible media: ${p.visibleMedia}`,
    ...(p.pageErrors.length ? [`page errors: ${p.pageErrors.join(" | ")}`] : []),
    ...(p.consoleErrors.length ? [`console errors: ${p.consoleErrors.slice(0, 5).join(" | ")}`] : []),
    ...(p.missingText.length ? [`missing text: ${p.missingText.join(", ")}`] : []),
  ].join("\n");
}

/** Finds the project the run worked on: config, else the package.json folder holding most of the changes. */
export function detectProject(
  workspace: string,
  changed: string[],
  override?: VerifyConfig,
): { root: string; pkg?: PackageJson; config: VerifyConfig } {
  const fileConfig = readJson<VerifyConfig>(join(workspace, ".kira", "verify.json"));
  const base = { ...fileConfig, ...override };
  const candidates: string[] = [];
  if (base.root) candidates.push(join(workspace, base.root));
  else {
    if (existsSync(join(workspace, "package.json"))) candidates.push(workspace);
    for (const e of safeReaddir(workspace)) {
      if (e.startsWith(".") || e === "node_modules") continue;
      if (existsSync(join(workspace, e, "package.json"))) candidates.push(join(workspace, e));
    }
  }
  let root = candidates[0] ?? workspace;
  if (!base.root && candidates.length > 1) {
    const score = (dir: string) => {
      const rel = relative(workspace, dir).split(sep).join("/");
      return rel ? changed.filter((f) => f.startsWith(`${rel}/`)).length : 0;
    };
    const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
    if (score(best) > 0) root = best;
  }
  const pkg = readJson<PackageJson>(join(root, "package.json"));
  return { root, ...(pkg ? { pkg } : {}), config: { ...pkg?.kira?.verify, ...base } };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
