/**
 * Verifies every model in kira.models.json:
 *   1. the ID appears in the provider's model list
 *   2. a single tool-calling request round-trips
 * Run: npm run check-models   (reads keys from the repo-root .env)
 */
import { config as loadEnv } from "dotenv";
import { dirname, join } from "node:path";
import { findConfig, loadModelsConfig, type ModelRef, type Role } from "../config/models.js";
import { ProviderRegistry } from "../providers/registry.js";
import type { ToolSpec } from "../providers/types.js";

const configPath = findConfig();
loadEnv({ path: join(dirname(configPath), ".env"), quiet: true });
const config = loadModelsConfig(configPath);
const registry = new ProviderRegistry(config);

const PING_TOOL: ToolSpec = {
  name: "report_status",
  description: "Report that you are working.",
  parameters: {
    type: "object",
    properties: { status: { type: "string", enum: ["ok"] } },
    required: ["status"],
  },
};

const missingKeys = Object.entries(config.providers)
  .filter(([id]) => !registry.get(id as ModelRef["provider"]))
  .map(([id, pc]) => `${id} (${pc.apiKeyEnv})`);
if (missingKeys.length) console.warn(`No API key for: ${missingKeys.join(", ")}. Those models are skipped.\n`);

const unique = new Map<string, { ref: ModelRef; roles: Role[] }>();
for (const [role, refs] of Object.entries(config.roles) as [Role, ModelRef[]][]) {
  for (const ref of refs) {
    const key = `${ref.provider}:${ref.model}`;
    const entry = unique.get(key) ?? { ref, roles: [] };
    entry.roles.push(role);
    unique.set(key, entry);
  }
}

const catalogs = new Map<string, Set<string> | Error>();
const signal = AbortSignal.timeout(180_000);
for (const id of Object.keys(config.providers)) {
  const p = registry.get(id as ModelRef["provider"]);
  if (!p) continue;
  try {
    catalogs.set(id, new Set(await p.listModels(signal)));
  } catch (err) {
    catalogs.set(id, err as Error);
  }
}

let failures = 0;
let passes = 0;
for (const { ref, roles } of unique.values()) {
  const label = `${ref.provider.padEnd(8)} ${ref.model.padEnd(42)} [${roles.join(", ")}]`;
  const provider = registry.get(ref.provider);
  if (!provider) {
    console.log(`SKIP  ${label}  no key`);
    continue;
  }
  const catalog = catalogs.get(ref.provider);
  const listed = catalog instanceof Set ? (catalog.has(ref.model) ? "listed" : "NOT LISTED") : "list failed";

  const started = Date.now();
  try {
    let calledTool = false;
    for await (const ev of provider.chat(
      {
        model: ref.model,
        messages: [{ role: "user", content: "Call report_status with status ok. Do not reply with text." }],
        tools: [PING_TOOL],
        maxTokens: 64,
        temperature: 0,
      },
      signal,
    )) {
      if (ev.type === "tool_call" && ev.call.name === PING_TOOL.name) calledTool = true;
    }
    const ms = Date.now() - started;
    const ok = calledTool;
    if (ok) passes++;
    else failures++;
    console.log(`${ok ? "PASS" : "WARN"}  ${label}  ${listed}, ${ok ? "tool call ok" : "answered without calling the tool"}, ${ms}ms`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${label}  ${listed}, ${(err as Error).name}: ${(err as Error).message.split("\n")[0]}`);
  }
}

if (passes > 0 && failures === 0) console.log(`\nAll ${passes} checked models passed.`);
if (passes + failures === 0) console.log("\nNothing checked. Copy .env.example to .env and add your keys.");
process.exitCode = failures ? 1 : 0;
