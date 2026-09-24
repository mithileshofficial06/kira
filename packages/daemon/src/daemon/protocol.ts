/**
 * JSON-RPC protocol between the VS Code extension and the Kira daemon
 * (spec §7). Types only: the extension and the webview import this file.
 */
import type { KiraEvent } from "../control/events.js";
import type { DeckState } from "./deck.js";

export const PROTOCOL_VERSION = 1;

export interface HelloParams {
  token: string;
  client: string;
}
export interface HelloResult {
  version: number;
  workspace: string;
  pid: number;
  deck: DeckState;
}

export interface StartParams {
  goal: string;
  autonomy?: number;
  plan?: boolean;
  verify?: boolean;
  maxSteps?: number;
  maxCostUsd?: number;
}
export interface StartResult {
  runId: string;
}

export interface ApproveParams {
  id: string;
  allow: boolean;
  note?: string;
}

export interface MemoryListParams {
  kind?: "episode" | "adr" | "fact" | "lesson" | "preference";
  review?: "none" | "pending" | "kept";
  limit?: number;
}
export interface MemoryItemView {
  id: number;
  kind: string;
  title: string;
  body: string;
  review: string;
  createdAt: string;
  adrId?: string;
}

export interface RememberParams {
  kind: "preference" | "fact";
  text: string;
}

/** Every notification carries a sequence number so a reconnecting client can tell what it missed. */
export interface EventNotification {
  seq: number;
  event: KiraEvent;
}

export const Methods = {
  hello: "kira/hello",
  start: "run/start",
  stop: "run/stop",
  approve: "run/approve",
  snapshot: "deck/snapshot",
  leftOff: "memory/leftOff",
  memoryList: "memory/list",
  memoryReject: "memory/reject",
  memoryKeep: "memory/keep",
  remember: "memory/remember",
  shutdown: "kira/shutdown",
  /** Notification, daemon -> client. */
  event: "kira/event",
} as const;
