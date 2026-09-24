import { z } from "zod";
import { defineTool } from "./types.js";

export const updatePlanTool = defineTool({
  name: "update_plan",
  effect: "read",
  description:
    "Record your plan as a short list of steps and keep each step's status current. Call it at the start, " +
    "and again whenever a step starts, finishes or is dropped. The human follows your progress through it.",
  schema: z.object({
    steps: z
      .array(
        z.object({
          title: z.string().min(1).describe("One short line"),
          status: z.enum(["pending", "active", "done", "skipped", "failed"]),
        }),
      )
      .min(1)
      .max(30),
  }),
  async run({ steps }, ctx) {
    if (!ctx.plan) return { content: "Plan noted." };
    ctx.plan.set(steps);
    const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    return { content: `Plan updated: ${done}/${steps.length} steps complete.` };
  },
});
