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
 *
 * 第 13 章新增导出：
 *   - MCPClient — MCP 客户端（stdio + JSON-RPC）
 *   - MCPServerConfig — MCP 服务器配置类型
 *   - MCPTool — MCP 工具类型
 *   - wrapMcpTools — MCP 工具包装器
 *   - AsyncToolHandler — 异步工具 handler 类型
 *
 * 第 14 章新增导出：
 *   - PermissionManager — 权限管理器
 *   - PermissionRequest / PermissionOutcome / Decision — 权限类型
 *   - allowAll / denyAll / bySideEffect / pathAllowlist / compose — 策略函数
 *   - wrapIfUntrusted — trust label 包装
 *   - defaultCliPrompt / autoAllowPrompt — 人 in loop 提示
 *
 * 第 16 章新增导出：
 *   - Plan / Step / Postcondition / StepStatus — 结构化计划数据模型
 *   - PlanHolder — Plan 持有者
 *   - createPlanTools — 4 个 plan 操作工具
 *
 * 第 23 章新增导出：
 *   - createGitTools — 8 个结构化 git 版本控制工具
 *
 * 第 24 章新增导出：
 *   - createTerminalTools — 终端执行工具（run_command + 异步 + which）
 *
 * 第 25 章新增导出：
 *   - LSPManager — LSP 语言服务器管理器
 *   - createLSPTools — 6 个 LSP 代码智能工具
 *
 * 第 26 章新增导出：
 *   - createCodeAnalysisTools — 5 个代码分析工具（AST 解析、依赖分析、复杂度、模式搜索、安全扫描）
 *
 * 第 27 章新增导出：
 *   - createExtendedFilesystemTools — 6 个扩展文件系统工具（创建、删除、浏览、搜索、元信息）
 */

export const VERSION = "0.1.0";

/* ─── 已实现章节清单 ─────────────────────────────────────────── */

/** 当前已实现的章节编号列表（ch01–ch30） */
export const CHAPTERS_COMPLETED: readonly number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
] as const;

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
export type { ToolDefinition, ToolHandler, AsyncToolHandler } from "./tools/registry.js";
export { ValidationError } from "./tools/validation.js";
export { Scratchpad } from "./tools/scratchpad.js";

export { DocumentIndex } from "./retrieval/index.js";
export type { Chunk, SearchHit } from "./retrieval/index.js";
export { RetrievalInterface } from "./tools/retrieval.js";
export { fileViewportTool, editLinesTool } from "./tools/files.js";
export { ToolCatalog, queryFromTranscript, createDiscoveryEntry } from "./tools/selector.js";
export type { CatalogEntry } from "./tools/selector.js";
export { MCPClient } from "./mcp/client.js";
export type { MCPServerConfig, MCPTool } from "./mcp/client.js";
export { wrapMcpTools } from "./mcp/tools.js";
export { PermissionManager } from "./permissions/manager.js";
export type { PermissionRequest, PermissionOutcome, Decision, HumanPrompt } from "./permissions/model.js";
export { allowAll, denyAll, bySideEffect, pathAllowlist, compose } from "./permissions/policy.js";
export type { Policy } from "./permissions/policy.js";
export { wrapIfUntrusted } from "./permissions/trust.js";
export { defaultCliPrompt, autoAllowPrompt } from "./permissions/manager.js";

/* ─── 第 23 章：Git 版本控制工具 ──────────────────────────────────── */

export { createGitTools } from "./tools/git.js";

/* ─── 第 24 章：终端执行 ─────────────────────────────────────────── */

export { createTerminalTools } from "./tools/terminal.js";

/* ─── 第 25 章：LSP 语言服务器协议集成 ─────────────────────────── */

export { LSPManager, MockLSPManager, LspError, createLSPTools } from "./tools/lsp.js";
export type {
  LspPosition, LspLocation, LspRange,
  LspHoverResult, LspCompletionItem, LspSignatureInfo, LspDiagnosticItem,
} from "./tools/lsp.js";

/* ─── 第 26 章：代码分析工具 ──────────────────────────────────── */

export { createCodeAnalysisTools } from "./tools/code_analysis.js";

/* ─── 第 27 章：扩展文件系统工具 ──────────────────────────────────── */

export { createExtendedFilesystemTools } from "./tools/extended_filesystem.js";

export { Plan, createStep, createPostcondition, isStepTerminal, StepStatus } from "./plans/model.js";
export type { Step, Postcondition } from "./plans/model.js";
export { PlanHolder, createPlanTools } from "./plans/tools.js";

export { ProviderResponse, ToolCallRef, accumulate } from "./providers/base.js";
export type { Provider } from "./providers/base.js";
export { MockProvider } from "./providers/mock.js";
export { DeepSeekProvider } from "./providers/deepseek.js";
export type { DeepSeekProviderOptions } from "./providers/deepseek.js";
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

/* ─── 第 18 章：可观测性 ─────────────────────────────────────────── */

export {
  setupTracing,
  getSessionContext,
  runWithContext,
  subagentContext,
  span,
  GenAIAttributes,
  HarnessAttributes,
} from "./observability/tracing.js";
export type { SessionContext } from "./observability/tracing.js";

/* ─── 第 19 章：评测 (Evals) ────────────────────────────────────── */

export { EvalRunner } from "./evals/runner.js";
export { judge } from "./evals/judge.js";
export type { JudgeOptions } from "./evals/judge.js";
export { caseFromTrace } from "./evals/from_trace.js";
export type { TraceSummary } from "./evals/from_trace.js";
export { runStability } from "./evals/stability.js";
export type { EvalCase, EvalResult, StabilityReport } from "./evals/case.js";

/* ─── 第 20 章：成本控制 ─────────────────────────────────────────── */

export { BudgetEnforcer, BudgetExceeded } from "./cost/enforcer.js";
export { ModelRouter } from "./cost/router.js";
export type { ModelTier } from "./cost/router.js";

/* ─── 第 21 章：可恢复与持久化 ────────────────────────────────────── */

export { Checkpointer } from "./checkpoint/store.js";
export type {
  SessionRecord, CheckpointRecord, ToolCallRecord,
  SessionStatus, ToolCallStatus,
} from "./checkpoint/store.js";
export { deserializeBlock, deserializeTranscript, serializeMessages } from "./checkpoint/serde.js";
export { getPendingToolCalls } from "./checkpoint/resume.js";
export type { PendingToolCall } from "./checkpoint/resume.js";

/* ─── 第 30 章：UI 交互工具 ──────────────────────────────────────── */

export { createUITools, NoopUIProvider } from "./tools/ui.js";
export type { UIProvider } from "./tools/ui.js";