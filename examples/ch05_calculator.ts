/**
 * 第 5 章 Calculator 示例 — 流式事件 + async arun
 *
 * 相比第 4 章的变化：
 *   1. 使用 async/await arun() 替代同步 run()
 *   2. onEvent 回调实时打印流式事件
 *   3. ProviderResponse 使用 ToolCallRef 数组
 *
 * 运行方式：
 *   npx tsx examples/ch05_calculator.ts
 */
import { arun } from "../src/harness/agent.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import type { StreamEvent } from "../src/harness/providers/events.js";

// 注册计算器工具
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
  (args) => {
    const expression = String(args.expression ?? "");
    const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
    try {
      // eslint-disable-next-line no-eval
      return String(eval(sanitized));
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
);

// 流式事件回调 — 实时打印每个事件
function onEvent(event: StreamEvent): void {
  switch (event.kind) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "reasoning_delta":
      process.stdout.write(`\x1b[90m${event.text}\x1b[0m`); // 灰色显示 thinking
      break;
    case "tool_call_start":
      console.log(`\n\x1b[33m🔧 Tool: ${event.name} (id: ${event.id})\x1b[0m`);
      break;
    case "tool_call_delta":
      process.stdout.write(event.argsFragment);
      break;
    case "completed":
      console.log(
        `\n\x1b[32m✅ Done — tokens: ${event.inputTokens} in / ${event.outputTokens} out\x1b[0m`,
      );
      break;
  }
}

// Mock 响应 — 使用 ToolCallRef 数组
const mock = new MockProvider([
  new ProviderResponse(undefined, [
    new ToolCallRef("call-1", "calc", { expression: "2 + 2" }),
  ]),
  new ProviderResponse("2 + 2 is 4."),
]);

// 运行 agent（async）
console.log("\x1b[36m━━━ ch05 流式 Calculator ━━━\x1b[0m\n");

const answer = await arun(
  mock,
  registry,
  "What is 2 + 2?",
  undefined,        // transcript
  "You are a helpful assistant with a calculator.",
  onEvent,          // ← ch05 新增：实时事件回调
);

console.log(`\n\x1b[36m━━━ Final answer: ${answer} ━━━\x1b[0m\n`);
