/**
 * 第 7 章 示例 — 上下文窗口记账
 *
 * 对应文档「ch07-context-window — 上下文窗口是一种资源」
 *
 * Agent 每轮对话都会带上历史记录。大多数人第一次接触上下文窗口时
 * 有三个直觉全是错的：
 *   ❌ "窗口大小是固定的" — 模型性能在远没填满前就开始下降
 *   ❌ "消耗是线性的"     — 工具结果占窗口的方式完全不同
 *   ❌ "满了能看出来"     — 模型静默遗忘，不会说"我满了"
 *
 * ContextAccountant 把窗口分 5 类，按红黄绿三色判断状态。
 * 这一章只负责"看"和"报"，不修改对话——第 8 章做压缩。
 *
 * 运行方式：
 *   npx tsx examples/ch07_context_window.ts
 */

import { ContextAccountant, ContextBudget, ContextSnapshot } from "../src/harness/context/accountant.js";
import { Message, Transcript } from "../src/harness/messages.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { arun } from "../src/harness/agent.js";

console.log("━━━ ch07: 上下文窗口记账 ━━━\n");

/* ════════════════════════════════════════════════════════════════════
   1. 5 类组件
   ════════════════════════════════════════════════════════════════════ */

console.log("1. 5 类组件:");
console.log("  system    — 系统提示词（整个 session 不变，通常很小）");
console.log("  tools     — 工具声明（注册了就一直在，100-5000 token）");
console.log("  history   — 对话历史（不断增长——窗口膨胀的主要来源）");
console.log("  retrieved — 临时拉入的外部内容（按需加入，用完可丢）");
console.log("  headroom  — 预留给模型写回答的空间");
console.log("");

/* ════════════════════════════════════════════════════════════════════
   2. 红黄绿三色
   ════════════════════════════════════════════════════════════════════ */

console.log("2. 红黄绿三色状态:");
console.log("  🟢 Green  (≤60%)  — 安全，继续干活");
console.log("  🟡 Yellow (60-80%) — 注意，考虑压缩");  
console.log("  🔴 Red    (>80%)  — 立即压缩，内容已经开始腐烂");
console.log("");

/* ════════════════════════════════════════════════════════════════════
   3. ContextBudget
   ════════════════════════════════════════════════════════════════════ */

console.log("3. ContextBudget — 预算配置:");

const defaultBudget = new ContextBudget();
console.log(`  默认: window=${defaultBudget.windowSize}, headroom=${defaultBudget.headroom}`);
console.log(`        usable=${defaultBudget.usable}, yellow@${defaultBudget.yellowThreshold}, red@${defaultBudget.redThreshold}`);

const customBudget = new ContextBudget(128_000, 2048, 0.5, 0.75);
console.log(`  自定义: window=${customBudget.windowSize}, headroom=${customBudget.headroom}`);
console.log(`         usable=${customBudget.usable}, yellow@${customBudget.yellowThreshold}, red@${customBudget.redThreshold}`);
console.log("");

/* ════════════════════════════════════════════════════════════════════
   4. ContextSnapshot
   ════════════════════════════════════════════════════════════════════ */

console.log("4. ContextSnapshot — 快照判定:");

const snapGreen = new ContextSnapshot(
  { system: 100, tools: 2000, history: 5000, retrieved: 0, headroom: 4096 },
  defaultBudget,
);
console.log(`  🟢 Green:  used=${snapGreen.totalUsed}, util=${(snapGreen.utilization * 100).toFixed(1)}%, state=${snapGreen.state}`);

const snapYellow = new ContextSnapshot(
  { system: 200, tools: 3000, history: 120_000, retrieved: 0, headroom: 4096 },
  defaultBudget,
);
console.log(`  🟡 Yellow: used=${snapYellow.totalUsed}, util=${(snapYellow.utilization * 100).toFixed(1)}%, state=${snapYellow.state}`);

const snapRed = new ContextSnapshot(
  { system: 500, tools: 5000, history: 180_000, retrieved: 0, headroom: 4096 },
  defaultBudget,
);
console.log(`  🔴 Red:    used=${snapRed.totalUsed}, util=${(snapRed.utilization * 100).toFixed(1)}%, state=${snapRed.state}`);
console.log("");

/* ════════════════════════════════════════════════════════════════════
   5. ContextAccountant — transcript 记账
   ════════════════════════════════════════════════════════════════════ */

console.log("5. ContextAccountant — 对 transcript 做快照:");
console.log("");

const accountant = new ContextAccountant();
const transcript = new Transcript("You are a helpful assistant with calculation tools.");

// 初始快照
let snap = accountant.snapshot(transcript);
console.log(`  初始(仅system): system=${snap.totals.system}, history=${snap.totals.history}, state=${snap.state}`);

// 加一条用户消息
transcript.append(Message.userText("What is 2 + 2?"));
snap = accountant.snapshot(transcript);
console.log(`  用户提问后:     history=${snap.totals.history}, total=${snap.totalUsed}, state=${snap.state}`);

// 加工具调用 + 大结果
transcript.append(Message.assistantToolCall({
  kind: "tool_call", id: "c1", name: "calc", args: { expression: "2+2" },
}));
transcript.append(Message.toolResult({
  kind: "tool_result", callId: "c1",
  content: JSON.stringify({ result: 4, explanation: "addition of two and two" }),
  isError: false,
}));
snap = accountant.snapshot(transcript);
console.log(`  工具调用后:     history=${snap.totals.history}, total=${snap.totalUsed}, state=${snap.state}`);

// 加很多消息撑到红色
for (let i = 0; i < 20; i++) {
  transcript.append(Message.userText(`question ${i} `.repeat(100)));
  transcript.append(Message.assistantText(`answer ${i} `.repeat(200)));
}
snap = accountant.snapshot(transcript);
console.log(`  大量对话后:     history=${snap.totals.history}, total=${snap.totalUsed}, state=${snap.state}`);
console.log(`    utilization=${(snap.utilization * 100).toFixed(1)}%`);
console.log("");

/* ════════════════════════════════════════════════════════════════════
   6. Agent 集成 — onSnapshot 回调
   ════════════════════════════════════════════════════════════════════ */

console.log("6. Agent 集成 — 每回合 snapshot 回调:");
console.log("");

const reg = new ToolRegistry();
reg.register(
  { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
  (args) => `echo: ${args.msg}`,
);

const mock = new MockProvider([
  new ProviderResponse(undefined, [new ToolCallRef("c1", "echo", { msg: "hello" })]),
  new ProviderResponse("Done!"),
]);

const snapshots: ContextSnapshot[] = [];

await arun(
  mock, reg, "echo hello",
  undefined, undefined, undefined, undefined, undefined,
  (s) => {
    snapshots.push(s);
    const bar = "█".repeat(Math.round(s.utilization * 40));
    console.log(`  Turn ${snapshots.length}: ${s.state}  (${(s.utilization * 100).toFixed(1)}%) ${bar}`);
  },
);

console.log("");
console.log("  结论: ContextAccountant 纯测量不改数据。");
console.log("  '看问题和解决问题分开' — 第 8 章在红色时触发压缩。");
