// Bundles the extension host code (CommonJS, `vscode` external) and the
// Flight Deck and assistant webviews (browser IIFEs, xterm included), and copies xterm's CSS.
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const watch = process.argv.includes("--watch");

await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  // An installed VSIX is not next to the daemon package: remember where it is.
  define: { __KIRA_DAEMON_DIR__: JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), "..", "daemon")) },
  outfile: "dist/extension.js",
  sourcemap: true,
  logLevel: "info",
});

await build({
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: "media/deck.js",
  logLevel: "info",
});

await build({
  entryPoints: ["src/webview/assistant.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: "media/assistant.js",
  logLevel: "info",
});

mkdirSync("media", { recursive: true });
copyFileSync(join(dirname(require.resolve("@xterm/xterm/package.json")), "css", "xterm.css"), "media/xterm.css");
if (watch) console.log("(watch mode is not implemented; re-run npm run build)");
