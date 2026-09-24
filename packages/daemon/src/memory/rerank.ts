import { classifyProviderError } from "../providers/errors.js";

/** Reorders candidate passages by relevance to a query. Returns candidate indexes, best first. */
export interface Reranker {
  readonly model: string;
  rerank(query: string, passages: string[], signal: AbortSignal): Promise<number[]>;
}

/**
 * NVIDIA NeMo Retriever reranking (NIM hosted). Its API is not the OpenAI
 * shape: POST {model, query: {text}, passages: [{text}]} -> {rankings: [{index, logit}]}.
 */
export class NimReranker implements Reranker {
  constructor(
    readonly model: string,
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  async rerank(query: string, passages: string[], signal: AbortSignal): Promise<number[]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        query: { text: query },
        passages: passages.map((text) => ({ text: text.slice(0, 2_000) })),
        truncate: "END",
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok) {
      throw classifyProviderError("nim", { status: res.status, headers: res.headers, message: `rerank HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` });
    }
    const json = (await res.json()) as { rankings?: { index: number; logit: number }[] };
    if (!Array.isArray(json.rankings)) throw new Error("rerank reply has no rankings");
    return json.rankings.sort((a, b) => b.logit - a.logit).map((r) => r.index);
  }
}
