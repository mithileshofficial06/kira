/**
 * Phase 2 exit test, visual half: the built Flight Deck webview, loaded in a
 * real browser with a stubbed VS Code API, replaying a real run's event
 * stream (recorded by the daemon test). A human must be able to follow the
 * run from the panel alone, and answer an approval from it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const EVENTS = JSON.parse(readFileSync(join(__dirname, "fixtures", "deck-events.json"), "utf8")) as { type: string; id?: string }[];
const SHOTS = process.env.KIRA_PREVIEW_DIR ?? join(tmpdir(), "kira-deck-preview");
const HARNESS = join(ROOT, "media", ".harness.html");

/** A dark VS Code theme's variables, enough for the panel to look like it does in the editor. */
const THEME = `
  --vscode-foreground:#cccccc; --vscode-editor-background:#1e1e1e; --vscode-font-family:Segoe UI, sans-serif; --vscode-font-size:13px;
  --vscode-editor-font-family:Consolas, monospace; --vscode-descriptionForeground:#9d9d9d; --vscode-panel-border:#3c3c3c;
  --vscode-button-background:#0e639c; --vscode-button-foreground:#fff; --vscode-button-hoverBackground:#1177bb;
  --vscode-button-secondaryBackground:#3a3d41; --vscode-button-secondaryForeground:#fff; --vscode-input-background:#3c3c3c;
  --vscode-input-foreground:#ccc; --vscode-textLink-foreground:#3794ff; --vscode-textCodeBlock-background:#2a2a2a;
  --vscode-sideBar-background:#252526; --vscode-terminal-background:#181818;`;

let browser: Browser | undefined;

beforeAll(() => {
  execFileSync(process.execPath, ["esbuild.mjs"], { cwd: ROOT, stdio: "ignore" });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(
    HARNESS,
    `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="xterm.css"><link rel="stylesheet" href="deck.css">
<style>body{${THEME}}</style>
<script>
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
  window.__feed = (events) => events.forEach((event) => window.postMessage({ type: "event", event }, "*"));
</script></head><body><div id="app"></div><script src="deck.js"></script></body></html>`,
  );
});

afterAll(async () => {
  await browser?.close();
  rmSync(HARNESS, { force: true });
});

async function open(): Promise<Page> {
  for (const channel of ["msedge", "chrome", "chromium"]) {
    try {
      browser ??= await chromium.launch({ channel, headless: true });
      break;
    } catch {
      /* next */
    }
  }
  if (!browser) throw new Error("no browser");
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(pathToFileURL(HARNESS).href);
  await page.waitForFunction(() => (window as unknown as { __posted: { type: string }[] }).__posted.some((m) => m.type === "ready"));
  expect(errors).toEqual([]);
  return page;
}

const feed = (page: Page, events: unknown[]) => page.evaluate((ev) => (window as unknown as { __feed: (e: unknown[]) => void }).__feed(ev), events);
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const HAS_BROWSER =
  process.platform !== "win32" ||
  ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].some(existsSync);

describe.skipIf(!HAS_BROWSER)("Flight Deck webview", () => {
  it("mid-run: shows state, plan, steps and an approval the human can answer with a reason", async () => {
    const page = await open();
    const cut = EVENTS.findIndex((e) => e.type === "approval") + 1;
    await feed(page, EVENTS.slice(0, cut));
    await settle(page);
    await page.screenshot({ path: join(SHOTS, "deck-approval.png"), fullPage: true });

    await expect(page.locator("header .pill").innerText()).resolves.toBe("AWAITING APPROVAL");
    await expect(page.locator("header h1").innerText()).resolves.toBe("Add a greeting module");
    await expect(page.locator(".plan li").allInnerTexts()).resolves.toEqual(["▶Write the greeting module", "○Install left-pad", "○Verify and finish"]);
    await expect(page.locator(".approval pre").innerText()).resolves.toBe("npm install left-pad");
    expect(await page.locator(".step").count()).toBe(2);

    await page.fill('.approval input[data-draft^="note-"]', "Write it by hand");
    // A streaming event must not wipe what the human is typing.
    await feed(page, [{ type: "terminal", id: "x", data: "tick\r\n" }]);
    await settle(page);
    await page.click('.approval button[data-action="deny"]');
    const posted = await page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted);
    const approvalId = EVENTS[cut - 1]!.id;
    expect(posted).toContainEqual({ type: "approve", id: approvalId, allow: false, note: "Write it by hand" });
  }, 60_000);

  it("after the run: the whole run is legible from the panel alone", async () => {
    const page = await open();
    await feed(page, EVENTS);
    await settle(page);
    await page.screenshot({ path: join(SHOTS, "deck-report.png"), fullPage: true });

    const text = await page.locator("body").innerText();
    // Outcome and why.
    expect(text).toMatch(/Done · 4 steps/);
    expect(text).toMatch(/left-pad was declined so padding is hand-written/);
    expect(text).toMatch(/greeting is not localized/); // open concern from the critic
    // Plan, timeline, commands and their results.
    await expect(page.locator(".plan li").allInnerTexts()).resolves.toEqual(["✓Write the greeting module", "⤼Install left-pad", "▶Verify and finish"]);
    expect(await page.locator(".step").count()).toBe(4);
    expect(text).toMatch(/lay out the plan/);
    expect(await page.locator(".call.error").count()).toBe(1); // the declined install
    // Files changed, verification gates, cost.
    await expect(page.locator(".files li").allInnerTexts()).resolves.toEqual(["A src/greet.js"]);
    await expect(page.locator(".gates tr").count()).resolves.toBe(3);
    expect(text).toMatch(/PASSED/);
    expect(text).toMatch(/\$0\.0\d\d of \$2/);
    // The terminal mirror rendered the command output.
    await expect(page.locator(".xterm-rows").innerText()).resolves.toMatch(/greet ok/);
    // Idle again: the goal box is back for the next run.
    expect(await page.locator('input[data-draft="goal"]').count()).toBe(1);
    expect(await page.locator(".approval").count()).toBe(0);
  }, 60_000);
});
