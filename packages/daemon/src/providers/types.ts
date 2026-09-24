import type { ProviderId } from "../config/models.js";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as produced by the model. May be malformed; validate before use. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; finishReason: string | null; usage?: Usage };

export interface ModelProvider {
  readonly id: ProviderId;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
  embed(texts: string[], model: string, signal: AbortSignal): Promise<number[][]>;
  listModels(signal: AbortSignal): Promise<string[]>;
}
