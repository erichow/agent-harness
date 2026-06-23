/**
 * 第 1 章 骨架示例 — 验证项目结构
 *
 * 对应设计文档「ch01-skeleton — 工程骨架」
 *
 * 第 1 章只做一件事：搭好 TypeScript 项目骨架，让 `npm install && npm test`
 * 能跑通。之后的每一章都在这个骨架上添加真正的功能。
 *
 * 这个示例验证核心模块能正确导入，并展示项目版本和组件清单。
 *
 * 运行方式：
 *   npx tsx examples/ch01_skeleton.ts
 */

import { VERSION } from "../src/harness/index.js";

console.log("━━━ ch01: 项目骨架验证 ━━━");
console.log(`  agent-harness v${VERSION}`);
console.log("");
console.log("已加载的核心模块：");
console.log("  • agent.ts       — run() / arun() agent 循环");
console.log("  • messages.ts    — Message / Transcript / 4 种 Block");
console.log("  • providers/     — Provider 接口 + Mock / Fallback / Retry");
console.log("  • tools/         — ToolRegistry + Scratchpad + 文件工具");
console.log("  • context/       — ContextAccountant + Compactor");
console.log("  • retrieval/     — DocumentIndex (BM25)");
console.log("  • mcp/           — MCPClient (JSON-RPC over stdio)");
console.log("  • permissions/   — PermissionManager + 策略函数");
console.log("  • plans/         — Plan / PlanHolder / createPlanTools");
console.log("  • observability/ — OpenTelemetry tracing");
console.log("  • evals/         — EvalRunner");
console.log("  • cost/          — BudgetEnforcer + ModelRouter");
console.log("  • checkpoint/    — Checkpointer + resume");
console.log("");
console.log("✅ 项目骨架就绪。可通过 npx tsx examples/chXX_*.ts 运行各章节示例。");
