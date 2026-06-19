/**
 * ContextAccountant — 上下文窗口记账（第 7 章）
 *
 * 按组件追踪 token 用量。纯测量，不修改 transcript。
 * 为第 8-11 章的压缩 / scratchpad / 检索决策提供数据基础。
 *
 * 5 类组件：
 *   system    — 系统提示词（整 session 稳定）
 *   tools     — tool schemas（由 provider 渲染到 prompt）
 *   history   — 对话历史（user / assistant / tool 结果）
 *   retrieved — 为当前 turn 检索的外部内容
 *   headroom  — 预留给模型响应的空间
 */
import type { Transcript, Block } from "../messages.js";
import { Message, TextBlock, ToolCallBlock, ToolResultBlock, ReasoningBlock } from "../messages.js";

/* ─── 组件类型 ───────────────────────────────────────────────────── */

export type Component = "system" | "tools" | "history" | "retrieved" | "headroom";

export type ContextState = "green" | "yellow" | "red";

/* ─── ContextBudget ──────────────────────────────────────────────── */

/**
 * 上下文窗口预算配置。
 *
 * window_size: provider 标称的上下文窗口（如 200_000）
 * headroom:    留白，预留给模型输出（对应 max_tokens）
 * thresholds:  green/yellow/red 的利用率阈值
 */
export class ContextBudget {
  constructor(
    readonly windowSize: number = 200_000,
    readonly headroom: number = 4096,
    readonly yellowThreshold: number = 0.60,
    readonly redThreshold: number = 0.80,
  ) {}

  /** 扣除留白后的实际可用空间 */
  get usable(): number {
    return this.windowSize - this.headroom;
  }
}

/* ─── ContextSnapshot ────────────────────────────────────────────── */

/**
 * 某一时刻的上下文快照。
 *
 * totals 按组件分类的 token 数（headroom 也作为一项记录，但不计入 total_used）
 */
export class ContextSnapshot {
  constructor(
    readonly totals: Record<Component, number>,
    readonly budget: ContextBudget,
  ) {}

  /** 已使用的 token 总数（不含 headroom） */
  get totalUsed(): number {
    let sum = 0;
    for (const [key, val] of Object.entries(this.totals)) {
      if (key !== "headroom") sum += val;
    }
    return sum;
  }

  /** 利用率：totalUsed / usable */
  get utilization(): number {
    return this.totalUsed / Math.max(this.budget.usable, 1);
  }

  /** 当前状态 */
  get state(): ContextState {
    const u = this.utilization;
    if (u >= this.budget.redThreshold) return "red";
    if (u >= this.budget.yellowThreshold) return "yellow";
    return "green";
  }
}

/* ─── ContextAccountant ──────────────────────────────────────────── */

/**
 * 上下文记账员。
 *
 * 负责在每次 provider 调用前 snapshot transcript 的 token 用量，
 * 按组件拆分。纯观察，不改任何数据。
 */
export class ContextAccountant {
  readonly budget: ContextBudget;

  constructor(budget?: ContextBudget) {
    this.budget = budget ?? new ContextBudget();
  }

  /**
   * 对当前 transcript 做一次快照。
   *
   * @param transcript - 当前对话记录
   * @param toolSchemas - 已注册工具的 schema 列表（getSchemas() 输出）
   * @param retrieved - 当前 turn 检索的外部内容（第 10 章用）
   * @returns 上下文快照
   */
  snapshot(
    transcript: Transcript,
    toolSchemas?: Record<string, unknown>[],
    retrieved?: string[],
  ): ContextSnapshot {
    const totals: Record<Component, number> = {
      system: this._countText(transcript.system ?? ""),
      tools: this._countToolSchemas(toolSchemas ?? []),
      history: this._countMessages(transcript.messages),
      retrieved: this._countStrings(retrieved ?? []),
      headroom: this.budget.headroom,
    };
    return new ContextSnapshot(totals, this.budget);
  }

  /* ─── 内部计数方法 ──────────────────────────────────────────── */

  /**
   * 估算文本的 token 数。
   *
   * 使用简单的 length/4 估算，无需额外依赖。
   * 实际生产中可替换为 tiktoken npm 包以获得 billing 级精度。
   *
   * 对英文约 4 字符/token，对中文约 1.5-2 字符/token。
   * 这个粗略估算对预算决策已足够——偏差会在对账中被 accept。
   */
  private _countText(text: string): number {
    if (!text) return 0;
    // 粗略估算：英文 4 字符/token，中文字符算 2 字符/token
    let charCount = 0;
    for (const ch of text) {
      charCount += ch.charCodeAt(0) > 127 ? 2 : 1;
    }
    return Math.max(1, Math.ceil(charCount / 4));
  }

  /** 估算 tool schemas 总 token 数 */
  private _countToolSchemas(schemas: Record<string, unknown>[]): number {
    return schemas.reduce((sum, s) => sum + this._countText(JSON.stringify(s)), 0);
  }

  /** 估算多条文本的 token 数 */
  private _countStrings(strings: string[]): number {
    return strings.reduce((sum, s) => sum + this._countText(s), 0);
  }

  /** 估算 transcript 中所有消息的 token 数 */
  private _countMessages(messages: Message[]): number {
    // 每条消息约 4 token 的 overhead（role 标记等）
    return messages.reduce(
      (sum, msg) => sum + 4 + this._countBlocks(msg.blocks),
      0,
    );
  }

  /** 估算一组 block 的 token 数 */
  private _countBlocks(blocks: Block[]): number {
    return blocks.reduce((sum, block) => {
      switch (block.kind) {
        case "text":
          return sum + this._countText(block.text);
        case "tool_call":
          return (
            sum +
            this._countText(block.name) +
            this._countText(JSON.stringify(block.args)) +
            6 // tool_call 框架开销
          );
        case "tool_result":
          return sum + this._countText(block.content) + 4;
        case "reasoning":
          return sum + this._countText(block.text);
        default:
          return sum; // 新 block 类型，保守低估
      }
    }, 0);
  }
}
