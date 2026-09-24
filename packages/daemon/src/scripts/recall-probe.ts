/**
 * Phase 4 recall probe against the configured memory models.
 *   npm run recall-probe            (uses Codestral/Mistral embeddings and the NIM reranker when keys are set)
 *   npm run recall-probe -- --offline
 */
import { config as loadEnv } from "dotenv";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findConfig, loadModelsConfig } from "../config/models.js";
import { loadProbe, runProbe, seedProbe } from "../memory/probe.js";
import { openMemory } from "../memory/run-memory.js";
import { ProviderRegistry } from "../providers/registry.js";

const { values } = parseArgs({ options: { offline: { type: "boolean", default: false }, k: { type: "string", default: "5" } } });
const configPath = findConfig();
loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });
const config = loadModelsConfig(configPath);
const registry = values.offline ? undefined : new ProviderRegistry(config);

const ws = await mkdtemp(join(tmpdir(), "kira-probe-"));
let t = new Date();
const mem = await openMemory(ws, registry, config, { now: () => t });
try {
  const fixture = loadProbe(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "recall-probe.json"));
  const ids = await seedProbe(mem.store, fixture, { set: (d) => (t = d) }, new Date());
  const embed = (mem.store as unknown as { opts: { textEmbedder: { model: string }; reranker?: { model: string } } }).opts;
  console.log(`embedder: ${embed.textEmbedder.model} · reranker: ${embed.reranker?.model ?? "none"}`);
  for (const k of [1, 3, Number(values.k)]) {
    const r = await runProbe(mem.store, fixture, ids, k);
    console.log(`hit@${k}: ${r.hits}/${r.total} (${Math.round(r.score * 100)}%)`);
    if (k === Number(values.k)) for (const m of r.misses) console.log(`  miss: "${m.q}" expected ${m.expect}, got ${m.got.join(", ")}`);
  }
  if (mem.store.lastRerankError) console.log(`reranker degraded: ${mem.store.lastRerankError}`);
} finally {
  mem.close();
  await rm(ws, { recursive: true, force: true });
}
