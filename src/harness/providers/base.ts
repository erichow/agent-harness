/**
 * Provider 协议 — 把 harness 与具体模型厂商解耦的"那道缝"
 *
 * 第 3 章 §3.3：升级后的 Provider 协议
 *
 * 相比第 2 章新增：
 *   - token 计数（provider 知道，第 7 章记账器就不用估了）
 *   - reasoning_*（为推理类模型建模，如 Anthropic Extended Thinking、OpenAI o-series）
 *   - name 字段（让 logs 和 traces 能识别哪家 provider 服务了哪个响应）
 *
 * 删除：
 *   - kind: "text" | "tool_call" → 用 is_final / is_tool_call 属性代替
 */

import type { Transcript } from "../messages.js";

/**
 * 注意：text 与 toolName 互斥——同一响应里至多一个非空。
 * reasoning_* 与二者正交——可伴随任意一个。
 */
export class ProviderResponse {
  constructor(
    /** kind === "text" 时的回答内容 */
    readonly text?: string,
    /** kind === "tool_call" 时工具调用的唯一 ID */
    readonly toolCallId?: string,
    /** kind === "tool_call" 时要调用的工具名 */
    readonly toolName?: string,
    /** kind === "tool_call" 时传给工具的参数 */
    readonly toolArgs?: Record<string, unknown>,
    /** 推理痕迹文本（reasoning / thinking 内容） */
    readonly reasoningText?: string,
    /** 厂商专属的、必须 round-trip 的不透明字段 */
    readonly reasoningMetadata: Record<string, unknown> = {},
    /** 本次请求的输入 token 数 */
    readonly inputTokens: number = 0,
    /** 本次请求的输出 token 数 */
    readonly outputTokens: number = 0,
    /** 输出 token 中属于推理的部分 */
    readonly reasoningTokens: number = 0,
  ) {}

  /** 是工具调用响应 */
  get isToolCall(): boolean {
    return this.toolName !== undefined;
  }

  /** 是最终回答（文本且不是工具调用） */
  get isFinal(): boolean {
    return this.text !== undefined && this.toolName === undefined;
  }
}

/**
 * Provider 是一个结构类型（structural type）—
 * 只要实现了 complete() 方法就算实现了这个接口。
 */
export interface Provider {
  /** 模型名称标识（用于 logs、traces、成本归因） */
  name: string;

  /**
   * 给定当前 transcript 和可用工具，产生一次响应。
   *
   * @param transcript - 类型化的会话转录
   * @param tools - 工具 schema 列表（传给模型描述可用工具）
   */
  complete(
    transcript: Transcript,
    tools: Record<string, unknown>[],
  ): ProviderResponse;
}
