/**
 * Provider 协议 — 把 harness 与具体模型厂商解耦的"那道缝"
 *
 * 第 2 章：最小可用循环
 * - ProviderResponse 把"调工具"和"给答案"两种情况塞进同一个形状
 * - transcript 和 tools 还是 Record<string, unknown>[] — 刻意的简化
 *   第 3 章会把它们升级为类型化的消息类
 */

export interface ProviderResponse {
  /** "text" → 最终答案, "tool_call" → 需要执行工具 */
  kind: "text" | "tool_call";
  /** kind === "text" 时的回答内容 */
  text?: string;
  /** kind === "tool_call" 时要调用的工具名 */
  tool_name?: string;
  /** kind === "tool_call" 时传给工具的参数 */
  tool_args?: Record<string, unknown>;
  /** kind === "tool_call" 时工具调用的唯一 ID */
  tool_call_id?: string;
}

/**
 * Provider 是一个结构类型（structural type）—
 * 只要实现了 complete() 方法就算实现了这个接口。
 *
 * @param transcript - 当前会话的消息历史
 * @param tools - 可用的工具 schema 列表
 * @returns 模型的一次响应
 */
export interface Provider {
  complete(
    transcript: Record<string, unknown>[],
    tools: Record<string, unknown>[],
  ): ProviderResponse;
}
