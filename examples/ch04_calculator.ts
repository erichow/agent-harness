/**
 * 第 4 章 Calculator 示例 — 用 ToolRegistry
 *
 * 相比第 3 章的变化：
 *   tools 和 toolSchemas 合并为一个 ToolRegistry
 */
import { run } from "../src/harness/agent.js";
import { ProviderResponse } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

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

// Mock 响应
const mock = new MockProvider([
  new ProviderResponse(undefined, "call-1", "calc", { expression: "2 + 2" }),
  new ProviderResponse("2 + 2 is 4."),
]);

const answer = run(
  mock,
  registry,
  "What is 2 + 2?",
  "You are a helpful assistant with a calculator.",
);

console.log(answer);
