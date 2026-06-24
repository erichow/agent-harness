/**
 * 第 26 章代码分析示例 — AST 解析、依赖分析、复杂度、模式搜索、安全扫描
 *
 * 对应设计文档「ch26-code-analysis.md」
 *
 * 展示 5 个代码分析工具：
 *   1. parse_ast              — 解析文件 AST 输出结构概览
 *   2. analyze_dependencies   — 分析 import/require 依赖图
 *   3. analyze_complexity     — 计算圈复杂度（McCabe 度量）
 *   4. find_patterns          — 按 AST 结构模板搜索代码模式
 *   5. scan_security          — 安全扫描
 *
 * 运行方式：
 *   npx tsx examples/ch26_code_analysis.ts
 */

import { createCodeAnalysisTools } from "../src/harness/tools/code_analysis.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/* ─── 分析目标（使用项目自己的源文件，保证内容真实） ──────────── */

const TARGET_FILE = "src/harness/tools/code_analysis.ts";
const COMPLEXITY_FILE = "src/harness/tools/files.ts";
const PATTERNS_DIR = "src/harness/tools";

/* ─── 主流程 ──────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch26: 代码分析工具 ━━━\n");

  const tools = createCodeAnalysisTools(projectRoot);
  const byName = (name: string) => tools.find(t => t.definition.name === name)!;

  // ── 1. parse_ast ──────────────────────────────────────────────

  console.log("─ 1. parse_ast ──────────────────────────");
  console.log(`   分析文件结构: ${TARGET_FILE}\n`);

  const ast = await byName("parse_ast").asyncHandler!({
    file: TARGET_FILE,
    depth: 1,
  });
  console.log(ast);
  console.log();

  // ── 2. analyze_dependencies ───────────────────────────────────

  console.log("─ 2. analyze_dependencies ───────────────");
  console.log(`   分析依赖关系: ${TARGET_FILE}\n`);

  const deps = await byName("analyze_dependencies").asyncHandler!({
    file: TARGET_FILE,
    depth: 0,
  });
  console.log(deps);
  console.log();

  // ── 3. analyze_complexity ─────────────────────────────────────

  console.log("─ 3. analyze_complexity ─────────────────");
  console.log(`   分析圈复杂度: ${COMPLEXITY_FILE}\n`);

  const complexity = await byName("analyze_complexity").asyncHandler!({
    file: COMPLEXITY_FILE,
    threshold: 0,
  });
  console.log(complexity);
  console.log();

  // ── 4. find_patterns ──────────────────────────────────────────

  console.log("─ 4. find_patterns ───────────────────────");
  console.log(`   搜索 console.log 模式: ${PATTERNS_DIR}\n`);

  const patterns = await byName("find_patterns").asyncHandler!({
    pattern: "console-log",
    path: PATTERNS_DIR,
  });
  console.log(patterns);
  console.log();

  console.log(`   搜索 todo-comment 模式: ${PATTERNS_DIR}\n`);

  const todos = await byName("find_patterns").asyncHandler!({
    pattern: "todo-comment",
    path: PATTERNS_DIR,
  });
  console.log(todos);
  console.log();

  // ── 5. scan_security ──────────────────────────────────────────

  console.log("─ 5. scan_security ───────────────────────");
  console.log(`   安全扫描: ${PATTERNS_DIR} (error severity)\n`);

  const security = await byName("scan_security").asyncHandler!({
    path: PATTERNS_DIR,
    severity: "warning",
  });
  console.log(security);
  console.log();

  console.log("━━━ ✅ 代码分析示例完成 ━━━");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
