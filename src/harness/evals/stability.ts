/**
 * evals/stability.ts — 第 19 章：非确定性稳定性测试
 *
 * Evals 是概率系统，不是确定性测试。
 * 同一个 case 可能 pass 一次、fail 下一次。
 *
 * runStability() 跑同一个 case n 次，报告 pass rate。
 * "稳定"的标准是 ≥ 8/10。
 */

import type { EvalRunner } from "./runner.js";
import type { EvalCase, StabilityReport, EvalResult } from "./case.js";

/**
 * 跑同一个 case n 次；报告 pass rate 和 per-run 明细。
 *
 * @param runner — EvalRunner 实例
 * @param case   — 要测的 case
 * @param n      — 重跑次数（默认 10）
 * @returns StabilityReport
 */
export async function runStability(
  runner: EvalRunner,
  case_: EvalCase,
  n = 10,
): Promise<StabilityReport> {
  const results: EvalResult[] = [];
  for (let i = 0; i < n; i++) {
    results.push(await runner.runOne(case_));
  }

  const passed = results.filter((r) => r.passed).length;

  return {
    caseId: case_.id,
    passRate: `${passed}/${n}`,
    perRun: results.map((r) => (r.passed ? "✓" : "✗")),
    avgTokens: results.reduce((s, r) => s + r.tokensUsed, 0) / n,
    avgDuration: results.reduce((s, r) => s + r.durationMs, 0) / n,
  };
}
