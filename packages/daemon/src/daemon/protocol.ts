/**
 * JSON-RPC protocol between the VS Code extension and the Kira daemon
 * (spec §7). Types only: the extension and the webview import this file.
 */
import type { KiraEvent } from "../control/events.js";
import type { DeckState } from "./deck.js";
import type { VoiceUiEvent } from "../voice/bridge.js";

export type { VoiceUiEvent };

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

export interface VoiceStatus {
  running: boolean;
  input?: string;
  output?: string;
  wake?: string;
  voice?: string;
  /** Median end-of-speech to first audible word, ms (spec: ≤2000). */
  ackP50Ms?: number;
  samples: number;
  error?: string;
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
  voiceStart: "voice/start",
  voiceStop: "voice/stop",
  voiceStatus: "voice/status",
  /** A typed message to Kira: answered like speech while voice is on, else started as a run. */
  voiceAsk: "voice/ask",
  shutdown: "kira/shutdown",
  /** Notification, daemon -> client. */
  event: "kira/event",
  /** Notification, daemon -> client: live voice activity (VoiceUiEvent), for the assistant view. */
  voiceEvent: "kira/voice",
} as const;
