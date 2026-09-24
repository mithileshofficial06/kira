import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { ProviderConfig, ProviderId } from "../config/models.js";
import { AbortedError, isAbortError } from "../util/abort.js";
import { classifyProviderError, RateLimitedError } from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import { toMistralToolCallId, ToolCallAccumulator } from "./tool-calls.js";
import type { ChatEvent, ChatMessage, ChatRequest, ModelProvider, ToolSpec } from "./types.js";

/** Differences between providers that sit behind the same OpenAI-shaped API. */
interface Quirks {
  /** Rewrites tool-call IDs into the form this provider accepts. */
  toolCallId: (id: string) => string;
  /** Whether to send stream_options.include_usage (Mistral sends usage without it). */
  streamUsageOption: boolean;
}

const QUIRKS: Record<ProviderId, Quirks> = {
  mistral: { toolCallId: toMistralToolCallId, streamUsageOption: false },
  nim: { toolCallId: (id) => id, streamUsageOption: true },
};

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15_000;

/** One adapter for both Mistral and NVIDIA NIM: they differ only in base URL, key and quirks. */
export class OpenAICompatibleProvider implements ModelProvider {
  private readonly client: OpenAI;
  private readonly quirks: Quirks;
  readonly limiter: RateLimiter;

  constructor(
    readonly id: ProviderId,
    config: ProviderConfig,
    apiKey: string,
  ) {
    this.client = new OpenAI({ baseURL: config.baseURL, apiKey, maxRetries: 0, timeout: 120_000 });
    this.quirks = QUIRKS[id];
    this.limiter = new RateLimiter(config.requestsPerMinute);
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    await this.limiter.acquire(signal);
    let stream;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: req.messages.map((m) => this.toWire(m)),
          tools: req.tools?.map(toWireTool),
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          stream: true,
          ...(this.quirks.streamUsageOption ? { stream_options: { include_usage: true } } : {}),
        },
        { signal },
      );
    } catch (err) {
      throw this.wrap(err, signal);
    }

    const calls = new ToolCallAccumulator();
    let finishReason: string | null = null;
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta?.content) yield { type: "text", delta: choice.delta.content };
        for (const tc of choice.delta?.tool_calls ?? []) calls.push(tc);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      throw this.wrap(err, signal);
    }
    // The SDK ends an aborted stream quietly. A cut-off turn must never look like a finished one.
    if (signal.aborted) throw new AbortedError(signal.reason);
    for (const call of calls.finish()) yield { type: "tool_call", call };
    yield { type: "done", finishReason, usage };
  }

  async embed(texts: string[], model: string, signal: AbortSignal): Promise<number[][]> {
    await this.limiter.acquire(signal);
    try {
      const res = await this.client.embeddings.create({ model, input: texts, encoding_format: "float" }, { signal });
      return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[]);
    } catch (err) {
      throw this.wrap(err, signal);
    }
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    await this.limiter.acquire(signal);
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list({ signal })) ids.push(m.id);
      return ids;
    } catch (err) {
      throw this.wrap(err, signal);
    }
  }

  private wrap(err: unknown, signal: AbortSignal): unknown {
    if (signal.aborted || isAbortError(err)) return new AbortedError(signal.reason);
    const classified = classifyProviderError(this.id, err);
    if (classified instanceof RateLimitedError) {
      this.limiter.pauseFor(classified.retryAfterMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS);
    }
    return classified;
  }

  private toWire(m: ChatMessage): ChatCompletionMessageParam {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: this.quirks.toolCallId(c.id),
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        };
      case "tool":
        return { role: "tool", tool_call_id: this.quirks.toolCallId(m.toolCallId), content: m.content };
    }
  }
}

function toWireTool(t: ToolSpec): ChatCompletionTool {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}
