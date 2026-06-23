/**
 * 第 15 章 Sub-agents 示例 — 子智能体三种模式
 *
 * 对应设计文档「ch15-sub-agents — 子智能体」
 *
 * 设计要点：
 *   1. Sub-agent 是另一个完整的 agent 循环（独立 transcript、工具集、context window）
 *   2. 三种模式：委托、扇出、管线
 *   3. Sub-agent 的结果通过 scratchpad 或直接返回传递给父 agent
 *   4. subagentContext 从 observability 派生子 context
 *
 * 运行方式：
 *   npx tsx examples/ch15_sub_agents.ts
 */

import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse } from "../src/harness/providers/base.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { run } from "../src/harness/agent.js";
import { subagentContext } from "../src/harness/observability/tracing.js";
import type { SessionContext } from "../src/harness/observability/tracing.js";

/* ─── Helper: 创建一个带计算器工具的 registry ──────────────────── */

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "calc",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
    },
    (args) => String((args.a as number) + (args.b as number)),
  );
  registry.register(
    {
      name: "echo",
      description: "Echo back the input text",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
    (args) => `echo: ${args.text}`,
  );
  return registry;
}

/* ─── 模式 1: 委托模式 ──────────────────────────────────────────── */

function demoDelegation(): void {
  console.log("─ 模式 1: 委托模式 ────────────────");
  console.log("   父 agent 把子任务派发给 sub-agent 执行\n");

  // 子 agent 的模拟响应
  const subMock = new MockProvider([
    new ProviderResponse(undefined, [
      { id: "sub-call-1", name: "calc", arguments: { a: 10, b: 20 } },
    ]),
    new ProviderResponse("计算结果: 30"),
  ]);
  const subRegistry = buildRegistry();

  // 模拟 sub-agent 执行
  const subResult = run(subMock, subRegistry, "10 + 20 = ?");

  const parentMock = new MockProvider([
    new ProviderResponse(
      `子 agent 的任务已完成。结果: ${subResult}\n最终答案: 10 + 20 = 30`,
    ),
  ]);
  const parentRegistry = new ToolRegistry();
  const parentResult = run(parentMock, parentRegistry, "请计算 10+20");

  console.log(`   父 agent 提问: "请计算 10+20"`);
  console.log(`   子 agent 结果: ${subResult}`);
  console.log(`   父 agent 回答: ${parentResult}`);
  console.log();
}

/* ─── 模式 2: 扇出模式 ──────────────────────────────────────────── */

function demoFanOut(): void {
  console.log("─ 模式 2: 扇出模式 ────────────────");
  console.log("   多个 sub-agent 并行执行独立任务\n");

  // Sub A: 计算
  const mockA = new MockProvider([
    new ProviderResponse(undefined, [
      { id: "call-a", name: "calc", arguments: { a: 5, b: 3 } },
    ]),
    new ProviderResponse("5 + 3 = 8"),
  ]);
  const resultA = run(mockA, buildRegistry(), "计算 5+3");

  // Sub B: 计算
  const mockB = new MockProvider([
    new ProviderResponse(undefined, [
      { id: "call-b", name: "calc", arguments: { a: 12, b: 7 } },
    ]),
    new ProviderResponse("12 + 7 = 19"),
  ]);
  const resultB = run(mockB, buildRegistry(), "计算 12+7");

  // 父 agent 汇总
  const parentMock = new MockProvider([
    new ProviderResponse(
      `扇出结果汇总:\n  - Sub A: ${resultA}\n  - Sub B: ${resultB}\n  - 总和: 8 + 19 = 27`,
    ),
  ]);
  const parentResult = run(parentMock, new ToolRegistry(), "汇总计算结果");

  console.log(`   Sub A 结果: ${resultA}`);
  console.log(`   Sub B 结果: ${resultB}`);
  console.log(`   父 agent 汇总: ${parentResult}`);
  console.log();
}

/* ─── 模式 3: 管线模式 ──────────────────────────────────────────── */

function demoPipeline(): void {
  console.log("─ 模式 3: 管线模式 ────────────────");
  console.log("   Sub A 的输出 → Sub B 的输入\n");

  // Stage 1: 分析
  const mockA = new MockProvider([
    new ProviderResponse(undefined, [
      { id: "call-a", name: "echo", arguments: { text: "分析: 问题出在数据类型不匹配" } },
    ]),
    new ProviderResponse("分析完成: 数据类型不匹配"),
  ]);
  const stage1 = run(mockA, buildRegistry(), "分析问题原因");

  // Stage 2: 修复（基于 stage1 的输出）
  const mockB = new MockProvider([
    new ProviderResponse(undefined, [
      { id: "call-b", name: "echo", arguments: { text: `基于分析 "${stage1}", 修复方案: 转换数据类型` } },
    ]),
    new ProviderResponse(`修复方案: 在调用处添加类型转换`),
  ]);
  const stage2 = run(mockB, buildRegistry(), `基于分析结果修复: ${stage1}`);

  console.log(`   Stage 1 (分析): ${stage1}`);
  console.log(`   Stage 2 (修复): ${stage2}`);
  console.log();
}

/* ─── subagentContext 演示 ────────────────────────────────────────── */

function demoContext(): void {
  console.log("─ subagentContext 追踪上下文 ────────");

  const parentCtx: SessionContext = {
    sessionId: "ses-001",
    taskId: "task-fix-bug",
    agentId: "main",
  };

  const searcherCtx = subagentContext(parentCtx, "searcher");
  const fixerCtx = subagentContext(parentCtx, "fixer");
  const deepCtx = subagentContext(searcherCtx, "file-reader");

  console.log(`   父 context:        agentId=${parentCtx.agentId}`);
  console.log(`   子 (searcher):     agentId=${searcherCtx.agentId}`);
  console.log(`   子 (fixer):        agentId=${fixerCtx.agentId}`);
  console.log(`   孙 (file-reader):  agentId=${deepCtx.agentId}`);
  console.log(`   所有共享同一 sessionId=${parentCtx.sessionId}`);
  console.log();
}

/* ─── Main ───────────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch15: Sub-agents 子智能体 ━━━\n");

  demoDelegation();
  demoFanOut();
  demoPipeline();
  demoContext();

  console.log("━━━ ✅ Sub-agents 示例完成 ━━━");
  console.log("三种模式:");
  console.log("  1. 委托模式 — 父子一对一");
  console.log("  2. 扇出模式 — 一对多并行");
  console.log("  3. 管线模式 — 串联处理链");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
