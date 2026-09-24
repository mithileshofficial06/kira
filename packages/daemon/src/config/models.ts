import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";

export const ProviderId = z.enum(["mistral", "nim"]);
export type ProviderId = z.infer<typeof ProviderId>;

export const Role = z.enum(["planner", "executor", "critic", "utility"]);
export type Role = z.infer<typeof Role>;

const ProviderConfig = z.object({
  baseURL: z.string().url(),
  apiKeyEnv: z.string().min(1),
  requestsPerMinute: z.number().int().positive(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

const ModelRef = z.object({
  provider: ProviderId,
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRef>;

export const ModelsConfig = z.object({
  providers: z.record(ProviderId, ProviderConfig),
  roles: z.record(Role, z.array(ModelRef).min(1)),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;

export const CONFIG_FILE = "kira.models.json";

/** Walks up from `start` until it finds kira.models.json. */
export function findConfig(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${CONFIG_FILE} not found above ${start}`);
    dir = parent;
  }
}

export function loadModelsConfig(path: string = findConfig()): ModelsConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = ModelsConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${path}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  for (const [role, refs] of Object.entries(parsed.data.roles)) {
    for (const ref of refs) {
      if (!parsed.data.providers[ref.provider]) {
        throw new Error(`Role "${role}" uses provider "${ref.provider}", which is not configured`);
      }
    }
  }
  return parsed.data;
}
