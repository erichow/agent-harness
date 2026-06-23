/**
 * 第 18 章 Observability 示例 — 可观测性追踪
 *
 * 对应设计文档「ch18-observability — 可观测性」
 *
 * 设计要点：
 *   1. OpenTelemetry trace，不是扁平 log
 *   2. Span 保留父子关系：agent.run → agent.turn → gen_ai.completion
 *   3. 标准化属性：gen_ai.usage.input_tokens
 *   4. Exporter 可插拔：console / Jaeger / Langfuse / Honeycomb
 *   5. 薄 wrapper API 而非散落打点
 *
 * 此示例使用 ConsoleSpanExporter，输出到控制台。
 *
 * 运行方式：
 *   npx tsx examples/ch18_observability.ts
 */

import { setupTracing, span, subagentContext, runWithContext } from "../src/harness/observability/tracing.js";
import type { SessionContext } from "../src/harness/observability/tracing.js";

/* ─── 初始化追踪（ConsoleSpanExporter） ─────────────────────────── */

setupTracing("ch18-demo");

/* ─── 模拟一个 agent turn ──────────────────────────────────────── */

async function simulateToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  return span("tool.execute", async (s) => {
    s.setAttribute("tool.name", name);
    s.setAttribute("tool.args", JSON.stringify(args));
    // 模拟工具执行
    await new Promise((r) => setTimeout(r, 50));
    return `${name} returned: success`;
  });
}

async function simulateLlmCall(tokens: number): Promise<string> {
  return span("gen_ai.completion", async (s) => {
    s.setAttribute("gen_ai.usage.input_tokens", tokens);
    s.setAttribute("gen_ai.usage.output_tokens", Math.floor(tokens / 3));
    s.setAttribute("gen_ai.model", "claude-sonnet-4-6");
    await new Promise((r) => setTimeout(r, 100));
    return "LLM response: The answer is 42";
  });
}

async function simulateAgentTurn(turnNumber: number): Promise<string> {
  return span(`agent.turn`, async (s) => {
    s.setAttribute("turn.number", turnNumber);
    s.setAttribute("turn.type", "tool_call");

    // LLM 调用
    const llmResult = await simulateLlmCall(1500);

    // 工具调用
    const toolResult = await simulateToolCall("calc", { expression: "6 * 7" });

    return `${llmResult}\n${toolResult}`;
  });
}

/* ─── Main ──────────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch18: Observability 可观测性 ━━━\n");
  console.log("（追踪数据通过 ConsoleSpanExporter 输出到 stderr）\n");

  // 1. 根 span — 模拟 agent 执行
  console.log("─ 1. Agent run span ──────────────────");

  await span("agent.run", async (s) => {
    s.setAttribute("agent.name", "ch18-demo");
    s.setAttribute("agent.session_id", "ses-demo-001");

    // Turn 1
    await simulateAgentTurn(1);

    // Turn 2
    await simulateAgentTurn(2);

    // Turn 3
    await simulateAgentTurn(3);
  });

  console.log("\n   以上 stderr 中应看到: agent.run → 3× agent.turn → gen_ai.completion + tool.execute 的 span 树\n");

  // 2. subagentContext — 子 agent 追踪上下文
  console.log("─ 2. subagentContext ──────────────────");

  const parentCtx: SessionContext = {
    sessionId: "ses-002",
    taskId: "task-code-review",
    agentId: "main",
  };

  const searchCtx = subagentContext(parentCtx, "code-searcher");
  const reviewCtx = subagentContext(parentCtx, "code-reviewer");

  console.log(`   父 agent:  ${parentCtx.agentId}`);
  console.log(`   子 agent:  ${searchCtx.agentId}`);
  console.log(`   子 agent:  ${reviewCtx.agentId}`);
  console.log(`   共 session: ${searchCtx.sessionId}\n`);

  // 3. runWithContext — 在指定上下文中执行
  console.log("─ 3. runWithContext ───────────────────");

  await runWithContext(searchCtx, async () => {
    await span("search.tool_call", async (s) => {
      s.setAttribute("search.query", "retry pattern");
      await new Promise((r) => setTimeout(r, 30));
    });
  });

  console.log("\n   以上 stderr 中应看到 search.tool_call span 的 agentId 为 'code-searcher'\n");

  // 4. 追踪架构总结
  console.log("─ 4. 追踪架构 ────────────────────────");
  console.log("   agent.run (根 span)");
  console.log("     ├── agent.turn #1");
  console.log("     │     ├── gen_ai.completion (LLM 调用)");
  console.log("     │     └── tool.execute (工具执行)");
  console.log("     ├── agent.turn #2");
  console.log("     │     ├── gen_ai.completion");
  console.log("     │     └── tool.execute");
  console.log("     └── agent.turn #3");
  console.log("           ├── gen_ai.completion");
  console.log("           └── tool.execute");
  console.log("");
  console.log("   Exporter 可插拔：console → Jaeger → Langfuse → Honeycomb (代码不变)");
  console.log("   标准化属性：gen_ai.usage.input_tokens / gen_ai.model / tool.name");

  console.log("\n━━━ ✅ Observability 示例完成 ━━━");
  console.log("💡 追踪数据已通过 ConsoleSpanExporter 输出到 stderr。");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
