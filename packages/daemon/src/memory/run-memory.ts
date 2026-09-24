import { join } from "node:path";
import type { ChatFn } from "../agent/loop.js";
import type { RunReport } from "../control/events.js";
import type { RunMemory } from "../control/runner.js";
import type { ModelsConfig } from "../config/models.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { HashEmbedder, ProviderEmbedder, type Embedder } from "./embed.js";
import { commandSignature, extractAdrs, filesWritten, learnLessons } from "./extract.js";
import { NimReranker, type Reranker } from "./rerank.js";
import { MemoryStore, type MemoryItem } from "./store.js";

export function memoryFile(workspace: string): string {
  return join(workspace, ".kira", "memory.db");
}

export interface KiraMemoryOptions {
  textEmbedder?: Embedder;
  codeEmbedder?: Embedder;
  reranker?: Reranker;
  /** Utility-model chat for ADR extraction and "where did we leave off" narration. */
  utility?: ChatFn;
  now?: () => Date;
  contextTokens?: number;
}

/** Project memory wired into a run: context in, episode/lessons/ADRs out. */
export class KiraMemory implements RunMemory {
  readonly store: MemoryStore;
  private readonly utility: ChatFn | undefined;

  constructor(file: string, opts: KiraMemoryOptions = {}) {
    this.store = new MemoryStore(file, {
      textEmbedder: opts.textEmbedder ?? new HashEmbedder(),
      codeEmbedder: opts.codeEmbedder,
      reranker: opts.reranker,
      now: opts.now,
      contextTokens: opts.contextTokens,
    });
    this.utility = opts.utility;
  }

  close(): void {
    this.store.close();
  }

  async contextFor(goal: string, signal: AbortSignal) {
    const { text, items } = await this.store.contextFor(goal, { signal });
    return { text, items: items.map((i) => ({ id: i.id, kind: i.kind, title: i.title })) };
  }

  hooks() {
    return {
      // Procedural memory is matched on the call's signature before the model sees the result.
      toolNote: (tool: string, args: unknown): string | undefined => {
        if (tool !== "run_command" && tool !== "start_background") return undefined;
        const command = (args as { command?: unknown }).command;
        if (typeof command !== "string") return undefined;
        const lessons = this.store.lessonsFor(commandSignature(command));
        return lessons.length ? lessons.map((l) => l.body).join(" ") : undefined;
      },
    };
  }

  async recordRun(report: RunReport, transcript: readonly ChatMessage[], signal: AbortSignal): Promise<void> {
    const files = filesWritten(transcript);
    const errors = transcript
      .filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool" && /^(exit code [1-9-]|TIMED OUT|WAITING FOR INPUT|Error|Invalid)/.test(m.content))
      .map((m) => m.content.split("\n")[0]!.slice(0, 120))
      .slice(0, 5);
    await this.store.add(
      {
        kind: "episode",
        title: report.goal.slice(0, 200),
        body: [
          `Outcome: ${report.status}. ${report.summary.slice(0, 1_500)}`,
          files.length ? `Files: ${files.slice(0, 30).join(", ")}` : "",
          errors.length ? `Errors met: ${errors.join(" | ")}` : "",
          report.openQuestions.length ? `Open: ${report.openQuestions.join(" | ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        files,
        runId: report.runId,
        meta: {
          status: report.status,
          summary: report.summary.slice(0, 2_000),
          steps: report.steps,
          costUsd: report.budget.costUsd,
          models: report.models,
          openQuestions: report.openQuestions,
        },
      },
      signal,
    );

    for (const l of learnLessons(transcript)) {
      await this.store.add(
        {
          kind: "lesson",
          title: `${l.signature}: use \`${l.ok}\``,
          body: `On this machine \`${l.failed}\` failed (${l.error}); \`${l.ok}\` worked instead.`,
          signature: l.signature,
          runId: report.runId,
          meta: { failed: l.failed, ok: l.ok },
        },
        signal,
      );
    }

    for (const adr of await extractAdrs(report, transcript, this.utility, signal)) await this.store.addAdr(adr, signal);
  }

  /** "Where did we leave off?", narrated by the utility model when there is one. */
  async leftOff(signal: AbortSignal): Promise<{ text: string; items: MemoryItem[] }> {
    const base = this.store.leftOff();
    const items = [...(base.lastEpisode ? [base.lastEpisode] : []), ...base.recentDecisions];
    if (!this.utility || !base.lastEpisode) return { text: base.text, items };
    try {
      let text = "";
      for await (const ev of this.utility(
        {
          messages: [
            {
              role: "system",
              content:
                "You are Kira, a coding agent, answering 'where did we leave off?' out loud. Three or four short sentences. " +
                "Only use the facts given. Mention what is done, what is half done, and any question waiting on the human.",
            },
            { role: "user", content: base.text },
          ],
          temperature: 0.3,
        },
        signal,
      )) {
        if (ev.type === "text") text += ev.delta;
      }
      return { text: text.trim() || base.text, items };
    } catch (err) {
      if (signal.aborted) throw err;
      return { text: base.text, items };
    }
  }
}

/**
 * Opens workspace memory with the best available models: Codestral/Mistral
 * embeddings and the NIM reranker when their keys are set, the offline hash
 * embedder otherwise. Items missing a vector for the current model are
 * re-embedded on open.
 */
export async function openMemory(
  workspace: string,
  registry?: ProviderRegistry,
  config?: ModelsConfig,
  opts: Pick<KiraMemoryOptions, "now" | "contextTokens"> = {},
): Promise<KiraMemory> {
  const m = config?.memory;
  const usable = (ref: { provider: "mistral" | "nim" } | undefined) => !!ref && !!registry?.get(ref.provider);
  const textEmbedder = registry && usable(m?.textEmbed) ? new ProviderEmbedder(registry, m!.textEmbed!) : new HashEmbedder();
  const codeEmbedder = registry && usable(m?.codeEmbed) ? new ProviderEmbedder(registry, m!.codeEmbed!) : undefined;
  const rerankKey = m?.rerank && config ? process.env[config.providers[m.rerank.provider]?.apiKeyEnv ?? ""]?.trim() : undefined;
  const reranker = m?.rerank && rerankKey ? new NimReranker(m.rerank.model, m.rerank.url, rerankKey) : undefined;
  const utility: ChatFn | undefined =
    registry && registry.chain("utility").length ? (req, signal, onFallback) => registry.chat("utility", req, signal, onFallback) : undefined;

  const memory = new KiraMemory(memoryFile(workspace), { textEmbedder, codeEmbedder, reranker, utility, ...opts });
  await memory.store.reembedMissing().catch(() => undefined);
  return memory;
}
