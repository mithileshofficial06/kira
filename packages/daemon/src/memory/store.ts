/**
 * Project memory (spec §9.3): four stores in one table.
 *
 *   episodic    what each session tried and how it ended     recency + semantic
 *   semantic    ADRs and project facts                        hybrid FTS + vector -> rerank -> file triggers
 *   procedural  "on this machine, X fails; do Y"              matched on a tool call's signature
 *   preference  style, libraries, conventions                 always in the system prompt
 */
import type { DatabaseSync } from "node:sqlite";
import { isAbortError } from "../util/abort.js";
import { fromBlob, openDb, toBlob } from "./db.js";
import { cosine, type Embedder } from "./embed.js";
import type { Reranker } from "./rerank.js";

export type MemoryStoreName = "episodic" | "semantic" | "procedural" | "preference";
export type MemoryKind = "episode" | "adr" | "fact" | "lesson" | "preference";

const STORE_OF: Record<MemoryKind, MemoryStoreName> = {
  episode: "episodic",
  adr: "semantic",
  fact: "semantic",
  lesson: "procedural",
  preference: "preference",
};

export interface MemoryItem {
  id: number;
  store: MemoryStoreName;
  kind: MemoryKind;
  title: string;
  body: string;
  files: string[];
  signature?: string;
  status: "active" | "rejected" | "superseded";
  /** "pending": shown in the Flight Deck for one-click reject (extracted ADRs, spec §4.4). */
  review: "none" | "pending" | "kept";
  source: string;
  runId?: string;
  meta: Record<string, unknown>;
  supersedes?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewItem {
  kind: MemoryKind;
  title: string;
  body: string;
  files?: string[];
  signature?: string;
  source?: string;
  runId?: string;
  meta?: Record<string, unknown>;
  review?: MemoryItem["review"];
  supersedes?: number;
}

export interface AdrInput {
  title: string;
  context: string;
  decision: string;
  alternativesRejected?: string[];
  consequences?: string[];
  decidedBy: string;
  files?: string[];
  runId?: string;
  source?: string;
  review?: MemoryItem["review"];
  supersedes?: number;
}

export interface SearchHit {
  item: MemoryItem;
  score: number;
}

export interface MemoryOptions {
  /** Embeds ADRs, facts, episodes and preferences. */
  textEmbedder: Embedder;
  /** Embeds procedural lessons (commands, code). Defaults to the text embedder. */
  codeEmbedder?: Embedder;
  reranker?: Reranker;
  now?: () => Date;
  /** Memory context budget in tokens (spec §6.4, default 3000). */
  contextTokens?: number;
}

interface Row {
  id: number;
  store: string;
  kind: string;
  title: string;
  body: string;
  files: string;
  signature: string | null;
  status: string;
  review: string;
  source: string;
  run_id: string | null;
  meta: string;
  supersedes: number | null;
  created_at: string;
  updated_at: string;
}

const RRF_K = 60;
const CHARS_PER_TOKEN = 4;

export class MemoryStore {
  readonly db: DatabaseSync;
  private readonly now: () => Date;
  /** Set when the last search could not rerank (throttled or offline): retrieval degraded to fused FTS + vector. */
  lastRerankError: string | undefined;

  constructor(
    file: string,
    private readonly opts: MemoryOptions,
  ) {
    this.db = openDb(file);
    this.now = opts.now ?? (() => new Date());
  }

  close(): void {
    this.db.close();
  }

  private embedderFor(store: MemoryStoreName): Embedder {
    return store === "procedural" ? (this.opts.codeEmbedder ?? this.opts.textEmbedder) : this.opts.textEmbedder;
  }

  // ---- writes ------------------------------------------------------------------

  async add(n: NewItem, signal: AbortSignal = new AbortController().signal): Promise<MemoryItem> {
    const at = this.now().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO items (store, kind, title, body, files, signature, review, source, run_id, meta, supersedes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        STORE_OF[n.kind],
        n.kind,
        n.title,
        n.body,
        JSON.stringify(n.files ?? []),
        n.signature ?? null,
        n.review ?? "none",
        n.source ?? "run",
        n.runId ?? null,
        JSON.stringify(n.meta ?? {}),
        n.supersedes ?? null,
        at,
        at,
      );
    const id = Number(r.lastInsertRowid);
    if (n.supersedes) this.setStatus(n.supersedes, "superseded");
    const item = this.get(id)!;
    await this.embedItems([item], signal).catch((err) => {
      if (isAbortError(err)) throw err;
      // Embedding is best effort: reembedMissing() picks the item up later. FTS already has it.
    });
    return item;
  }

  /** An architecture decision record (spec §4.4). */
  addAdr(a: AdrInput, signal?: AbortSignal): Promise<MemoryItem> {
    const lines = [
      `Decision: ${a.decision}`,
      `Context: ${a.context}`,
      ...(a.alternativesRejected?.length ? [`Rejected: ${a.alternativesRejected.join("; ")}`] : []),
      ...(a.consequences?.length ? [`Consequences: ${a.consequences.join("; ")}`] : []),
      `Decided by: ${a.decidedBy}`,
    ];
    return this.add(
      {
        kind: "adr",
        title: a.title,
        body: lines.join("\n"),
        files: a.files,
        source: a.source ?? "extracted",
        runId: a.runId,
        review: a.review,
        supersedes: a.supersedes,
        meta: {
          adr: {
            decision: a.decision,
            context: a.context,
            alternativesRejected: a.alternativesRejected ?? [],
            consequences: a.consequences ?? [],
            decidedBy: a.decidedBy,
          },
        },
      },
      signal,
    );
  }

  setStatus(id: number, status: MemoryItem["status"]): void {
    this.db.prepare("UPDATE items SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now().toISOString(), id);
  }

  /** One-click reject from the Flight Deck. */
  reject(id: number): void {
    this.setStatus(id, "rejected");
    this.db.prepare("UPDATE items SET review = 'none' WHERE id = ?").run(id);
  }

  keep(id: number): void {
    this.db.prepare("UPDATE items SET review = 'kept', updated_at = ? WHERE id = ?").run(this.now().toISOString(), id);
  }

  touchMeta(id: number, patch: Record<string, unknown>): void {
    const item = this.get(id);
    if (!item) return;
    this.db.prepare("UPDATE items SET meta = ? WHERE id = ?").run(JSON.stringify({ ...item.meta, ...patch }), id);
  }

  // ---- reads -------------------------------------------------------------------

  get(id: number): MemoryItem | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return row ? toItem(row) : undefined;
  }

  list(filter: { kind?: MemoryKind; store?: MemoryStoreName; status?: MemoryItem["status"]; review?: MemoryItem["review"]; limit?: number } = {}): MemoryItem[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.kind) (where.push("kind = ?"), args.push(filter.kind));
    if (filter.store) (where.push("store = ?"), args.push(filter.store));
    where.push("status = ?");
    args.push(filter.status ?? "active");
    if (filter.review) (where.push("review = ?"), args.push(filter.review));
    const rows = this.db
      .prepare(`SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args, filter.limit ?? 1000) as unknown as Row[];
    return rows.map(toItem);
  }

  /** Active lessons for a tool-call signature, most recent first. */
  lessonsFor(signature: string): MemoryItem[] {
    const rows = this.db
      .prepare("SELECT * FROM items WHERE store = 'procedural' AND status = 'active' AND signature = ? ORDER BY created_at DESC LIMIT 3")
      .all(signature) as unknown as Row[];
    return rows.map(toItem);
  }

  static adrId(item: Pick<MemoryItem, "id">): string {
    return `ADR-${String(item.id).padStart(3, "0")}`;
  }

  // ---- embeddings --------------------------------------------------------------

  private async embedItems(items: MemoryItem[], signal: AbortSignal): Promise<void> {
    const groups = new Map<Embedder, MemoryItem[]>();
    for (const it of items) {
      const e = this.embedderFor(it.store);
      groups.set(e, [...(groups.get(e) ?? []), it]);
    }
    for (const [embedder, group] of groups) {
      const vecs = await embedder.embed(group.map(embedText), signal);
      const put = this.db.prepare("INSERT OR REPLACE INTO embeddings (item_id, model, dim, vec) VALUES (?, ?, ?, ?)");
      group.forEach((it, i) => put.run(it.id, embedder.model, vecs[i]!.length, toBlob(vecs[i]!)));
    }
  }

  /**
   * Embeds every active item that has no vector from the current model, then
   * drops vectors from models no longer in use. Changing embedding models
   * re-embeds instead of mixing vector spaces.
   */
  async reembedMissing(signal: AbortSignal = new AbortController().signal): Promise<number> {
    let n = 0;
    for (const store of ["episodic", "semantic", "procedural", "preference"] as MemoryStoreName[]) {
      const model = this.embedderFor(store).model;
      const rows = this.db
        .prepare(
          `SELECT * FROM items i WHERE i.store = ? AND i.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.item_id = i.id AND e.model = ?)`,
        )
        .all(store, model) as unknown as Row[];
      if (rows.length) {
        await this.embedItems(rows.map(toItem), signal);
        n += rows.length;
      }
    }
    const models = [...new Set([this.opts.textEmbedder.model, (this.opts.codeEmbedder ?? this.opts.textEmbedder).model])];
    this.db.prepare(`DELETE FROM embeddings WHERE model NOT IN (${models.map(() => "?").join(",")})`).run(...models);
    return n;
  }

  // ---- retrieval ---------------------------------------------------------------

  /**
   * Hybrid retrieval: FTS5 (bm25) and vector search fused with reciprocal
   * rank fusion, reranked by the NIM reranker when it answers, then boosted
   * for items tied to files the task touches. A throttled reranker degrades
   * retrieval, never blocks it.
   */
  async search(
    query: string,
    opts: { limit?: number; files?: string[]; stores?: MemoryStoreName[]; signal?: AbortSignal } = {},
  ): Promise<SearchHit[]> {
    const signal = opts.signal ?? new AbortController().signal;
    const limit = opts.limit ?? 8;
    const allowed = new Set<MemoryStoreName>(opts.stores ?? ["episodic", "semantic", "procedural", "preference"]);
    const fused = new Map<number, number>();
    const addRanks = (ids: number[]) => ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));

    // Lexical.
    const match = ftsQuery(query);
    if (match) {
      const rows = this.db
        .prepare(
          `SELECT i.id FROM items_fts f JOIN items i ON i.id = f.rowid
           WHERE items_fts MATCH ? AND i.status = 'active' ORDER BY bm25(items_fts, 3.0, 1.0) LIMIT 30`,
        )
        .all(match) as { id: number }[];
      addRanks(rows.map((r) => r.id));
    }

    // Semantic, per embedding model in use.
    const embedders = [...new Set([...allowed].map((s) => this.embedderFor(s)))];
    for (const embedder of embedders) {
      let qv: Float32Array;
      try {
        [qv] = (await embedder.embed([query], signal)) as [Float32Array];
      } catch (err) {
        if (isAbortError(err)) throw err;
        continue; // embeddings down: FTS alone still answers
      }
      const rows = this.db
        .prepare(`SELECT e.item_id AS id, e.vec AS vec FROM embeddings e JOIN items i ON i.id = e.item_id WHERE e.model = ? AND i.status = 'active'`)
        .all(embedder.model) as { id: number; vec: Uint8Array }[];
      const scored = rows.map((r) => ({ id: r.id, s: cosine(qv, fromBlob(r.vec)) })).sort((a, b) => b.s - a.s);
      addRanks(scored.slice(0, 30).filter((x) => x.s > 0.05).map((x) => x.id));
    }

    let hits = [...fused.entries()]
      .map(([id, score]) => ({ item: this.get(id)!, score }))
      .filter((h) => h.item && allowed.has(h.item.store))
      .map((h) => ({ ...h, score: h.score * (h.item.kind === "adr" || h.item.kind === "fact" ? 1.1 : 1) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    let reranked = false;
    this.lastRerankError = undefined;
    if (this.opts.reranker && hits.length > 1) {
      try {
        const order = await this.opts.reranker.rerank(query, hits.map((h) => embedText(h.item)), signal);
        const top = hits[0]!.score;
        hits = order.filter((i) => hits[i]).map((i, rank) => ({ item: hits[i]!.item, score: top / (1 + rank * 0.1) }));
        reranked = true;
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.lastRerankError = (err as Error).message;
      }
    }

    // File-path triggers: memory about files this task touches ranks higher.
    if (opts.files?.length) {
      const touched = new Set(opts.files.map((f) => f.replace(/\\/g, "/")));
      hits = hits
        .map((h) => ({ ...h, score: h.score * (h.item.files.some((f) => touched.has(f)) ? 1.5 : 1) }))
        .sort((a, b) => b.score - a.score);
    }

    const out = hits.slice(0, limit);
    this.db
      .prepare("INSERT INTO retrieval_log (at, query, item_ids, reranked) VALUES (?, ?, ?, ?)")
      .run(this.now().toISOString(), query.slice(0, 1_000), JSON.stringify(out.map((h) => h.item.id)), reranked ? 1 : 0);
    return out;
  }

  /**
   * The memory section of a run's system prompt: preferences always, then
   * retrieved items in rank order, within the token budget (never dumped).
   */
  async contextFor(goal: string, opts: { files?: string[]; signal?: AbortSignal } = {}): Promise<{ text: string; items: MemoryItem[] }> {
    const budget = (this.opts.contextTokens ?? 3_000) * CHARS_PER_TOKEN;
    const lines: string[] = [];
    const items: MemoryItem[] = [];
    let used = 0;
    const push = (item: MemoryItem, line: string) => {
      if (items.some((i) => i.id === item.id) || used + line.length > budget) return;
      lines.push(line);
      items.push(item);
      used += line.length + 1;
    };

    for (const p of this.list({ kind: "preference", limit: 20 })) push(p, `- [preference] ${p.title}${p.body && p.body !== p.title ? `: ${oneLine(p.body, 300)}` : ""}`);
    const hits = await this.search(goal, { limit: 12, files: opts.files, signal: opts.signal });
    for (const h of hits) push(h.item, this.format(h.item));
    // Continuity: the most recent session is always worth a line.
    const last = this.list({ kind: "episode", limit: 1 })[0];
    if (last) push(last, this.format(last));
    return { text: lines.join("\n"), items };
  }

  format(item: MemoryItem): string {
    const day = item.createdAt.slice(0, 10);
    switch (item.kind) {
      case "adr": {
        const adr = item.meta.adr as { decidedBy?: string } | undefined;
        return `- [${MemoryStore.adrId(item)} · ${day}${adr?.decidedBy ? ` · decided by ${adr.decidedBy}` : ""}] ${item.title}. ${oneLine(item.body, 500)}`;
      }
      case "lesson":
        return `- [lesson] ${item.title}: ${oneLine(item.body, 300)}`;
      case "episode":
        return `- [session ${day} · ${String(item.meta.status ?? "?")}] ${item.title}: ${oneLine(item.body, 400)}`;
      default:
        return `- [${item.kind}] ${item.title}: ${oneLine(item.body, 400)}`;
    }
  }

  /** "Kira, where did we leave off?" */
  leftOff(): { text: string; lastEpisode?: MemoryItem; openQuestions: string[]; recentDecisions: MemoryItem[] } {
    const episodes = this.list({ kind: "episode", limit: 3 });
    const last = episodes[0];
    if (!last) return { text: "No earlier sessions in this workspace yet.", openQuestions: [], recentDecisions: [] };
    const openQuestions = (last.meta.openQuestions as string[] | undefined) ?? [];
    const since = new Date(this.now().getTime() - 14 * 86_400_000).toISOString();
    const recentDecisions = this.list({ kind: "adr", limit: 20 }).filter((a) => a.createdAt >= since).slice(0, 5);
    const ago = relativeDays(new Date(last.createdAt), this.now());
    const parts = [
      `Last session (${ago}): "${last.title}" ended ${String(last.meta.status ?? "unknown").toUpperCase()}. ${oneLine(String(last.meta.summary ?? last.body), 400)}`,
    ];
    if (openQuestions.length) parts.push(`Open: ${openQuestions.map((q) => oneLine(q, 200)).join("; ")}.`);
    if (recentDecisions.length) parts.push(`Recent decisions: ${recentDecisions.map((d) => `${MemoryStore.adrId(d)} ${d.title}`).join("; ")}.`);
    if (episodes.length > 1) {
      parts.push(`Before that: ${episodes.slice(1).map((e) => `"${e.title}" (${String(e.meta.status ?? "?")}, ${relativeDays(new Date(e.createdAt), this.now())})`).join("; ")}.`);
    }
    return { text: parts.join("\n"), lastEpisode: last, openQuestions, recentDecisions };
  }
}

function toItem(r: Row): MemoryItem {
  return {
    id: r.id,
    store: r.store as MemoryStoreName,
    kind: r.kind as MemoryKind,
    title: r.title,
    body: r.body,
    files: JSON.parse(r.files) as string[],
    ...(r.signature ? { signature: r.signature } : {}),
    status: r.status as MemoryItem["status"],
    review: r.review as MemoryItem["review"],
    source: r.source,
    ...(r.run_id ? { runId: r.run_id } : {}),
    meta: JSON.parse(r.meta) as Record<string, unknown>,
    ...(r.supersedes ? { supersedes: r.supersedes } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function embedText(it: MemoryItem): string {
  return `${it.title}\n${it.body}`.slice(0, 4_000);
}

/** Words OR-ed together, each quoted so FTS syntax in user text cannot break the query. */
function ftsQuery(q: string): string | undefined {
  const words = [...new Set((q.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter((w) => !FTS_STOP.has(w)))].slice(0, 24);
  return words.length ? words.map((w) => `"${w}"`).join(" OR ") : undefined;
}
const FTS_STOP = new Set("the and for with that this what when where which who why how did does was were are our you your can should would about from into have has".split(" "));

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function relativeDays(then: Date, now: Date): string {
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
