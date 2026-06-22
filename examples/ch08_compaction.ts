/**
 * 第 8 章 示例 — 压缩（Compaction）
 *
 * 对应文档「ch08-compaction — 压缩」
 *
 * 第 7 章能看上下文窗口了，但看到红色不等于解决红色。
 * 第 8 章在红色时自动压缩窗口内容，腾出空间。
 *
 * 两级压缩策略（先便宜再贵）：
 *   1. 【Masking】遮蔽旧 tool_result 内容 — 免费、可逆、字符串操作
 *   2. 【Summarization】LLM 总结对话前缀 — 有损、贵、不可逆
 *
 * 运行方式：
 *   npx tsx examples/ch08_compaction.ts
 */

import { maskOlderResults } from "../src/harness/context/masking.js";
import { summarizePrefix } from "../src/harness/context/summarizer.js";
import { ContextAccountant, ContextBudget } from "../src/harness/context/accountant.js";
import type { ContextSnapshot } from "../src/harness/context/accountant.js";
import { Compactor } from "../src/harness/context/compactor.js";
import type { CompactionResult } from "../src/harness/context/compactor.js";
import { Message, Transcript } from "../src/harness/messages.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { arun } from "../src/harness/agent.js";

console.log("━━━ ch08: 压缩（Compaction）━━━\n");

/* ════════════════════════════════════════════════════════════════════
   1. 第一级：Masking — 遮蔽旧 tool_result
   ════════════════════════════════════════════════════════════════════ */

console.log("1. 第一级压缩 — 遮蔽 (Masking)");
console.log("   免费、可逆、字符串操作 — 大多数情况下就够用");
console.log("");

function makeTranscriptWithResults(count: number): Transcript {
  const t = new Transcript("You are a helpful assistant.");
  for (let i = 0; i < count; i++) {
    t.append(Message.assistantToolCall({
      kind: "tool_call", id: `c-${i}`, name: "search",
      args: { query: `query-${i}` },
    }));
    t.append(Message.toolResult({
      kind: "tool_result", callId: `c-${i}`,
      content: `result-${i}: ${"A".repeat(500)}`, // 每个结果 ~500 字符
      isError: false,
    }));
  }
  return t;
}

// 10 个工具结果
const t1 = makeTranscriptWithResults(10);
const accountant = new ContextAccountant();

console.log(`  Masking 前: ${t1.messages.length} 条消息`);

const snapBefore = accountant.snapshot(t1);
console.log(`  总 token (history): ${snapBefore.totals.history}`);

// 执行 masking（保留最近 3 条）
const freed = maskOlderResults(t1, 3);
const snapAfter = accountant.snapshot(t1);
console.log(`  释放 token: ${freed}`);
console.log(`  Masking 后 token: ${snapAfter.totals.history}`);

// 展示遮蔽效果
let maskedCount = 0;
let keptCount = 0;
for (const msg of t1.messages) {
  for (const block of msg.blocks) {
    if (block.kind === "tool_result") {
      if (block.content.startsWith("[tool_result elided")) {
        maskedCount++;
        console.log(`  [遮蔽] call_id=${block.callId}: "${block.content.slice(0, 80)}..."`);
      } else {
        keptCount++;
      }
    }
  }
}
console.log(`  结果: ${maskedCount} 条被遮蔽, ${keptCount} 条保留`);

// 幂等性演示
const freed2 = maskOlderResults(t1, 3);
console.log(`  第二次 Masking 释放: ${freed2}（0 = 幂等）`);
console.log("");

/* ════════════════════════════════════════════════════════════════════
   2. 第二级：Summarization — LLM 总结
   ════════════════════════════════════════════════════════════════════ */

console.log("2. 第二级压缩 — 总结 (Summarization)");
console.log("   有损、不可逆、需要 LLM 调用 — 遮蔽不够时再用");
console.log("");

const t2 = new Transcript("system prompt");
t2.append(Message.userText("anchor — initial goal"));  // msg[0] — 保留的锚点
t2.append(Message.userText("turn 1: what is 2+2?"));   // msg[1]
t2.append(Message.assistantText("response: 4"));       // msg[2]
t2.append(Message.userText("turn 2: multiply by 3?")); // msg[3]
t2.append(Message.assistantText("response: 12"));      // msg[4]
t2.append(Message.userText("turn 3: square it?"));     // msg[5]
t2.append(Message.assistantText("response: 144"));     // msg[6] — 保留 (最近)

console.log(`  Summarization 前: ${t2.messages.length} 条消息`);

const summaryProvider = new MockProvider([
  new ProviderResponse(
    "User asked arithmetic questions: 2+2=4, then (2+2)*3=12, then 12^2=144.",
  ),
]);
const summaryResult = await summarizePrefix(t2, summaryProvider, 2);

if (summaryResult) {
  console.log(`  总结替换了 ${summaryResult.turnsReplaced} 轮对话`);
  console.log(`  总结文本: "${summaryResult.summaryText}"`);
  console.log(`  Summarization 后: ${t2.messages.length} 条消息`);
  console.log(`  msg[1] 内容: "${t2.messages[1].blocks[0].kind === "text" ? (t2.messages[1].blocks[0] as any).text : "?"}"`);
} else {
  console.log("  无需总结（消息不够）");
}
console.log("");

/* ════════════════════════════════════════════════════════════════════
   3. Compactor — 两级压缩协调者
   ════════════════════════════════════════════════════════════════════ */

console.log("3. Compactor — 两级压缩协调者");
console.log("   先遮蔽（免费），不够再总结（付费）");
console.log("");

// 绿色状态 — 不触发压缩
const greenAccountant = new ContextAccountant(new ContextBudget(200_000, 4096, 0.6, 0.8));
const greenCompactor = new Compactor(greenAccountant, summaryProvider);
const greenTranscript = new Transcript("system");
greenTranscript.append(Message.userText("hello"));
greenTranscript.append(Message.assistantText("world"));

const greenResult = await greenCompactor.compactIfNeeded(greenTranscript, []);
console.log(`  🟢 Green 状态: finalState=${greenResult.finalState}, freed=${greenResult.maskingTokensFreed}`);

// 红色状态 — 触发压缩
const tinyBudget = new ContextBudget(200_000, 4096, 0.6, 0.005); // red at 0.5% ≈ 980 tokens
const redAccountant = new ContextAccountant(tinyBudget);
// 给压缩器独立的 provider（之前的 summaryProvider 已被消耗）
const redSummaryProvider = new MockProvider([
  new ProviderResponse("User searched for various topics. Results included large data."),
]);
const redCompactor = new Compactor(redAccountant, redSummaryProvider);
const redTranscript = new Transcript("system");

// 加很多大工具结果使其红色
for (let i = 0; i < 10; i++) {
  redTranscript.append(Message.assistantToolCall({
    kind: "tool_call", id: `c-${i}`, name: "search", args: { q: "x" },
  }));
  redTranscript.append(Message.toolResult({
    kind: "tool_result", callId: `c-${i}`,
    content: "X".repeat(5000), isError: false,
  }));
}

const redSnap = redAccountant.snapshot(redTranscript);
console.log(`  🔴 Red 触发: utilization=${(redSnap.utilization * 100).toFixed(1)}%`);

const redResult = await redCompactor.compactIfNeeded(redTranscript, []);
console.log(`  压缩结果: ${redResult.finalState}, maskingFreed=${redResult.maskingTokensFreed}`);
if (redResult.summarizationTurnsReplaced > 0) {
  console.log(`           summarizationReplaced=${redResult.summarizationTurnsReplaced} turns`);
}
console.log("");

/* ════════════════════════════════════════════════════════════════════
   4. Agent 集成 — onCompaction 回调
   ════════════════════════════════════════════════════════════════════ */

console.log("4. Agent 集成 — 压缩回调:");
console.log("");

const reg = new ToolRegistry();
reg.register(
  { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
  (args) => `echo: ${args.msg}`,
);

const bigSystem = "x".repeat(500); // ~125 tokens
const tinyBud = new ContextBudget(300, 20, 0.3, 0.4); // usable=280, red at 112
const acct = new ContextAccountant(tinyBud);
// 给 agent 集成测试用的独立压缩 provider
const agentSummaryProvider = new MockProvider([
  new ProviderResponse("Summary of the conversation."),
]);
const compactor = new Compactor(acct, agentSummaryProvider);

const agentMock = new MockProvider([
  new ProviderResponse(undefined, [new ToolCallRef("c1", "echo", { msg: "hi" })]),
  new ProviderResponse("Done!"),
]);

const compactions: CompactionResult[] = [];

await arun(
  agentMock, reg, "Hello!",
  undefined, bigSystem,
  undefined, undefined, undefined,
  (s) => console.log(`  Snapshot: state=${s.state}, util=${(s.utilization * 100).toFixed(1)}%`),
  acct,
  compactor,
  (r) => {
    compactions.push(r);
    console.log(`  Compression: ${r.finalState}, freed=${r.maskingTokensFreed} tokens`);
  },
);

console.log(`\n  共触发 ${compactions.length} 次压缩`);
console.log("");

/* ════════════════════════════════════════════════════════════════════
   总结
   ════════════════════════════════════════════════════════════════════ */

console.log("━━━ 两级压缩策略总结 ━━━");
console.log("");
console.log("  第一级: Masking（遮蔽旧工具结果）");
console.log("    - 字符串操作，免费、可逆、幂等");
console.log("    - 保留 call_id 和原始 token 数，agent 可重跑工具恢复");
console.log("    - 大多数红色场景就此解决");
console.log("");
console.log("  第二级: Summarization（LLM 总结对话前缀）");
console.log("    - 有损、不可逆、需要一次 LLM 调用");
console.log("    - 保留锚点（第 1 条 user message）+ 最近 N 轮");
console.log("    - 遮蔽不够时才上");
console.log("");
console.log("  先拉便宜的杠杆，不够再拉贵的。");
