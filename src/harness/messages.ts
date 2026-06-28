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

/** 纯文本块：表示一段自然语言文本，如用户提问或模型回答。
 *
 * - `kind` 固定为 "text"，用于运行时类型收窄（type narrowing）
 * - `readonly` 确保不可变性——消息一旦构建就不会被篡改
 */
export interface TextBlock {
  readonly kind: "text";
  readonly text: string;
}

/** 工具调用块：表示模型请求调用某个外部工具/函数。
 *
 * - `id`：该次调用的唯一标识，用于与后续的 ToolResultBlock 配对
 * - `name`：要调用的工具名称
 * - `args`：传给工具的参数，类型为 `Record<string, unknown>` 以保持灵活性
 */
export interface ToolCallBlock {
  readonly kind: "tool_call";
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** 工具结果块：表示工具执行后的返回内容。
 *
 * - `callId`：对应 ToolCallBlock 的 id，形成请求-响应配对
 * - `content`：工具返回的内容（始终为字符串，复杂数据由调用方序列化）
 * - `isError`：标记是否执行出错。为 true 时，模型应知晓失败情况
 */
export interface ToolResultBlock {
  readonly kind: "tool_result";
  readonly callId: string;
  readonly content: string;
  readonly isError: boolean;
}

/** 推理痕迹块：表示模型的内部推理/思考过程（cot，chain-of-thought）。
 *
 * 不同厂商的实现各异：
 *  - Anthropic：extended thinking，返回明文推理文本 + signature
 *  - OpenAI：o1/o3 系列的 reasoning_content + encrypted_content
 *
 * `metadata` 存放厂商专属的不透明字段，需原样回传（round-trip）。
 */
export interface ReasoningBlock {
  readonly kind: "reasoning";
  readonly text: string;
  /** 厂商专属的、必须 round-trip 的不透明字段
   *  — Anthropic: signature
   *  — OpenAI: encrypted_content
   */
  readonly metadata: Record<string, unknown>;
}

/** 消息能装的一切——四种块的联合类型。
 * 使用联合类型而非接口继承，以便通过 `block.kind` 做类型收窄。
 */
export type Block = TextBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock;

/* ─── Block 工厂函数 ────────────────────────────────────────────── */
/* 这些工厂函数纯粹是语法糖，帮你省去重复写 `kind` 字段的麻烦。
 * 不使用 new 关键字，直接返回普通对象，保持轻量。
 */

/** 创建一个文本块。这是最常见的块类型。 */
export function textBlock(text: string): TextBlock {
  return { kind: "text", text };
}

/** 创建一个工具调用块。
 * @param id - 调用标识，需与后续 toolResultBlock 的 callId 一致
 * @param name - 工具名称
 * @param args - 工具参数
 */
export function toolCallBlock(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCallBlock {
  return { kind: "tool_call", id, name, args };
}

/** 创建一个工具结果块，与对应的 ToolCallBlock 配对。
 * @param callId - 对应 ToolCallBlock 的 id
 * @param content - 工具返回的文本内容
 * @param isError - 是否执行失败（默认为 false）
 */
export function toolResultBlock(
  callId: string,
  content: string,
  isError = false,
): ToolResultBlock {
  return { kind: "tool_result", callId, content, isError };
}

/** 创建一个推理痕迹块。
 * @param text - 推理文本内容（模型的思考过程）
 * @param metadata - 厂商专属元数据，需原样回传给 API
 */
export function reasoningBlock(
  text: string,
  metadata: Record<string, unknown> = {},
): ReasoningBlock {
  return { kind: "reasoning", text, metadata };
}

/* ─── Message ────────────────────────────────────────────────────── */

/** 角色：消息的发送方。
 * - "user"：用户（或工具结果，Anthropic 约定如此）
 * - "assistant"：AI 模型
 * - "system"：系统提示（通常只有一条，放在 Transcript 中）
 */
export type Role = "user" | "assistant" | "system";

/** Message（消息）是一条带有角色、内容和元数据的记录。
 *
 * 设计要点：
 *  - 所有字段都是 `readonly`，消息一旦创建就不可变
 *  - 内容由 `blocks[]` 承载——一条消息可以包含多个块
 *    （例如：先 reasoning 再 text，或包含多次 tool_call）
 *  - `id` 使用 `crypto.randomUUID()` 自动生成，确保全局唯一
 *  - `createdAt` 默认为当前时间，用于排序和日志
 */
export class Message {
  constructor(
    /** 消息角色：user / assistant / system */
    readonly role: Role,
    /** 消息的内容块序列。允许同一条消息包含多种类型的块。 */
    readonly blocks: Block[],
    /** 创建时间戳，默认当前时间 */
    readonly createdAt: Date = new Date(),
    /** 全局唯一 ID，默认使用 UUID v4 */
    readonly id: string = crypto.randomUUID(),
  ) {}

  /* ─── 静态工厂方法 ─── */
  /* 这些方法隐藏了 Message 构造函数的细节，让调用方用最少的参数创建消息。
   * 建议尽量通过这些工厂方法创建 Message，而不是直接 new。
   */

  /** 快速创建纯文本 user 消息。最常用的快捷方式。 */
  static userText(text: string): Message {
    return new Message("user", [textBlock(text)]);
  }

  /** 创建 assistant 文本消息，可选择附带推理过程（reasoning）。
   * 如果传入 reasoning 块，它会被放在文本块之前（先思考，后回答）。
   */
  static assistantText(
    text: string,
    reasoning?: ReasoningBlock,
  ): Message {
    const blocks: Block[] = [];
    if (reasoning) blocks.push(reasoning);
    blocks.push(textBlock(text));
    return new Message("assistant", blocks);
  }

  /** 创建 assistant 工具调用消息，可选择附带推理过程。
   * 当模型决定调用工具时使用此方法。
   */
  static assistantToolCall(
    call: ToolCallBlock,
    reasoning?: ReasoningBlock,
  ): Message {
    const blocks: Block[] = [];
    if (reasoning) blocks.push(reasoning);
    blocks.push(call);
    return new Message("assistant", blocks);
  }

  /** 创建 tool result 消息——将工具执行结果返回给模型。
   *
   * 重要约定：
   *  - Anthropic API：tool result 必须挂在 user 角色下
   *  - OpenAI API：tool result 需要映射为 function_call_output
   *  - 角色是传输层细节，block 类型蕴含语义
   *  - 各厂商的 adapter 会在序列化时做相应的 remapping
   */
  static toolResult(result: ToolResultBlock): Message {
    return new Message("user", [result]);
  }

  /** 从 ProviderResponse（厂商统一的响应格式）创建 assistant 消息。
   *
   * 根据 response 的内容自动判断：
   *  - 如果是工具调用 → 创建 assistantToolCall
   *  - 否则 → 创建 assistantText
   *  - 如果 response 包含 reasoning 字段，自动附加 reasoning 块
   */
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

/* ─── Transcript（转录/对话记录）────────────────────────────────────── */

/** Transcript 是完整对话的容器。
 *
 * 职责：
 *  - 按顺序存放所有 Message
 *  - 可选地附带一个 system prompt（在对话最前面）
 *  - 提供 append/extend/last 等便捷操作方法
 *
 * 注意：`messages` 是公开可写的（非 readonly），
 * 这是因为 Transcript 本身是一个不断增长的记录，而非不可变历史。
 * 但在追加后不应删除或重排已有消息。
 */
export class Transcript {
  /** 按时间顺序排列的消息列表 */
  messages: Message[] = [];

  /** 可选的 system prompt。
   * 如果设置了，会在发送给 API 时放在消息列表最前面。
   */
  system?: string;

  constructor(system?: string) {
    this.system = system;
  }

  /** 追加一条消息到对话末尾 */
  append(message: Message): void {
    this.messages.push(message);
  }

  /** 批量追加多条消息到对话末尾 */
  extend(messages: Message[]): void {
    this.messages.push(...messages);
  }

  /** 获取最后一条消息，没有则返回 undefined */
  last(): Message | undefined {
    return this.messages[this.messages.length - 1] ?? undefined;
  }

  /** 当前消息总数（getter，方便直接访问 transcript.length） */
  get length(): number {
    return this.messages.length;
  }
}
