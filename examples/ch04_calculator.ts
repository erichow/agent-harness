/**
 * 第 4 章 Calculator 示例 — 工具注册中心与参数校验
 *
 * 对应 Confluence 设计文档「ch04-tool-registry — 工具注册中心与参数校验」
 *
 * 相比 ch03 的核心变化：
 *   1. tools + toolSchemas 合并为 ToolRegistry — 一个对象管 schema、执行和校验
 *   2. register(schema, handler) 一次绑定，不会错位
 *   3. 调用前自动校验必填字段（从 JSON Schema required 推导）
 *   4. 工具不存在或抛异常 → registry.execute() 代劳 try/catch
 *
 * ch02 → ch04 还了 3 个设计债：
 *   ✅ #1 transcript 无类型     → ch03 已修 (Block/Message/Transcript)
 *   ✅ #2 没有注册中心          → ch04 修 (ToolRegistry)
 *   ✅ #3 错误直接抛            → ch03+ch04 修 (try/catch + registry.execute)
 *
 * 运行方式：
 *   npx tsx examples/ch04_calculator.ts
 */

import { run } from "../src/harness/agent.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

/* ─── 注册工具（一次绑定，不会错位） ───────────────────────────── */

/**
 * ToolRegistry.register(schema, handler) 一次调用绑定两者。
 *
 * ch03 的问题：
 *   const tools = { calc: (args) => eval(args.expression) };
 *   const toolSchemas = [ { name: "calc", description: "...", input_schema: {...} } ];
 *   run(provider, tools, toolSchemas, question);
 *   // 改工具名 → 要同步改两个地方 → 容易漏
 *
 * ch04 的解法：
 *   registry.register(schema, handler);
 *   run(provider, registry, question);
 *   // schema 和 handler 用同一个 name 索引，不会错位
 */
const registry = new ToolRegistry();
registry.register(
  {
    name: "calc",
    description: "Evaluate an arithmetic expression.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The arithmetic expression to evaluate (e.g. '2+2')",
        },
      },
      required: ["expression"],
      // ↑ 必填字段 — registry 会自动校验
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

// 注册第二个工具演示多工具场景
registry.register(
  {
    name: "echo",
    description: "Echo back a message.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message to echo back",
        },
      },
      required: ["message"],
    },
  },
  (args) => `You said: ${args.message}`,
);

console.log("━━━ ch04: 工具注册中心 ━━━");
console.log("");

/* ─── Registry 的三件事 ────────────────────────────────────────── */

// 1. getSchemas() — 给 provider 描述可用工具
const schemas = registry.getSchemas();
console.log("1. getSchemas() — 给 provider 看的工具描述:");
schemas.forEach((s) => {
  console.log(`   - ${s.name}: ${s.description}`);
});

// 2. execute() — 调 handler + 校验
console.log("\n2. execute() — 执行工具 + 自动校验:");

// 正常调用
const result1 = registry.execute("calc", { expression: "2 + 2" }, "call-1");
console.log(`   calc("2 + 2") → ${result1.content}`);

// 缺必填参数 → 自动校验失败
const result2 = registry.execute("calc", {}, "call-2");
console.log(`   calc({}) → [ERROR] ${result2.content.slice(0, 80)}`);

// 不存在的工具 → 自动捕获
const result3 = registry.execute("nonexistent", {}, "call-3");
console.log(`   nonexistent() → [ERROR] ${result3.content.slice(0, 80)}`);

// 3. has() / list()
console.log("\n3. has() / list() — 查询和管理:");
console.log(`   has("calc") = ${registry.has("calc")}`);
console.log(`   list() = ${JSON.stringify(registry.list())}`);

/* ─── Agent 集成 ────────────────────────────────────────────────── */

/**
 * 对比 ch02/ch03：
 *   ch02: run(mock, { calc }, [schemas], "question")
 *   ch03: run(mock, { calc }, [schemas], "question", system)
 *   ch04: run(mock, registry, "question", system)
 *         ↑ 两个参数合并为一个
 */
console.log("\n4. Agent 集成 — run() 参数从 5 个减到 4 个:");
console.log(`   ch02: run(mock, tools, schemas, question)         — 5 params`);
console.log(`   ch03: run(mock, tools, schemas, question, system) — 5 params`);
console.log(`   ch04: run(mock, registry, question, system)       — 4 params ✅`);

const mock = new MockProvider([
  // 第 1 回合：模型说要调 calc
  new ProviderResponse(
    undefined,
    [new ToolCallRef("call-1", "calc", { expression: "2 + 2" })],
  ),
  // 第 2 回合：最终答案
  new ProviderResponse("2 + 2 = 4"),
]);

const answer = run(mock, registry, "What is 2 + 2?", "You are a helpful assistant.");
console.log(`\n   用户提问: What is 2 + 2?`);
console.log(`   模型回答: ${answer}`);

/* ─── 校验演示 ──────────────────────────────────────────────────── */

console.log("\n\n5. 参数校验演示（自动从 JSON Schema 推导）:");

// 场景：模型传了错误参数，校验在前端拦截，不会到达 handler
const schemaDemoRegistry = new ToolRegistry();
schemaDemoRegistry.register(
  {
    name: "greet",
    description: "Greet someone by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    },
  },
  (args) => `Hello, ${args.name}!${args.age !== undefined ? ` You are ${args.age}.` : ""}`,
);

// 正确调用
const ok = schemaDemoRegistry.execute("greet", { name: "Alice", age: 30 }, "c1");
console.log(`   greet({name:"Alice", age:30}) → ${ok.content}`);

// 缺必填 name
const bad1 = schemaDemoRegistry.execute("greet", { age: 30 }, "c2");
console.log(`   greet({age:30}) → [ERROR] ${bad1.content.slice(0, 80)}`);

// 类型错误（name 应该是 string，传了 number）
const bad2 = schemaDemoRegistry.execute("greet", { name: 42 }, "c3");
console.log(`   greet({name:42}) → [ERROR] ${bad2.content.slice(0, 80)}`);

console.log("\n对比 ch02：错误的参数永远不会到达 handler ✅");
console.log("   ch02 等函数抛出 TypeError 才发现，ch04 在 dispatch 前就拦截");
