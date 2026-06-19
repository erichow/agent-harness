/**
 * agent-harness — 构建 AI Agent Harness (JavaScript 版)
 *
 * 从 Python 教程《构建 AI Agent Harness · 可视化学习教程》改编而来。
 * 逐章将 Python 实现转写为 TypeScript。
 *
 * 第 5 章新增导出：
 *   - arun() — async agent 循环
 *   - ToolCallRef — 批量工具调用引用
 *   - accumulate() — 事件流 → ProviderResponse
 *   - StreamEvent 系列 — 5 种流式事件类型
 *
 * 第 6 章新增导出：
 *   - jsonQueryDefinition / jsonQueryHandler — JSON 查询工具
 *   - ValidationError — 结构化校验错误类型
 *
 * 第 7 章新增导出：
 *   - ContextAccountant / ContextBudget / ContextSnapshot — 上下文窗口记账
 *   - OnSnapshot — snapshot 回调类型
 *   - Component / ContextState — 组件和状态类型
 */

export const VERSION = "0.1.0";

export { run, arun, MAX_ITERATIONS } from "./agent.js";
export type { OnEvent, OnSnapshot } from "./agent.js";

export { ContextAccountant, ContextBudget, ContextSnapshot } from "./context/accountant.js";
export type { Component, ContextState } from "./context/accountant.js";

export { ToolRegistry, jsonQueryDefinition, jsonQueryHandler } from "./tools/registry.js";
export type { ToolDefinition, ToolHandler } from "./tools/registry.js";
export { ValidationError } from "./tools/validation.js";

export { ProviderResponse, ToolCallRef, accumulate } from "./providers/base.js";
export type { Provider } from "./providers/base.js";
export { MockProvider } from "./providers/mock.js";
export { FallbackProvider } from "./providers/fallback.js";
export { withRetry, isRetryable, backoffDelay } from "./providers/retry.js";

export {
  Message,
  Transcript,
  textBlock,
  toolCallBlock,
  toolResultBlock,
  reasoningBlock,
} from "./messages.js";
export type {
  Block,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
  ReasoningBlock,
  Role,
} from "./messages.js";

/* ─── 第 5 章：StreamEvent 类型 ──────────────────────────────────── */

export {
  textDelta,
  reasoningDelta,
  toolCallStart,
  toolCallDelta,
  completed,
} from "./providers/events.js";
export type {
  StreamEvent,
  TextDelta,
  ReasoningDelta,
  ToolCallStart,
  ToolCallDelta,
  Completed,
} from "./providers/events.js";