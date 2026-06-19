/**
 * Compactor — 压缩协调者（第 8 章）
 *
 * 两层压缩策略：
 *   1. Masking — 遮蔽旧 tool_result 内容（可逆、精确、免费）
 *   2. Summarization — LLM 总结前缀（有损、贵、必要时才上）
 *
 * 先拉便宜的杠杆，不够再拉贵的。两根都拉了还红 → log 警告并放弃。
 */
import type { Transcript } from "../messages.js";
import type { Provider } from "../providers/base.js";
import { ContextAccountant } from "./accountant.js";
import { maskOlderResults } from "./masking.js";
import { summarizePrefix } from "./summarizer.js";
import type { SummarizationResult } from "./summarizer.js";

/* ─── CompactionResult ───────────────────────────────────────────── */

export interface CompactionResult {
  maskingTokensFreed: number;
  summarizationTurnsReplaced: number;
  summarizationTokens: number;
  finalState: "green" | "yellow" | "red";
}

/* ─── Compactor ──────────────────────────────────────────────────── */

export class Compactor {
  constructor(
    readonly accountant: ContextAccountant,
    readonly provider: Provider,
    readonly keepRecentResults: number = 3,
    readonly keepRecentTurnsOnSummary: number = 6,
  ) {}

  /**
   * 如果上下文窗口进入 red 状态，执行压缩。
   *
   * @param transcript - 对话记录（可能被修改）
   * @param toolSchemas - 工具 schema 列表
   * @returns CompactionResult
   */
  async compactIfNeeded(
    transcript: Transcript,
    toolSchemas: Record<string, unknown>[],
  ): Promise<CompactionResult> {
    const result: CompactionResult = {
      maskingTokensFreed: 0,
      summarizationTurnsReplaced: 0,
      summarizationTokens: 0,
      finalState: "green",
    };

    let snap = this.accountant.snapshot(transcript, toolSchemas);
    result.finalState = snap.state;
    if (snap.state !== "red") return result;

    // Step 1: mask older tool results
    const freed = maskOlderResults(transcript, this.keepRecentResults);
    result.maskingTokensFreed = freed;

    snap = this.accountant.snapshot(transcript, toolSchemas);
    result.finalState = snap.state;
    if (snap.state !== "red") return result;

    // Step 2: summarize the prefix
    const summary = await summarizePrefix(
      transcript,
      this.provider,
      this.keepRecentTurnsOnSummary,
    );
    if (summary !== null) {
      result.summarizationTurnsReplaced = summary.turnsReplaced;
      result.summarizationTokens = summary.outputTokens;
    }

    snap = this.accountant.snapshot(transcript, toolSchemas);
    result.finalState = snap.state;
    if (snap.state === "red") {
      console.warn(
        `[compactor] compaction could not bring transcript under red threshold ` +
        `(masked=${freed}, summarized=${result.summarizationTurnsReplaced} turns, ` +
        `final=${snap.utilization.toFixed(1)}%)`,
      );
    }

    return result;
  }
}
