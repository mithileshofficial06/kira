import {
  backgroundOutputTool,
  finishTool,
  httpGetTool,
  runCommandTool,
  startBackgroundTool,
  stopBackgroundTool,
} from "./command-tools.js";
import { listDirTool, readFileTool, writeFileTool } from "./fs-tools.js";
import { updatePlanTool } from "./plan-tool.js";
import type { Tool } from "./types.js";

export const PHASE0_TOOLS: Tool[] = [
  listDirTool,
  readFileTool,
  writeFileTool,
  runCommandTool,
  startBackgroundTool,
  backgroundOutputTool,
  stopBackgroundTool,
  httpGetTool,
  finishTool,
] as Tool[];

/** The full executor tool set: Phase 0 tools plus the plan the Flight Deck shows. */
export const EXECUTOR_TOOLS: Tool[] = [updatePlanTool as Tool, ...PHASE0_TOOLS];

export { BackgroundManager } from "./background.js";
export {
  Gate,
  inScope,
  type ApprovalAnswer,
  type Approver,
  type GateCategory,
  type GateDecisionRecord,
  type GateRequest,
  type ToolEffect,
} from "./gate.js";
export { toToolSpec, type Tool, type ToolContext, type ToolResult } from "./types.js";
