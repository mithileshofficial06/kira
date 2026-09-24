/**
 * A local OpenAI-compatible chat server for tests. It streams real SSE, so the
 * production adapter, limiter and fallback chain run unmodified against it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTurn {
  text?: string;
  calls?: { name: string; args: unknown }[];
}

export type FakeResponse =
  | { kind: "turn"; turn: FakeTurn }
  | { kind: "status"; status: number; headers?: Record<string, string>; body?: string }
  /** Sends some text, then kills the socket mid-stream. */
  | { kind: "drop"; text: string };

export interface FakeRequest {
  n: number;
  model: string;
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[];
  hasTools: boolean;
}

export interface FakeServer {
  baseURL: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export async function startFakeOpenAI(handler: (req: FakeRequest) => FakeResponse): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  let n = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const json = JSON.parse(body) as { model: string; messages: FakeRequest["messages"]; tools?: unknown[] };
    const fr: FakeRequest = { n: ++n, model: json.model, messages: json.messages, hasTools: !!json.tools?.length };
    requests.push(fr);
    const out = handler(fr);
    if (out.kind === "status") {
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
      res.end(out.body ?? JSON.stringify({ error: { message: `fake status ${out.status}` } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta: unknown, finish: string | null = null) =>
      send({ id: "c", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    if (out.kind === "drop") {
      chunk({ role: "assistant", content: out.text });
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    const t = out.turn;
    chunk({ role: "assistant", content: t.text ?? "" });
    (t.calls ?? []).forEach((c, index) => {
      const args = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
      chunk({ tool_calls: [{ index, id: `call${fr.n}x${index}`, type: "function", function: { name: c.name, arguments: "" } }] });
      // Arguments in two fragments, as real providers stream them.
      const mid = Math.floor(args.length / 2);
      chunk({ tool_calls: [{ index, function: { arguments: args.slice(0, mid) } }] });
      chunk({ tool_calls: [{ index, function: { arguments: args.slice(mid) } }] });
    });
    chunk({}, t.calls?.length ? "tool_calls" : "stop");
    send({ id: "c", object: "chat.completion.chunk", created: 0, model: json.model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d: string) => (s += d));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

/** How many tool results the request carries: a stable "which step is this" for scripted servers. */
export function toolResultCount(req: FakeRequest): number {
  return req.messages.filter((m) => m.role === "tool").length;
}
