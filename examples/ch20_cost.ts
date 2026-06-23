/**
 * 第 20 章 Cost 示例 — 成本控制
 *
 * 对应设计文档「ch20-cost-control — 成本控制」
 *
 * 设计要点：
 *   1. BudgetEnforcer — 硬预算上限，超了就停
 *   2. ModelRouter — 便宜的活给便宜的模型干
 *   3. 三种路由信号：任务类型 / 输入长度 / 不确定性
 *   4. AbortController 传播停止信号到所有并行的 sibling
 *
 * 运行方式：
 *   npx tsx examples/ch20_cost.ts
 */

import { BudgetEnforcer, BudgetExceeded } from "../src/harness/cost/enforcer.js";
import { ModelRouter } from "../src/harness/cost/router.js";
import type { ModelTier } from "../src/harness/cost/router.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse } from "../src/harness/providers/base.js";

/* ─── Mock providers（不同价位） ──────────────────────────────────── */

function economyProvider(): MockProvider {
  return new MockProvider([
    new ProviderResponse("economy answer"),
    new ProviderResponse("economy answer"),
  ]);
}

function midProvider(): MockProvider {
  return new MockProvider([
    new ProviderResponse("mid answer"),
    new ProviderResponse("mid answer"),
  ]);
}

function premiumProvider(): MockProvider {
  return new MockProvider([
    new ProviderResponse("premium answer"),
    new ProviderResponse("premium answer"),
  ]);
}

/* ─── 演示 ──────────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch20: 成本控制 ━━━\n");

  // 1. BudgetEnforcer — 预算封顶
  console.log("─ 1. BudgetEnforcer 预算封顶 ─────────");

  const enforcer = new BudgetEnforcer(
    0.50,                           // max USD
    [0.5, 0.8],                     // 告警阈值 50%, 80%
    {
      "claude-haiku": [0.8, 4.0],
      "claude-sonnet-4-6": [3.0, 15.0],
      "claude-opus-4-6": [5.0, 25.0],
    },
  );

  // 模拟几次 LLM 调用
  console.log("   模拟 3 次 Sonnet 调用:");
  enforcer.record(10000, 2000, "claude-sonnet-4-6");
  console.log(`   第 1 次: $${enforcer.spentUsd.toFixed(4)} (remaining: $${enforcer.remainingUsd().toFixed(4)})`);
  enforcer.record(8000, 1500, "claude-sonnet-4-6");
  console.log(`   第 2 次: $${enforcer.spentUsd.toFixed(4)} (remaining: $${enforcer.remainingUsd().toFixed(4)})`);
  enforcer.record(12000, 3000, "claude-sonnet-4-6");
  console.log(`   第 3 次: $${enforcer.spentUsd.toFixed(4)} (remaining: $${enforcer.remainingUsd().toFixed(4)})`);

  // 超出预算
  console.log("\n   尝试超出预算 $0.50:");
  try {
    enforcer.record("claude-sonnet-4-6", { inputTokens: 100000, outputTokens: 20000 });
  } catch (e) {
    const bEx = e as BudgetExceeded;
    console.log(`   BudgetExceeded! 已花: $${bEx.spentUsd.toFixed(4)}, 上限: $${bEx.maxUsd}`);
    console.log(`   消息: ${bEx.message}`);
  }
  console.log();

  // 2. ModelRouter — 模型路由
  console.log("─ 2. ModelRouter 模型路由 ────────────");

  const router = new ModelRouter(
    economyProvider(),    // Haiku
    midProvider(),        // Sonnet
    premiumProvider(),    // Opus
  );

  // 简单分类任务 → economy
  const task1 = { messages: [{ content: "classify this as cat or dog" }] };
  const p1 = router.choose(
    { messages: task1.messages as any },
    "classify",
  );
  const r1 = await (p1 as MockProvider).complete(task1.messages as any);
  console.log(`   分类任务 → economy: ${r1.text}`);

  // 代码生成 → premium
  const p2 = router.choose(undefined, "code");
  const r2 = await (p2 as MockProvider).complete([]);
  console.log(`   代码任务 → premium: ${r2.text}`);

  // 长 context → premium
  const p3 = router.choose({ messages: Array(10).fill({ content: "x".repeat(6000) }) });
  const r3 = await (p3 as MockProvider).complete([]);
  console.log(`   长 context(>50K) → premium: ${r3.text}`);

  // 默认 → mid
  const p4 = router.choose(undefined, undefined);
  const r4 = await (p4 as MockProvider).complete([]);
  console.log(`   默认 → mid: ${r4.text}`);

  console.log();

  // 3. 价格表
  console.log("─ 3. 默认价格表（每百万 token USD） ─────");
  console.log("   claude-sonnet-4-6:  $3.00 input / $15.00 output");
  console.log("   claude-opus-4-6:    $5.00 input / $25.00 output");
  console.log("   claude-haiku:       $0.80 input / $4.00 output");
  console.log("   gpt-5:             $1.25 input / $10.00 output");
  console.log("   gpt-5.2:           $1.75 input / $14.00 output");
  console.log("   local:             $0.00 input / $0.00 output");
  console.log();

  // 4. 成本策略总结
  console.log("─ 4. 三层成本策略 ─────────────────────");
  console.log("   ① 缓存 — 稳定 prefix 省 80-90% (Anthropic 显式缓存)");
  console.log("   ② 路由 — 便宜的活给便宜的模型干");
  console.log("   ③ 硬预算 — 超了就停 (BudgetExceeded + AbortController)");

  console.log("\n━━━ ✅ Cost 示例完成 ━━━");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
