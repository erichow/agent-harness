/**
 * checkpoint/resume.ts — 第 21 章：Resume 逻辑
 *
 * 3 步 resume：
 *   1. Verify 中断的 side effects
 *   2. 用 deserializer rehydrate 内存对象
 *   3. 通过 arun 既有参数传入
 */

import type { Checkpointer } from "./store.js";

export interface PendingToolCall {
  callId: string;
  toolName: string;
  argsJson: string;
  startedAt: string;
}

/**
 * 获取 session 中 issued 但未 completed 的 tool calls。
 * Resume 时根据工具的 side effect 处理：
 *   - Read-only: 丢弃
 *   - Write/mutate: 三选一（标 failed / verify hook / 上报用户）
 */
export function getPendingToolCalls(
  checkpointer: Checkpointer,
  sessionId: string,
): PendingToolCall[] {
  const records = checkpointer.getToolCallsByStatus(sessionId, "issued");
  return records.map((r) => ({
    callId: r.callId,
    toolName: r.toolName,
    argsJson: r.argsJson,
    startedAt: r.startedAt,
  }));
}
