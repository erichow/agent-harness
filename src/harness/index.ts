/**
 * agent-harness — 构建 AI Agent Harness (JavaScript 版)
 *
 * 从 Python 教程《构建 AI Agent Harness · 可视化学习教程》改编而来。
 * 逐章将 Python 实现转写为 TypeScript。
 */

export const VERSION = "0.1.0";

export { run, MAX_ITERATIONS } from "./agent.js";
export type { ToolFunction } from "./agent.js";

export { ProviderResponse } from "./providers/base.js";
export type { Provider } from "./providers/base.js";
export { MockProvider } from "./providers/mock.js";

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
