/**
 * 第 2 章 Calculator 示例 — 最小可用 Agent 循环
 *
 * 对应 Confluence 设计文档「ch02-minimal-loop — 最小可用 Agent 循环」
 *
 * 设计要点：
 *   1. 核心循环只有 ~40 行：问模型 → 检查响应类型 → 调工具或返回答案
 *   2. 使用 MockProvider 离线、零成本跑通第一遍
 *   3. 明确留下 5 个设计债（后续章节逐个解决）
 *
 * 5 个设计债（ch02 故意不修）：
 *   📋 transcript 是无类型的 — 工具调用和文本在代码里长一样
 *   🔧 没有工具注册中心 — schema 和 handler 靠人手动配对
 *   💥 错误直接抛 — 模型调了不存在工具 → 整个循环崩
 *   📈 transcript 无线增长 — 长对话迟早撑爆上下文窗口
 *   💰 没有 token 计数 — 不知道花了多少钱
 *
 * 运行方式：
 *   npx tsx examples/ch02_calculator.ts
 */

import { run } from "../src/harness/agent.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

/* ─── 工具定义 ──────────────────────────────────────────────────── */

/**
 * 计算器工具 — 求值一个算数表达式
 *
 * ch02 版：工具就是 Record<string, (args) => string> 里的一行。
 * 没有校验、没有注册中心、没有 schema 自动发现——调它之前要保证
 * schema 和 handler 手动同步。
 *
 * 注意：生产环境不要用 eval，这里仅作教学演示。
 */
function calc(args: Record<string, unknown>): string {
  const expression = String(args.expression ?? "");
  const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
  try {
    // eslint-disable-next-line no-eval
    return String(eval(sanitized));
  } catch (e) {
    // ch02 设计债 #3：工具抛异常 → 循环直接崩，没有结构化反馈
    return `Error: ${(e as Error).message}`;
  }
}

/* ─── Registry（ch02 的朴素版） ────────────────────────────────── */

/**
 * ch02 的 registry 只有一个工具。
 * 对比 ch04 的 ToolRegistry——这里没有校验、没有 getSchemas() 配对、
 * 没有循环检测。就是最朴素的: (name) => handler 映射。
 */
const registry = new ToolRegistry();
registry.register(
  {
    name: "calc",
    description: "Evaluate an arithmetic expression.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "The expression to evaluate" },
      },
      required: ["expression"],
    },
  },
  calc,
);

/* ─── Mock 响应（两回合对话） ──────────────────────────────────── */

/**
 * MockProvider 按固定顺序返回预设响应。
 * 离线、确定性、零成本——让循环先跑通，再操心真实 API。
 *
 * 两回合：
 *   第 1 回合：模型说要调 calc("2 + 2")
 *   第 2 回合：模型看到结果后给出最终答案
 */
const mock = new MockProvider([
  // 回合 1: 模型要求调工具（ch02 设计债 #1：transcript 里存什么全靠约定）
  new ProviderResponse(
    undefined,                             // text（无文本回答）
    [new ToolCallRef("call-1", "calc", { expression: "2 + 2" })], // toolCalls
  ),
  // 回合 2: 模型给出最终答案
  new ProviderResponse(
    "2 + 2 equals 4.",
  ),
]);

/* ─── 运行 ──────────────────────────────────────────────────────── */

const answer = run(mock, registry, "What is 2 + 2?");

console.log("━━━ ch02: 最小 Agent 循环 ━━━");
console.log(`用户提问: What is 2 + 2?`);
console.log(`模型回答: ${answer}`);
console.log("━━━");
console.log("");
console.log("5 个设计债（ch03 开始逐个还）:");
console.log("  📋 #1 transcript 无类型 — 工具调用和文本在 Record[] 里分不清");
console.log("  🔧 #2 没有注册中心 — schema 和 handler 手动同步");
console.log("  💥 #3 错误直接抛 — 调了不存在工具 → 循环崩");
console.log("  📈 #4 transcript 无线增长 — 迟早撑爆上下文");
console.log("  💰 #5 没有 token 计数 — 不知道花了多少钱");
