import {
  backgroundOutputTool,
  finishTool,
  httpGetTool,
  runCommandTool,
  startBackgroundTool,
  stopBackgroundTool,
} from "./command-tools.js";
import { listDirTool, readFileTool, writeFileTool } from "./fs-tools.js";
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

export { BackgroundManager } from "./background.js";
export { Gate, type Approver, type GateRequest } from "./gate.js";
export { toToolSpec, type Tool, type ToolContext, type ToolResult } from "./types.js";
