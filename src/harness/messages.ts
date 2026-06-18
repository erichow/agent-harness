/**
 * 消息、回合与转录 — 类型化的消息系统
 *
 * 第 3 章 §3.2：规范形状（全书的词汇基线）
 *
 * Block 是 4 种的 union：Text | ToolCall | ToolResult | Reasoning
 * Message 是一条有类型的记录：role + 有序的 blocks + 来源 + ID + 创建时间
 * Transcript 是 Message 的容器 + system prompt
 *
 * 所有 block 都是 frozen（只读）— 消息一旦创建就不可变。
 * 想改？换一个。
 */
import type { ProviderResponse } from "./providers/base.js";

/* ─── Block 类型 ─────────────────────────────────────────────────── */

export interface TextBlock {
  readonly kind: "text";
  readonly text: string;
}

export interface ToolCallBlock {
  readonly kind: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ToolResultBlock {
  readonly kind: "tool_result";
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
}

export interface ReasoningBlock {
  readonly kind: "reasoning";
  readonly text: string;
  /** 厂商专属的、必须 round-trip 的不透明字段
   *  — Anthropic: signature
   *  — OpenAI: encrypted_content
   */
  readonly metadata: Record<string, unknown>;
}

/** 消息能装的一切——文本、工具调用、工具结果、推理痕迹 */
export type Block = TextBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock;

/* ─── Block 工厂 ─────────────────────────────────────────────────── */

export function textBlock(text: string): TextBlock {
  return { kind: "text", text };
}

export function toolCallBlock(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCallBlock {
  return { kind: "tool_call", id, name, args };
}

export function toolResultBlock(
  callId: string,
  content: string,
  isError = false,
): ToolResultBlock {
  return { kind: "tool_result", callId, content, isError };
}

export function reasoningBlock(
  text: string,
  metadata: Record<string, unknown> = {},
): ReasoningBlock {
  return { kind: "reasoning", text, metadata };
}

/* ─── Message ────────────────────────────────────────────────────── */

export type Role = "user" | "assistant" | "system";

export class Message {
  constructor(
    readonly role: Role,
    readonly blocks: Block[],
    readonly createdAt: Date = new Date(),
    readonly id: string = crypto.randomUUID(),
  ) {}

  /* ─── 工厂方法 ─── */

  /** 快速创建纯文本 user 消息 */
  static userText(text: string): Message {
    return new Message("user", [textBlock(text)]);
  }

  /** 创建 assistant 文本消息（可选择附加 reasoning） */
  static assistantText(
    text: string,
    reasoning?: ReasoningBlock,
  ): Message {
    const blocks: Block[] = [];
    if (reasoning) blocks.push(reasoning);
    blocks.push(textBlock(text));
    return new Message("assistant", blocks);
  }

  /** 创建 assistant 工具调用消息（可选择附加 reasoning） */
  static assistantToolCall(
    call: ToolCallBlock,
    reasoning?: ReasoningBlock,
  ): Message {
    const blocks: Block[] = [];
    if (reasoning) blocks.push(reasoning);
    blocks.push(call);
    return new Message("assistant", blocks);
  }

  /** 创建 tool result 消息
   *
   * Anthropic 约定：tool result 挂在 user 角色下；
   * OpenAI adapter 会在出门时把它 remap 成 function_call_output。
   * 角色是传输细节；block 类型是语义。
   */
  static toolResult(result: ToolResultBlock): Message {
    return new Message("user", [result]);
  }

  /** 从 ProviderResponse 创建 assistant 消息 */
  static fromAssistantResponse(response: ProviderResponse): Message {
    let reasoning: ReasoningBlock | undefined;
    if (response.reasoningText) {
      reasoning = reasoningBlock(
        response.reasoningText,
        response.reasoningMetadata,
      );
    }

    if (response.isToolCall && response.toolName && response.toolCallId) {
      return Message.assistantToolCall(
        toolCallBlock(
          response.toolCallId,
          response.toolName,
          response.toolArgs ?? {},
        ),
        reasoning,
      );
    }

    return Message.assistantText(response.text ?? "", reasoning);
  }
}

/* ─── Transcript ─────────────────────────────────────────────────── */

export class Transcript {
  messages: Message[] = [];
  system?: string;

  constructor(system?: string) {
    this.system = system;
  }

  append(message: Message): void {
    this.messages.push(message);
  }

  extend(messages: Message[]): void {
    this.messages.push(...messages);
  }

  last(): Message | undefined {
    return this.messages[this.messages.length - 1] ?? undefined;
  }

  get length(): number {
    return this.messages.length;
  }
}
