import type { ModelRef, ModelsConfig, ProviderId, Role } from "../config/models.js";
import { isAbortError } from "../util/abort.js";
import { ProviderUnavailableError, RateLimitedError } from "./errors.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ChatEvent, ChatRequest, ModelProvider } from "./types.js";

/** A provider event, plus a leading "model" event naming who is answering. */
export type RoleChatEvent = ChatEvent | { type: "model"; model: ModelRef };

export interface FallbackEvent {
  role: Role;
  from: ModelRef;
  reason: string;
}

/** Holds one provider per configured key and resolves roles to fallback chains. */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ModelProvider>();

  constructor(
    readonly config: ModelsConfig,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const [id, pc] of Object.entries(config.providers) as [ProviderId, NonNullable<ModelsConfig["providers"][ProviderId]>][]) {
      const key = env[pc.apiKeyEnv]?.trim();
      if (key) this.providers.set(id, new OpenAICompatibleProvider(id, pc, key));
    }
  }

  get(id: ProviderId): ModelProvider | undefined {
    return this.providers.get(id);
  }

  /** The role's chain, minus models whose provider has no API key. */
  chain(role: Role): ModelRef[] {
    return (this.config.roles[role] ?? []).filter((r) => this.providers.has(r.provider));
  }

  /**
   * Streams a chat for `role`, moving down the fallback chain when a model is
   * throttled or unavailable. Fallback only happens before the first event is
   * yielded: once output has started, a failure is surfaced to the caller so a
   * half-streamed turn is never silently mixed with another model's output.
   */
  chat(
    role: Role,
    req: Omit<ChatRequest, "model">,
    signal: AbortSignal,
    onFallback?: (e: FallbackEvent) => void,
  ): AsyncIterable<RoleChatEvent> {
    return this.chatWith(role, this.chain(role), req, signal, onFallback);
  }

  /** Like chat, over an explicit chain (the critic reorders its chain to put the other model family first). */
  async *chatWith(
    role: Role,
    chain: ModelRef[],
    req: Omit<ChatRequest, "model">,
    signal: AbortSignal,
    onFallback?: (e: FallbackEvent) => void,
  ): AsyncIterable<RoleChatEvent> {
    chain = chain.filter((r) => this.providers.has(r.provider));
    if (chain.length === 0) throw new Error(`No usable model for role "${role}". Set an API key for one of its providers.`);
    let lastErr: unknown;
    for (const ref of chain) {
      const provider = this.providers.get(ref.provider)!;
      let started = false;
      try {
        for await (const ev of provider.chat({ ...req, model: ref.model }, signal)) {
          if (!started) {
            started = true;
            yield { type: "model", model: ref };
          }
          yield ev;
        }
        return;
      } catch (err) {
        if (isAbortError(err) || started) throw err;
        if (err instanceof RateLimitedError || err instanceof ProviderUnavailableError) {
          lastErr = err;
          onFallback?.({ role, from: ref, reason: err.message });
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}
