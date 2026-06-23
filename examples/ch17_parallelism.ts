/**
 * 第 17 章 Parallelism 示例 — 并行执行与共享状态
 *
 * 对应设计文档「ch17-parallelism — 并行与共享状态」
 *
 * 设计要点：
 *   1. 扇出模式：多个 sub-agent 并行执行
 *   2. Scratchpad 作为 sub-agent 之间的数据共享通道
 *   3. Promise.all 实现真正的并行（wall-clock 时间 = 最慢的那个）
 *   4. token 消耗不变，但实时时间缩短
 *
 * 运行方式：
 *   npx tsx examples/ch17_parallelism.ts
 */

import { run } from "../src/harness/agent.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse } from "../src/harness/providers/base.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { Scratchpad } from "../src/harness/tools/scratchpad.js";
import * as fs from "node:fs";

const SCRATCH_DIR = ".ex17-scratchpad";

/* ─── 清理 ──────────────────────────────────────────────────────── */

function cleanup(): void {
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

interface SearchResult {
  name: string;
  result: string;
  durationMs: number;
}

/* ─── Helper: 模拟一个 sub-agent 搜索任务 ───────────────────────── */

function runSearch(
  name: string,
  task: string,
  toolResult: string,
  registry: ToolRegistry,
): SearchResult {
  const start = Date.now();

  const mock = new MockProvider([
    new ProviderResponse(undefined, [
      { id: `call-${name}`, name: "echo", arguments: { text: toolResult } },
    ]),
    new ProviderResponse(`[${name}] ${toolResult}`),
  ]);

  const answer = run(mock, registry, task);
  return { name, result: answer, durationMs: Date.now() - start };
}

/* ─── 演示 ──────────────────────────────────────────────────────── */

async function main() {
  cleanup();
  console.log("━━━ ch17: 并行执行 ━━━\n");

  // 1. 串行 vs 并行对比
  console.log("─ 1. 串行 vs 并行 ────────────────────");
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "echo",
      description: "Echo text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    (args) => `echo: ${args.text}`,
  );

  // 串行执行
  console.log("   串行执行 3 个任务:");
  const serialStart = Date.now();
  const s1 = runSearch("search-A", "搜索 TypeScript 文档", "TypeScript 是 JS 的超集", registry);
  const s2 = runSearch("search-B", "搜索 Rust 文档", "Rust 是系统编程语言", registry);
  const s3 = runSearch("search-C", "搜索 Agent 文档", "Agent 是 AI 系统", registry);
  const serialDuration = Date.now() - serialStart;

  console.log(`     ${s1.name}: ${s1.result} (${s1.durationMs}ms)`);
  console.log(`     ${s2.name}: ${s2.result} (${s2.durationMs}ms)`);
  console.log(`     ${s3.name}: ${s3.result} (${s3.durationMs}ms)`);
  console.log(`     串行总耗时: ${serialDuration}ms`);
  console.log();

  // 并行执行
  console.log("   并行执行 3 个任务 (Promise.all):");
  const parallelStart = Date.now();
  const results = await Promise.all([
    Promise.resolve(runSearch("search-X", "搜索 Python 文档", "Python 是动态语言", registry)),
    Promise.resolve(runSearch("search-Y", "搜索 Go 文档", "Go 是编译型语言", registry)),
    Promise.resolve(runSearch("search-Z", "搜索 JS 文档", "JS 是脚本语言", registry)),
  ]);
  const parallelDuration = Date.now() - parallelStart;

  for (const r of results) {
    console.log(`     ${r.name}: ${r.result} (${r.durationMs}ms)`);
  }
  console.log(`     并行总耗时: ${parallelDuration}ms`);
  console.log(`     加速比: ${(serialDuration / Math.max(parallelDuration, 1)).toFixed(1)}x`);
  console.log();

  // 2. Scratchpad 共享状态
  console.log("─ 2. 通过 Scratchpad 共享状态 ────────");
  const pad = new Scratchpad(SCRATCH_DIR);

  // 模拟 sub-agent A 写入发现
  const padA = new Scratchpad(SCRATCH_DIR);
  padA.write("search-results", "发现 3 个相关 issue: #101, #204, #309");
  console.log(`   Sub-agent A 写入: search-results`);

  // 模拟 sub-agent B 写入发现
  const padB = new Scratchpad(SCRATCH_DIR);
  padB.write("doc-summary", "官方文档指出 retry 策略在 src/providers/ 目录");
  console.log(`   Sub-agent B 写入: doc-summary`);

  // 父 agent 读取汇总
  const padParent = new Scratchpad(SCRATCH_DIR);
  const allKeys = padParent.list();
  console.log(`   父 agent 读取所有 key: ${JSON.stringify(allKeys)}`);
  console.log(`     read("search-results") → ${padParent.read("search-results")}`);
  console.log(`     read("doc-summary") → ${padParent.read("doc-summary")}`);
  console.log();

  // 3. 扇出模式概念图
  console.log("─ 3. 扇出模式结构 ────────────────────");
  console.log("   父 Agent (协调者)");
  console.log("      ├── Sub A: 搜索文档 ──→ scratchpad['search-results']");
  console.log("      ├── Sub B: 分析代码 ──→ scratchpad['code-analysis']");
  console.log("      └── Sub C: 运行测试 ──→ scratchpad['test-results']");
  console.log("      ↓");
  console.log("   父 Agent 综合 A + B + C 的结果 → 最终回答");

  cleanup();
  console.log("\n━━━ ✅ Parallelism 示例完成 ━━━");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
