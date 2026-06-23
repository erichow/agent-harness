/**
 * evals/from_trace.ts — 第 19 章：Production-to-Eval pipeline
 *
 * 把生产 trace 转成回归 EvalCase。
 *
 * 工作流：
 *   监控 flag 一个失败 trace → 工程师 review
 *   → caseFromTrace() → 微调 → commit 到 suite
 *
 * 每次生产失败都在 suite 里留下化石。
 * 未来同类回归在 ship 前被 CI gate 挡住。
 */

import type { EvalCase } from "./case.js";

export interface TraceSummary {
  traceId: string;
  userMessage: string;
  system?: string;
  tokensUsed: number;
  failureReason?: string;
}

/**
 * 把生产 trace summary 转成回归 eval case。
 *
 * @param traceSummary — 从 tracing 后端抽出的结构化数据
 * @returns 一个基本的 EvalCase 实例
 */
export function caseFromTrace(traceSummary: TraceSummary): EvalCase {
  return {
    id: `prod-regression-${traceSummary.traceId.slice(0, 8)}`,
    description: [
      "regression from production",
      traceSummary.failureReason ? `: ${traceSummary.failureReason}` : "",
    ].join(""),
    userMessage: traceSummary.userMessage,
    system: traceSummary.system,
    maxTokens: Math.ceil(Math.max(traceSummary.tokensUsed * 1.5, 1_000)),
  };
}
