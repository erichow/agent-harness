/**
 * evals/runner.ts — 第 19 章：EvalRunner
 *
 * 执行 EvalCase 套件，报告 pass/fail。
 *
 * 设计：
 *   不包装 catalog——复用 arun 完整循环，通过 onToolCall 回调记录工具调用。
 *   生产 runner 可以从 OTel span 拉数据（第 18 章）。
 */

import type { Provider } from "../providers/base.js";
import { ToolCatalog } from "../tools/selector.js";
import type { ToolRegistry } from "../tools/registry.js";
import { arun, MAX_ITERATIONS } from "../agent.js";
import type { EvalCase, EvalResult } from "./case.js";
import type { ToolCallBlock } from "../messages.js";

/* ─── EvalRunner ──────────────────────────────────────────────────── */

export class EvalRunner {
  constructor(
    private readonly provider: Provider,
    private readonly catalogOrReg: ToolCatalog | ToolRegistry,
  ) {}

  /**
   * 执行单个 EvalCase。
   */
  async runOne(case_: EvalCase): Promise<EvalResult> {
    const start = Date.now();
    const observedTools: string[] = [];

    // 通过 onToolCall 回调记录模型调用的工具名
    const onToolCall = (call: ToolCallBlock): void => {
      observedTools.push(call.name);
    };

    try {
      const finalAnswer = await arun(
        this.provider,
        this.catalogOrReg,
        case_.userMessage,
        undefined,         // transcript
        case_.system,      // system prompt
        undefined,         // onEvent
        onToolCall,
      );

      const failures = this._check(case_, finalAnswer, observedTools);

      return {
        caseId: case_.id,
        passed: failures.length === 0,
        failures,
        finalAnswer,
        tokensUsed: 0,      // TODO: extract from arun return
        iterationsUsed: 0,  // TODO: extract from arun return
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return {
        caseId: case_.id,
        passed: false,
        failures: [`crashed: ${(e as Error).constructor.name}: ${(e as Error).message}`],
        finalAnswer: "",
        tokensUsed: 0,
        iterationsUsed: 0,
        durationMs: Date.now() - start,
      };
    }
  }

  /**
   * 批量执行所有 case。
   */
  async runAll(cases: EvalCase[]): Promise<EvalResult[]> {
    const results: EvalResult[] = [];
    for (const c of cases) {
      const result = await this.runOne(c);
      const icon = result.passed ? "✓" : "✗";
      const detail = result.failures.length > 0 ? ` — ${result.failures.join(", ")}` : "";
      console.log(
        `${icon} ${c.id}: ${c.description} [${result.durationMs}ms]${detail}`,
      );
      results.push(result);
    }
    return results;
  }

  /**
   * 检查 EvalCase 约束。
   */
  private _check(
    case_: EvalCase,
    finalAnswer: string,
    observedTools: string[],
  ): string[] {
    const failures: string[] = [];

    // checkAnswer
    if (case_.checkAnswer && !case_.checkAnswer(finalAnswer)) {
      failures.push("answer check failed");
    }

    // requiredTools
    if (case_.requiredTools) {
      for (const tool of case_.requiredTools) {
        if (!observedTools.includes(tool)) {
          failures.push(`required tool not called: ${tool}`);
        }
      }
    }

    // forbiddenTools
    if (case_.forbiddenTools) {
      for (const tool of case_.forbiddenTools) {
        if (observedTools.includes(tool)) {
          failures.push(`forbidden tool called: ${tool}`);
        }
      }
    }

    return failures;
  }
}
