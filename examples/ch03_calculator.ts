/**
 * 第 3 章 Calculator 示例 — 类型化消息系统与错误恢复
 *
 * 对应 Confluence 设计文档「ch03-typed-messages — 类型化消息系统与错误恢复」
 *
 * 相比 ch02 的核心变化：
 *   1. Block 是语义单元，不关心谁说的——只存"发生了什么"
 *   2. 4 种 Block 类型：TextBlock / ToolCallBlock / ToolResultBlock / ReasoningBlock
 *   3. Message 的 role 只是传输标记，不是语义
 *   4. try/catch → isError 反馈给模型，不再直接崩溃
 *   5. 不可变历史：Block 只读，只能通过 transcript.append() 追加
 *
 * ch02 → ch03 还了 5 个设计债的前 2 个：
 *   ✅ #1 transcript 无类型 → Block/Message/Transcript 三层架构
 *   ✅ #3 错误直接抛     → try/catch + ToolResultBlock(isError=true)
 *
 * 运行方式：
 *   npx tsx examples/ch03_calculator.ts
 */

import { run } from "../src/harness/agent.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import {
  Message,
  Transcript,
  textBlock,
  toolCallBlock,
  toolResultBlock,
  reasoningBlock,
} from "../src/harness/messages.js";

/* ─── 工具定义 ──────────────────────────────────────────────────── */

function calc(args: Record<string, unknown>): string {
  const expression = String(args.expression ?? "");
  const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
  try {
    // eslint-disable-next-line no-eval
    return String(eval(sanitized));
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

/* ─── Registry ──────────────────────────────────────────────────── */

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

/* ─── 显式构建 Block / Message / Transcript ───────────────────── */

/**
 * ch03 的核心设计：
 *
 * Block（语义单元）       → 不关心谁说的，只存发生了什么
 *   ├─ TextBlock          → 一段文本
 *   ├─ ToolCallBlock      → 模型要调工具 (id / name / args)
 *   ├─ ToolResultBlock    → 工具执行结果 (content / isError)
 *   └─ ReasoningBlock     → 模型推理过程 (text / metadata)
 *
 * Message（有 role 的记录）→ role 只是传输标记，出发时 adapter 映射
 * Transcript（不可变历史） → 只读 block，只能 append()
 */

// 用户的第一条消息：纯文本
const userMsg: Message = new Message("user", [
  textBlock("What is 2 + 2?"),
  // ↑ kind: "text" — 一段文本
]);

// 模型的响应：推理 + 文本 + 工具调用 在同一个 Message 里
const assistantMsg: Message = new Message("assistant", [
  reasoningBlock("User asked an arithmetic question. I need to call the calculator."),
  //  ↑ kind: "reasoning" — 思考过程，调试用（对 DeepSeek R1 / Anthropic Extended Thinking 友好）

  textBlock("Let me calculate that for you."),
  //  ↑ kind: "text" — 说给用户听的话

  toolCallBlock("call-1", "calc", { expression: "2 + 2" }),
  //  ↑ kind: "tool_call" — 要调的工具，id / name / args 明确
]);

// 工具返回的结果（注意 isError = false）
const toolResultMsg: Message = new Message("user", [
  toolResultBlock("call-1", "4", false),
  //  ↑ kind: "tool_result" — 工具执行结果，isError=false 表示正常
]);

// 最终回答
const finalMsg: Message = Message.assistantText("2 + 2 equals 4.");

// 组装 Transcript（不可变历史，只能 append）
const transcript = new Transcript("You are a helpful assistant with a calculator.");
transcript.append(userMsg);
transcript.append(assistantMsg);
transcript.append(toolResultMsg);
transcript.append(finalMsg);

console.log("━━━ ch03: 类型化消息系统 ━━━");
console.log("Transcript 中的消息:");
for (const msg of transcript.messages) {
  console.log(`  [${msg.role}]`);
  for (const block of msg.blocks) {
    const kind = block.kind.padEnd(12);
    switch (block.kind) {
      case "text":
        console.log(`    ${kind} → ${block.text}`);
        break;
      case "tool_call":
        console.log(`    ${kind} → ${block.name}(${JSON.stringify(block.args)})`);
        break;
      case "tool_result":
        console.log(`    ${kind} → content=${block.content.slice(0, 60)} isError=${block.isError}`);
        break;
      case "reasoning":
        console.log(`    ${kind} → ${block.text.slice(0, 60)}...`);
        break;
    }
  }
}

console.log("\n不可变历史:");
console.log("  - 所有 Block 都是 readonly（TypeScript 编译期保证）");
console.log("  - 只能 transcript.append() 追加，不能中间插入");
console.log("  - 想回滚：const snapshot = [...transcript.messages];");

/* ─── 错误恢复演示 ──────────────────────────────────────────────── */

/**
 * ch03 的错误处理：不再直接 throw，而是结构化反馈。
 *
 * 演示：模型调了一个不存在的工具 → 拿到 ToolResultBlock(isError=true)
 * → 下一轮自己修正。
 */
console.log("\n错误恢复:");
console.log("  模型调了不存在的工具 → ToolResultBlock(isError=true)");
console.log("  → 模型在下一轮看到错误，可以重试/换工具/告知用户");
console.log("  → Agent 层不需要写 if-else 错误路由");

// 用 MockProvider 模拟这种场景
const errorMock = new MockProvider([
  // 第 1 回合：模型调了不存在的工具
  new ProviderResponse(
    undefined,
    [new ToolCallRef("call-1", "nonexistent_tool", {})],
  ),
  // 第 2 回合：模型看到 isError，纠正了自己
  new ProviderResponse(
    "I see that tool doesn't exist. Let me use calc instead.",
    [new ToolCallRef("call-2", "calc", { expression: "2 + 2" })],
  ),
  // 第 3 回合：最终回答
  new ProviderResponse("2 + 2 equals 4."),
]);

const errorAnswer = run(errorMock, registry, "calculate 2+2");
console.log(`  结果: ${errorAnswer}`);

/* ─── 模拟多回合对话（展示 transcript 增长） ───────────────────── */

console.log("\n多回合对话（transcript 逐步增长）:");

const multiTurnRegistry = new ToolRegistry();
multiTurnRegistry.register(
  { name: "calc", description: "Calc", inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } },
  (args) => String(eval(String(args.expression ?? "0"))),
);

const multiMock = new MockProvider([
  new ProviderResponse(undefined, [new ToolCallRef("c1", "calc", { expression: "100 + 200" })]),
  new ProviderResponse("300", [new ToolCallRef("c2", "calc", { expression: "300 * 2" })]),
  new ProviderResponse("The answer is 600."),
]);

const multiAnswer = run(multiMock, multiTurnRegistry, "calculate 100+200 then multiply by 2");
console.log(`  多回合结果: ${multiAnswer}`);
