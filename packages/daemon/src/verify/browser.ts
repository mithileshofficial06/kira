/**
 * L4 semantic check (spec §4.3, §9.4). Narrow surface: goto, wait, read the
 * rendered text, collect console and page errors, screenshot. Uses an
 * installed Edge or Chrome through playwright-core, so no browser download.
 */
import { existsSync } from "node:fs";
import type { Browser } from "playwright-core";

export interface PageCheck {
  url: string;
  status: number | undefined;
  /** document.body.innerText, trimmed and truncated. */
  text: string;
  /** Visible images, canvases, SVGs and videos larger than 16×16 px. */
  visibleMedia: number;
  consoleErrors: string[];
  pageErrors: string[];
  missingText: string[];
  missingSelector?: string;
  screenshot?: string;
}

export interface PageCheckOptions {
  expectText?: string[];
  selector?: string;
  screenshotPath?: string;
  /** How long to let a client-side app render after load. */
  settleMs?: number;
  signal: AbortSignal;
}

export class NoBrowserError extends Error {
  override name = "NoBrowserError";
}

async function launch(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const explicit = process.env.KIRA_BROWSER;
  if (explicit && existsSync(explicit)) return chromium.launch({ executablePath: explicit, headless: true });
  const errors: string[] = [];
  for (const channel of ["msedge", "chrome", "chromium"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (err) {
      errors.push(`${channel}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new NoBrowserError(`No Chromium-family browser found (set KIRA_BROWSER to an executable). ${errors.join("; ")}`);
}

export async function checkPage(url: string, opts: PageCheckOptions): Promise<PageCheck> {
  const browser = await launch();
  const onAbort = () => void browser.close().catch(() => undefined);
  opts.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 500));
    });
    page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}`.slice(0, 500)));

    const res = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    // Client-rendered apps paint after load: wait for text, but not forever.
    // In-page code is passed as strings: it runs in the browser, not under Node's types.
    await page
      .waitForFunction('(document.body?.innerText ?? "").trim().length > 0', undefined, { timeout: opts.settleMs ?? 4_000 })
      .catch(() => undefined);
    await page.waitForTimeout(300);

    const { text, visibleMedia } = await page.evaluate<{ text: string; visibleMedia: number }>(`(() => {
      const media = [...document.querySelectorAll("img, canvas, svg, video")].filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 16 && r.height > 16 && s.visibility !== "hidden" && s.display !== "none";
      }).length;
      return { text: (document.body?.innerText ?? "").trim(), visibleMedia: media };
    })()`);
    const missingText = (opts.expectText ?? []).filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
    let missingSelector: string | undefined;
    if (opts.selector) {
      const visible = await page
        .locator(opts.selector)
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible) missingSelector = opts.selector;
    }
    if (opts.screenshotPath) await page.screenshot({ path: opts.screenshotPath, fullPage: false });
    return {
      url,
      status: res?.status(),
      text: text.slice(0, 2_000),
      visibleMedia,
      consoleErrors,
      pageErrors,
      missingText,
      ...(missingSelector ? { missingSelector } : {}),
      ...(opts.screenshotPath ? { screenshot: opts.screenshotPath } : {}),
    };
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
    await browser.close().catch(() => undefined);
  }
}

/** The L4 verdict on a page check: why it fails, or undefined when it passes. */
export function judgePage(c: PageCheck): string | undefined {
  if (c.status !== undefined && c.status >= 400) return `HTTP ${c.status}`;
  if (c.pageErrors.length) return `uncaught page error: ${c.pageErrors[0]}`;
  if (c.text.length === 0 && c.visibleMedia === 0) return "the page is blank: no visible text or media after it loaded";
  if (c.missingText.length) return `expected text not found: ${c.missingText.map((t) => JSON.stringify(t)).join(", ")}`;
  if (c.missingSelector) return `expected element not visible: ${c.missingSelector}`;
  return undefined;
}
