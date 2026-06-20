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
 *
 * 第 9 章新增导出：
 *   - Scratchpad — 持久化 KV 存储（外部状态）
 *
 * 第 10 章新增导出：
 *   - DocumentIndex — BM25 文档索引
 *   - RetrievalInterface — search_docs 检索工具
 *
 * 第 11 章新增导出：
 *   - fileViewportTool — Viewport 文件读取（ACI 原则）
 *   - editLinesTool — 行范围编辑（ACI 原则）
 *
 * 第 12 章新增导出：
 *   - ToolCatalog — 动态工具选择器
 *   - queryFromTranscript — 从对话历史提取检索 query
 *   - createDiscoveryEntry — discovery 工具工厂
 *   - CatalogEntry — 目录条目类型
 */

export const VERSION = "0.1.0";

export { run, arun, MAX_ITERATIONS } from "./agent.js";
export type { OnEvent, OnSnapshot } from "./agent.js";

export { ContextAccountant, ContextBudget, ContextSnapshot } from "./context/accountant.js";
export type { Component, ContextState } from "./context/accountant.js";
export { Compactor } from "./context/compactor.js";
export type { CompactionResult } from "./context/compactor.js";
export { maskOlderResults } from "./context/masking.js";
export { summarizePrefix } from "./context/summarizer.js";
export type { SummarizationResult } from "./context/summarizer.js";

export { ToolRegistry, jsonQueryDefinition, jsonQueryHandler } from "./tools/registry.js";
export type { ToolDefinition, ToolHandler } from "./tools/registry.js";
export { ValidationError } from "./tools/validation.js";
export { Scratchpad } from "./tools/scratchpad.js";

export { DocumentIndex } from "./retrieval/index.js";
export type { Chunk, SearchHit } from "./retrieval/index.js";
export { RetrievalInterface } from "./tools/retrieval.js";
export { fileViewportTool, editLinesTool } from "./tools/files.js";
export { ToolCatalog, queryFromTranscript, createDiscoveryEntry } from "./tools/selector.js";
export type { CatalogEntry } from "./tools/selector.js";

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