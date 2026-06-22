/**
 * 第 6 章 示例 — 安全工具执行（4 道闸门）
 *
 * 对应 Confluence 设计文档「ch06-safe-tool-execution — 安全工具执行」
 *
 * ch04 的 ToolRegistry 只做了基础校验（必填字段检查）。
 * ch06 在 execute() 中增加了 4 道安全闸门：
 *
 *   ① 工具名存在?       → 否 → "unknown tool. Did you mean 'calc'?"
 *   ② 参数满足 schema?   → 否 → 结构化校验错误（Reflexion 效应）
 *   ③ 连续 3 次相同调用?  → 是 → "tool-call loop detected"
 *   ④ handler 执行       → 异常 → 结构化错误（含工具名+异常类型）
 *
 * 运行方式：
 *   npx tsx examples/ch06_safe_execution.ts
 */

import { ToolRegistry, jsonQueryDefinition, jsonQueryHandler } from "../src/harness/tools/registry.js";

/* ─── 准备 Registry ──────────────────────────────────────────────── */

const registry = new ToolRegistry();

// calc — 算数计算工具
registry.register(
  {
    name: "calc",
    description: "Evaluate an arithmetic expression.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "表达式，如 '2+2'" },
      },
      required: ["expression"],
    },
  },
  (args) => {
    const sanitized = String(args.expression ?? "").replace(/[^0-9+\-*/().%\s]/g, "");
    // eslint-disable-next-line no-eval
    return String(eval(sanitized));
  },
);

// json_query — JSON 查询工具（第 6 章新增示例工具）
registry.register(jsonQueryDefinition, jsonQueryHandler);

console.log("━━━ ch06: 安全工具执行 — 4 道闸门 ━━━\n");

/* ════════════════════════════════════════════════════════════════════
   闸门 1: 工具名存在性检查 + Did you mean?
   ════════════════════════════════════════════════════════════════════ */

console.log("闸门 1 — 工具名存在性检查 + Did you mean?");
console.log("━".repeat(60));

// 模型叫了拼写错误的工具名
const gate1a = registry.execute("calculator", { expression: "2+2" }, "call-1");
console.log(`  calculator → ${gate1a.content}`);

// 完全不相关的名字 — 不提建议
const gate1b = registry.execute("python", {}, "call-2");
console.log(`  python     → ${gate1b.content}`);

// 空 registry 时
const emptyReg = new ToolRegistry();
const gate1c = emptyReg.execute("anything", {}, "call-3");
console.log(`  空 registry → ${gate1c.content}`);

console.log("");

/* ════════════════════════════════════════════════════════════════════
   闸门 2: JSON Schema 校验
   ════════════════════════════════════════════════════════════════════ */

console.log("闸门 2 — JSON Schema 校验（dispatch 前拦截）");
console.log("━".repeat(60));

// 缺必填参数
const gate2a = registry.execute("calc", {}, "call-4");
console.log(`  calc({})                       → ${gate2a.content.slice(0, 100)}`);

// 类型错误（expression 应该是 string，传了 number）
const gate2b = registry.execute("calc", { expression: 42 }, "call-5");
console.log(`  calc({expression: 42})         → ${gate2b.content.slice(0, 100)}`);

// 正确参数 — 通过
const gate2c = registry.execute("calc", { expression: "2+2" }, "call-6");
console.log(`  calc({expression: "2+2"})      → ${gate2c.content}`);

console.log("");

/* ════════════════════════════════════════════════════════════════════
   闸门 3: 循环检测
   ════════════════════════════════════════════════════════════════════ */

console.log("闸门 3 — 循环检测（连续 3 次相同调用 → 换策略）");
console.log("━".repeat(60));

// 创建一个干净的 registry 演示循环
const loopRegistry = new ToolRegistry();
loopRegistry.register(
  {
    name: "calc",
    description: "Calc",
    inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  },
  (args) => String(eval(String(args.expression ?? "0"))),
);

// 连续 4 次调同一个工具、同样的参数
for (let i = 0; i < 4; i++) {
  const r = loopRegistry.execute("calc", { expression: "1+1" }, `loop-call-${i}`);
  if (r.isError) {
    console.log(`  第 ${i + 1} 次: 拦截! → ${r.content.slice(0, 120)}`);
  } else {
    console.log(`  第 ${i + 1} 次: ✅ 正常执行 → ${r.content}`);
  }
}

// 不同参数不会被误判为循环
const noLoopRegistry = new ToolRegistry();
noLoopRegistry.register(
  {
    name: "calc",
    description: "Calc",
    inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  },
  (args) => String(eval(String(args.expression ?? "0"))),
);

console.log("\n  不同参数 → 不会被误判:");
for (let i = 0; i < 5; i++) {
  const r = noLoopRegistry.execute("calc", { expression: `${i}+${i}` }, `nl-call-${i}`);
  console.log(`     calc("${i}+${i}") → ${r.content}`);
}

console.log("");

/* ════════════════════════════════════════════════════════════════════
   闸门 4: 执行 + try/catch
   ════════════════════════════════════════════════════════════════════ */

console.log("闸门 4 — 执行 + try/catch（异常不崩）");
console.log("━".repeat(60));

const faultyRegistry = new ToolRegistry();
faultyRegistry.register(
  { name: "faulty", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  () => { throw new Error("kaboom"); },
);

const gate4 = faultyRegistry.execute("faulty", {}, "call-7");
console.log(`  faulty()          → ${gate4.content}`);
console.log(`  isError = ${gate4.isError}`);

console.log("");

/* ════════════════════════════════════════════════════════════════════
   json_query 工具展示
   ════════════════════════════════════════════════════════════════════ */

console.log("json_query — 第 6 章新增示例工具");
console.log("━".repeat(60));

const jqRegistry = new ToolRegistry();
jqRegistry.register(jsonQueryDefinition, jsonQueryHandler);

const jq1 = jqRegistry.execute("json_query", {
  data: JSON.stringify({ user: { name: "Alice", age: 30 } }),
  path: "user.name",
}, "jq-1");
console.log(`  json_query({data: '{user: {name: "Alice"}}', path: "user.name"}) → ${jq1.content}`);

const jq2 = jqRegistry.execute("json_query", {
  data: JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }),
  path: "items.1.id",
}, "jq-2");
console.log(`  json_query(path: "items.1.id") → ${jq2.content}`);

const jq3 = jqRegistry.execute("json_query", {
  data: "not json",
  path: "x",
}, "jq-3");
console.log(`  json_query(data: "not json")  → ${jq3.content}`);

console.log("");

/* ════════════════════════════════════════════════════════════════════
   总结：4 道闸门全流程
   ════════════════════════════════════════════════════════════════════ */

console.log("━━━ 4 道闸门总结 ━━━");
console.log("");
console.log("  ① 工具名存在?          → 不存在 → unknown tool + Did you mean");
console.log("  ② 参数满足 schema?      → 不满足 → 结构化校验错误");
console.log("  ③ 连续 3 次相同调用?    → 是 → loop detected");
console.log("  ④ handler 执行?         → 异常 → 捕获后结构化错误回传");
console.log("");
console.log("  效果：错误的参数永远不会到达 handler，");
console.log("  卡住的模型不会浪费 token 原地转圈，");
console.log("  拼错名字会被轻轻推一把而不是冷冰冰地拒绝。");
