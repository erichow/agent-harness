/**
 * Provider 协议 — 把 harness 与具体模型厂商解耦的"那道缝"
 *
 * 第 3 章 §3.3：升级后的 Provider 协议
 * 第 5 章 §5.3-5.4：Async 改造 + 批量 ToolCallRef + accumulate
 *
 * 相比第 3 章新增：
 *   - ToolCallRef：ProviderResponse 内承载批量工具调用
 *   - astream() / acomplete()：异步流式接口
 *   - accumulate()：事件流 → ProviderResponse
 */

import type { Transcript } from "../messages.js";
import type { StreamEvent, Completed } from "./events.js";
import { isTextDelta, isReasoningDelta, isToolCallStart, isToolCallDelta, isCompleted } from "./events.js";

/* ─── ToolCallRef ────────────────────────────────────────────────── */

/**
 * 一次工具调用的引用。
 *
 * 这是 ProviderResponse 内传递的手写形状，
 * 与 messages.ToolCallBlock（转录中的持久块）分离。
 * loop 会在提交 assistant 消息时把每个 ToolCallRef 构建为一个 ToolCallBlock。
 */
export class ToolCallRef {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly args: Record<string, unknown>,
  ) {}
}

/* ─── ProviderResponse ───────────────────────────────────────────── */

export class ProviderResponse {
  constructor(
    /** 文本回答（与 toolCalls 互斥） */
    readonly text?: string,
    /**
     * 批量工具调用（第 5 章升级）。
     * 支持一次响应携带多个工具调用——OpenAI Responses 和 Anthropic Messages 都默认如此。
     */
    readonly toolCalls: ToolCallRef[] = [],
    /** 推理痕迹文本 */
    readonly reasoningText?: string,
    /** 厂商专属不透明字段 */
    readonly reasoningMetadata: Record<string, unknown> = {},
    /** 本次请求的输入 token 数 */
    readonly inputTokens: number = 0,
    /** 本次请求的输出 token 数 */
    readonly outputTokens: number = 0,
    /** 输出 token 中属于推理的部分 */
    readonly reasoningTokens: number = 0,
  ) {}

  /* ─── 判断方法 ─── */

  /** 有工具调用 */
  get isToolCall(): boolean {
    return this.toolCalls.length > 0;
  }

  /** 是最终回答（有文本且没有工具调用） */
  get isFinal(): boolean {
    return this.text !== undefined && this.toolCalls.length === 0;
  }

  /* ─── Back-compat 快捷属性（第 5 章） ───
   *
   * ch04 的 ProviderResponse 只有单数 toolName/toolArgs/toolCallId。
   * 这些快捷属性让 ch04 的老代码（特别是 Message.fromAssistantResponse）
   * 不改就能继续工作——但只能读到第一个调用。
   *
   * 迁移到 ch05 后应该迭代 toolCalls 数组。
   */

  /** 第一个工具调用的 ID（back-compat） */
  get toolCallId(): string | undefined {
    return this.toolCalls[0]?.id;
  }

  /** 第一个工具调用的名称（back-compat） */
  get toolName(): string | undefined {
    return this.toolCalls[0]?.name;
  }

  /** 第一个工具调用的参数（back-compat） */
  get toolArgs(): Record<string, unknown> | undefined {
    return this.toolCalls[0]?.args;
  }
}

/* ─── Provider 协议 ──────────────────────────────────────────────── */

/**
 * Provider 是结构类型 — 只要实现了 astream() 就算实现了这个接口。
 */
export interface Provider {
  /** 模型名称标识（用于 logs、traces、成本归因） */
  name: string;

  /**
   * 同步完成（ch04 back-compat）。
   * 第 3-4 章的测试和代码使用此方法。
   */
  complete(
    transcript: Transcript,
    tools: Record<string, unknown>[],
  ): ProviderResponse;

  /**
   * 流式生成响应。
   * 产出 StreamEvent 序列，由 accumulate() 或 loop 消费。
   * ch05 新增。
   */
  astream(
    transcript: Transcript,
    tools: Record<string, unknown>[],
  ): AsyncGenerator<StreamEvent>;

  /**
   * 非流式完成（在 astream 之上实现）。
   * ch05 新增。
   */
  acomplete?(
    transcript: Transcript,
    tools: Record<string, unknown>[],
  ): Promise<ProviderResponse>;
}

/* ─── accumulate：事件流 → ProviderResponse ──────────────────────── */

/**
 * 把事件流折叠为一个 ProviderResponse。
 *
 * 处理多工具调用：每个 ToolCallStart 开一个 entry，每个 ToolCallDelta append 到对应 id，
 * arrival-order 列表保证稳定回放序。orphan fallback 防御 fragment 在 start 之前到达的畸形流。
 */
export async function accumulate(
  stream: AsyncIterable<StreamEvent> | Iterable<StreamEvent>,
): Promise<ProviderResponse> {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  // id → { name, argsBuffer }
  const toolEntries: Map<string, { name: string; argsBuffer: string }> = new Map();
  const toolIdsInOrder: string[] = [];
  let lastOpenedId: string | undefined;
  let orphanCounter = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let reasoningMetadata: Record<string, unknown> = {};

  for await (const event of stream) {
    if (isTextDelta(event)) {
      textParts.push(event.text);
    } else if (isReasoningDelta(event)) {
      reasoningParts.push(event.text);
    } else if (isToolCallStart(event)) {
      const entryId = event.id || `_orphan_${orphanCounter}`;
      if (!event.id) orphanCounter++;
      if (!toolEntries.has(entryId)) {
        toolEntries.set(entryId, { name: event.name, argsBuffer: "" });
        toolIdsInOrder.push(entryId);
      }
      lastOpenedId = entryId;
    } else if (isToolCallDelta(event)) {
      const targetId = event.id || lastOpenedId || `_orphan_${orphanCounter}`;
      if (!toolEntries.has(targetId)) {
        toolEntries.set(targetId, { name: "", argsBuffer: "" });
        toolIdsInOrder.push(targetId);
      }
      const entry = toolEntries.get(targetId)!;
      entry.argsBuffer += event.argsFragment;
    } else if (isCompleted(event)) {
      inputTokens = event.inputTokens;
      outputTokens = event.outputTokens;
      reasoningTokens = event.reasoningTokens ?? 0;
      reasoningMetadata = event.reasoningMetadata ?? {};
    }
  }

  // 构建 tool calls（按 arrival 顺序）
  const toolCalls: ToolCallRef[] = [];
  for (const tid of toolIdsInOrder) {
    const entry = toolEntries.get(tid)!;
    let args: Record<string, unknown>;
    try {
      args = entry.argsBuffer ? JSON.parse(entry.argsBuffer) : {};
    } catch {
      // JSON 解析失败 — 暴露原始 buffer，registry 校验器会返回结构化错误
      args = { _raw: entry.argsBuffer };
    }
    toolCalls.push(new ToolCallRef(tid, entry.name, args));
  }

  const reasoningText = reasoningParts.length > 0
    ? reasoningParts.join("")
    : undefined;

  if (toolCalls.length > 0) {
    return new ProviderResponse(
      undefined,        // text
      toolCalls,        // toolCalls
      reasoningText,
      reasoningMetadata,
      inputTokens,
      outputTokens,
      reasoningTokens,
    );
  }

  return new ProviderResponse(
    textParts.join(""),
    [],                 // no tool calls
    reasoningText,
    reasoningMetadata,
    inputTokens,
    outputTokens,
    reasoningTokens,
  );
}
