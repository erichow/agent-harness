/**
 * StreamEvent — 流式事件的规范化类型（第 5 章）
 *
 * 不同 provider 流式形状不同：
 *   Anthropic → content_block_* 系列
 *   OpenAI    → response.output_*.delta
 *
 * 这 5 种 StreamEvent 把两边统一成一个内部事件流，
 * 让 loop 不再操心是谁喂的。
 */

import type { ToolCallRef } from "./base.js";

/* ─── 事件类型 ───────────────────────────────────────────────────── */

export interface TextDelta {
  readonly kind: "text_delta";
  readonly text: string;
}

export interface ReasoningDelta {
  readonly kind: "reasoning_delta";
  readonly text: string;
}

export interface ToolCallStart {
  readonly kind: "tool_call_start";
  readonly id: string;
  readonly name: string;
}

export interface ToolCallDelta {
  readonly kind: "tool_call_delta";
  readonly id: string;
  readonly argsFragment: string;
}

export interface Completed {
  readonly kind: "completed";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly reasoningMetadata?: Record<string, unknown>;
}

/** StreamEvent 的联合类型 — loop 只需要 switch on kind */
export type StreamEvent =
  | TextDelta
  | ReasoningDelta
  | ToolCallStart
  | ToolCallDelta
  | Completed;

/* ─── 事件工厂 ────────────────────────────────────────────────────── */

export function textDelta(text: string): TextDelta {
  return { kind: "text_delta", text };
}

export function reasoningDelta(text: string): ReasoningDelta {
  return { kind: "reasoning_delta", text };
}

export function toolCallStart(id: string, name: string): ToolCallStart {
  return { kind: "tool_call_start", id, name };
}

export function toolCallDelta(id: string, argsFragment: string): ToolCallDelta {
  return { kind: "tool_call_delta", id, argsFragment };
}

export function completed(
  inputTokens: number,
  outputTokens: number,
  reasoningTokens = 0,
  reasoningMetadata: Record<string, unknown> = {},
): Completed {
  return {
    kind: "completed",
    inputTokens,
    outputTokens,
    reasoningTokens,
    reasoningMetadata,
  };
}

/* ─── type guards ────────────────────────────────────────────────── */

export function isTextDelta(e: StreamEvent): e is TextDelta {
  return e.kind === "text_delta";
}
export function isReasoningDelta(e: StreamEvent): e is ReasoningDelta {
  return e.kind === "reasoning_delta";
}
export function isToolCallStart(e: StreamEvent): e is ToolCallStart {
  return e.kind === "tool_call_start";
}
export function isToolCallDelta(e: StreamEvent): e is ToolCallDelta {
  return e.kind === "tool_call_delta";
}
export function isCompleted(e: StreamEvent): e is Completed {
  return e.kind === "completed";
}
