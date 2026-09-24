/**
 * The window's end of the terminal link (see daemon/src/daemon/vscode-hook.ts):
 * `npm run kira` in this window's terminal announces its daemon here, and the
 * extension attaches to it and opens the assistant.
 */
import { createServer, type Server } from "node:net";
import * as vscode from "vscode";
import { advertiseHook, HOOK_ENV, newHookPipe, type AttachRequest } from "../../daemon/src/daemon/vscode-hook.js";

export function startHook(ctx: vscode.ExtensionContext, output: vscode.OutputChannel, onAttach: (req: AttachRequest) => Promise<void>): void {
  const pipe = newHookPipe();
  const server: Server = createServer((sock) => {
    let buf = "";
    sock.on("error", () => sock.destroy());
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.length > 16_384) return void sock.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let req: AttachRequest;
      try {
        req = JSON.parse(buf.slice(0, nl)) as AttachRequest;
      } catch {
        return void sock.end('{"ok":false,"error":"bad request"}\n');
      }
      if (req.type !== "attach" || typeof req.pipe !== "string" || typeof req.token !== "string") return void sock.end('{"ok":false,"error":"bad request"}\n');
      onAttach(req).then(
        () => sock.end('{"ok":true}\n'),
        (err: unknown) => {
          output.appendLine(`[kira] could not attach to the terminal's daemon: ${(err as Error).message}`);
          sock.end(`${JSON.stringify({ ok: false, error: (err as Error).message })}\n`);
        },
      );
    });
  });
  server.on("error", (err) => output.appendLine(`[kira] terminal link unavailable: ${err.message}`));
  server.listen(pipe, () => {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const unadvertise = advertiseHook({ pipe, pid: process.pid, folders });
    // Terminals opened from now on know this window exactly.
    ctx.environmentVariableCollection.persistent = false;
    ctx.environmentVariableCollection.replace(HOOK_ENV, pipe);
    ctx.environmentVariableCollection.description = "Lets `npm run kira` show Kira's assistant in this window.";
    ctx.subscriptions.push({ dispose: unadvertise });
  });
  ctx.subscriptions.push({ dispose: () => server.close() });
}
