/**
 * 第 19 章 Evals 示例 — 评测框架
 *
 * 对应设计文档「ch19-evals — 评测 (Evals)」
 *
 * 设计要点：
 *   1. 4 类 metric：Completion / Correctness / Process validity / Cost
 *   2. 在轨迹层评估，不是单 turn 层
 *   3. EvalCase → EvalRunner → EvalResult
 *   4. LLM-as-judge 评估主观 correctness
 *
 * 运行方式：
 *   npx tsx examples/ch19_evals.ts
 */

import { EvalRunner } from "../src/harness/evals/runner.js";
import { judge } from "../src/harness/evals/judge.js";
import type { EvalCase, EvalResult } from "../src/harness/evals/case.js";
import { runStability } from "../src/harness/evals/stability.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse } from "../src/harness/providers/base.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

/* ─── 构建测试环境 ──────────────────────────────────────────────── */

function buildCalculatorRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "calc",
      description: "Evaluate an arithmetic expression",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string" },
        },
        required: ["expression"],
      },
    },
    (args) => String(eval(String(args.expression ?? "0").replace(/[^0-9+\-*/().%\s]/g, ""))),
  );
  return registry;
}

/* ─── 演示 ──────────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch19: Evals 评测 ━━━\n");

  const registry = buildCalculatorRegistry();

  // 1. 定义评测用例
  console.log("─ 1. 定义 EvalCase ───────────────────");
  const cases: EvalCase[] = [
    {
      id: "calc-simple",
      description: "简单算术 2+2",
      userMessage: "What is 2 + 2? Use the calculator tool.",
      requiredTools: ["calc"],
      forbiddenTools: [],
      checkAnswer: (ans) => ans.includes("4"),
    },
    {
      id: "calc-complex",
      description: "复杂算术 (5+3)*2",
      userMessage: "Calculate (5 + 3) * 2 using the calc tool.",
      requiredTools: ["calc"],
      forbiddenTools: [],
      checkAnswer: (ans) => ans.includes("16"),
    },
    {
      id: "no-tool-needed",
      description: "不需要工具的简单问题",
      userMessage: "What is the capital of France?",
      requiredTools: [],
      forbiddenTools: ["calc"],
      checkAnswer: (ans) => ans.toLowerCase().includes("paris"),
    },
  ];

  for (const c of cases) {
    console.log(`   ${c.id}: ${c.description}`);
  }
  console.log();

  // 2. 运行评测
  console.log("─ 2. EvalRunner 运行评测 ─────────────");

  // 创建对应每个 case 的 mock provider
  const mockProvider = new MockProvider([
    // case 1: calc-simple — 调工具后回答
    new ProviderResponse(undefined, [
      { id: "c1-call", name: "calc", arguments: { expression: "2+2" } },
    ]),
    new ProviderResponse("The result is 4."),
    // case 2: calc-complex
    new ProviderResponse(undefined, [
      { id: "c2-call", name: "calc", arguments: { expression: "(5+3)*2" } },
    ]),
    new ProviderResponse("The result is 16."),
    // case 3: no-tool-needed
    new ProviderResponse("The capital of France is Paris."),
  ]);

  const runner = new EvalRunner(mockProvider, registry);

  // 逐个运行
  for (const c of cases) {
    const result = await runner.runOne(c);
    const icon = result.passed ? "✅" : "❌";
    console.log(`   ${icon} ${c.id} — ${result.passed ? "PASS" : "FAIL"}`);
    if (!result.passed) {
      for (const f of result.failures) {
        console.log(`       ↳ ${f}`);
      }
    }
  }
  console.log();

  // 3. LLM-as-judge
  console.log("─ 3. LLM-as-judge ────────────────────");
  const judgeProvider = new MockProvider([
    new ProviderResponse("PASS: The answer correctly states 4"),
  ]);
  const judgeResult = await judge(
    judgeProvider,
    "What is 2 + 2? Use the calculator tool.",
    "The result is 4.",
    { criteria: "correctness" },
  );
  console.log(`   judge 结果: ${judgeResult ? "PASS ✅" : "FAIL ❌"}`);
  console.log();

  // 4. 稳定性评测（多次重复）
  console.log("─ 4. 稳定性评测（5 次重复） ───────────");
  const stableMock = new MockProvider([
    new ProviderResponse("The answer is 4."),
    new ProviderResponse("The answer is 4."),
    new ProviderResponse("The answer is 4."),
    new ProviderResponse("The answer is 4."),
    new ProviderResponse("The answer is 4."),
  ]);
  const stableRunner = new EvalRunner(stableMock, new ToolRegistry());
  const stabilityCase: EvalCase = {
    id: "stability-test",
    description: "稳定性测试: 2+2",
    userMessage: "What is 2+2?",
    checkAnswer: (ans) => ans.includes("4"),
  };
  const stabilityResults = await runStability(stableRunner, stabilityCase, 5);
  console.log(`   通过率: ${stabilityResults.passRate}`);
  console.log(`   平均耗时: ${stabilityResults.avgDuration.toFixed(0)}ms`);
  console.log(`   运行序列: ${stabilityResults.perRun.join(" ")}`);

  // 5. EvalCase 格式总结
  console.log("\n─ 5. EvalCase 格式 ────────────────────");
  console.log("   interface EvalCase {");
  console.log("     id: string;                 // 唯一标识");
  console.log("     description: string;        // 人类可读描述");
  console.log("     userMessage: string;        // 用户输入");
  console.log("     requiredTools?: string[];   // 必须调用的工具");
  console.log("     forbiddenTools?: string[];  // 禁止调用的工具");
  console.log("     checkAnswer?: (ans) => boolean; // 答案验证");
  console.log("     maxTokens?: number;         // token 上限");
  console.log("     maxIterations?: number;     // 回合上限");
  console.log("   }");

  console.log("\n━━━ ✅ Evals 示例完成 ━━━");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
