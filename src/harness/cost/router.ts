/**
 * cost/router.ts — 第 20 章：模型路由
 *
 * 某些 turn 比其它容易。分类问题不需要 Opus；摘要能跑 Haiku。
 * 路由降低 per-turn 平均成本，代价是每次调用前一个决策。
 *
 * 路由信号（按回报大小）：
 *   1. 任务类型 — classify/extract → economy；code/plan/reason → premium
 *   2. 输入长度 — >50K context → premium（能力 gap 不是成本 gap）
 *   3. 不确定性 — 便宜模型低置信 → 升级 premium 二次意见
 */

import type { Provider } from "../providers/base.js";

export type ModelTier = "economy" | "mid" | "premium";

/**
 * ModelRouter——在 provider 之间选一个。
 *
 * Router 自己不是 Provider；它在 provider 之间挑。
 * Loop 调 router.choose(transcript).complete(...) 而非 provider.complete(...)。
 */
export class ModelRouter {
  constructor(
    /** 最快、最便宜的模型（Haiku / GPT-5-mini 等） */
    public readonly economy: Provider,
    /** 中档模型（Sonnet / GPT-5 等） */
    public readonly mid: Provider,
    /** 旗舰模型（Opus / GPT-5.2 等） */
    public readonly premium: Provider,
  ) {}

  /**
   * 根据 transcript 和任务 hint 选择 provider。
   *
   * @param transcript — 当前对话历史（用于估计输入长度）
   * @param taskHint   — 可选的任务类型 hint
   * @returns 选中的 Provider
   */
  choose(
    transcript?: { messages?: Array<{ content?: string }> },
    taskHint?: string,
  ): Provider {
    // 启发式 1：长 context → premium（能力 gap）
    if (transcript && this._estimateTokens(transcript) > 50_000) {
      return this.premium;
    }

    // 启发式 2：任务类型 hint
    if (taskHint) {
      const lower = taskHint.toLowerCase();
      if (["classify", "extract", "summarize"].includes(lower)) {
        return this.economy;
      }
      if (["code", "plan", "reason", "debug"].includes(lower)) {
        return this.premium;
      }
    }

    // 默认：中档
    return this.mid;
  }

  /**
   * 选择 tier 名称（不返回 provider 本身时有用）。
   */
  chooseTier(
    transcript?: { messages?: Array<{ content?: string }> },
    taskHint?: string,
  ): ModelTier {
    const provider = this.choose(transcript, taskHint);
    if (provider === this.economy) return "economy";
    if (provider === this.premium) return "premium";
    return "mid";
  }

  /**
   * 粗略估计 transcript 的 token 数（字符 / 4）。
   */
  private _estimateTokens(
    transcript: { messages?: Array<{ content?: string }> },
  ): number {
    let totalChars = 0;
    if (transcript.messages) {
      for (const msg of transcript.messages) {
        totalChars += msg.content?.length ?? 0;
      }
    }
    return Math.ceil(totalChars / 4);
  }
}
