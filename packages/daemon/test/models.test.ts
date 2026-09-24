import { describe, expect, it } from "vitest";
import { findConfig, loadModelsConfig } from "../src/config/models.js";

describe("models config", () => {
  it("loads and validates the repo's kira.models.json", () => {
    const cfg = loadModelsConfig(findConfig(__dirname));
    expect(cfg.roles.executor?.length).toBeGreaterThan(0);
    expect(cfg.providers.mistral?.baseURL).toMatch(/^https:\/\//);
  });
});
