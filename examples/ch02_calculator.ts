/**
 * 第 2 章 Calculator 示例
 *
 * 模拟一个两回合的对话：
 *   1. 模型请求调用 calc 工具计算 "2 + 2"
 *   2. 模型返回最终答案 "2 + 2 is 4."
 */
import { run } from "../src/harness/agent.js";
import type { ProviderResponse } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";

/**
 * 计算器工具 — 求值一个算数表达式
 * 注意：生产环境不要用 eval，这里仅作教学演示
 */
function calc(args: Record<string, unknown>): string {
  const expression = String(args.expression ?? "");
  // 安全限制：只允许数字和运算符
  const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
  try {
    // eslint-disable-next-line no-eval
    return String(eval(sanitized));
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

// 脚本化的 mock 响应
const mock = new MockProvider([
  {
    kind: "tool_call",
    tool_name: "calc",
    tool_args: { expression: "2 + 2" },
    tool_call_id: "call-1",
  } as ProviderResponse,
  { kind: "text", text: "2 + 2 is 4." } as ProviderResponse,
]);

// 工具 schema（传给模型描述可用工具）
const toolSchemas = [
  {
    name: "calc",
    description: "Evaluate an arithmetic expression.",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string" },
      },
      required: ["expression"],
    },
  },
];

const answer = run(
  mock,
  { calc },
  toolSchemas,
  "What is 2 + 2?",
);

console.log(answer); // → "2 + 2 is 4."
