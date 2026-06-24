/**
 * 第 27 章示例 — 扩展文件系统工具
 *
 * 对应设计文档「ch27-extended-filesystem.md」
 *
 * 展示 6 个扩展文件系统工具：
 *   1. create_file       — 创建新文件
 *   2. delete_file       — 删除文件
 *   3. list_directory    — 浏览目录结构
 *   4. glob_files        — 按模式搜索文件
 *   5. get_file_info     — 文件元信息
 *   6. search_in_files   — 文件内容搜索
 *
 * 运行方式：
 *   npx tsx examples/ch27_extended_filesystem.ts
 */
import { createExtendedFilesystemTools } from "../src/harness/tools/extended_filesystem.js";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/* ─── 辅助：临时工作目录 ──────────────────────────────────────── */

const WORK_DIR = path.join(projectRoot, "examples", "__ch27_work");

function setupWorkDir(): void {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  // Create initial files
  fs.writeFileSync(path.join(WORK_DIR, "greet.ts"), [
    "// greet.ts",
    "export function greet(name: string): string {",
    '  return `Hello, ${name}!`;',
    "}",
    "",
  ].join("\n"), "utf-8");

  fs.writeFileSync(path.join(WORK_DIR, "calc.ts"), [
    "// calc.ts",
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function multiply(a: number, b: number): number {",
    "  return a * b;",
    "}",
    "",
  ].join("\n"), "utf-8");

  fs.writeFileSync(path.join(WORK_DIR, "data.json"), JSON.stringify({
    app: "demo",
    version: "1.0.0",
  }, null, 2), "utf-8");

  // Create a subdirectory
  const subDir = path.join(WORK_DIR, "lib");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "utils.ts"), [
    "// lib/utils.ts",
    "export function capitalize(s: string): string {",
    "  return s.charAt(0).toUpperCase() + s.slice(1);",
    "}",
    "",
  ].join("\n"), "utf-8");
}

function cleanupWorkDir(): void {
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

/* ─── 主流程 ──────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch27: 扩展文件系统工具 ━━━\n");

  setupWorkDir();
  const tools = createExtendedFilesystemTools();
  const byName = (name: string) => tools.find(t => t.definition.name === name)!;

  try {
    // ── 1. list_directory ───────────────────────────────────────

    console.log("─ 1. list_directory ─────────────────────");
    console.log("   浏览工作目录结构 (depth=2)\n");

    const listing = await byName("list_directory").asyncHandler!({
      path: WORK_DIR,
      depth: 2,
    });
    console.log(listing);
    console.log();

    // ── 2. get_file_info ────────────────────────────────────────

    console.log("─ 2. get_file_info ───────────────────────");
    console.log("   获取 greet.ts 元信息\n");

    const info = await byName("get_file_info").asyncHandler!({
      path: path.join(WORK_DIR, "greet.ts"),
    });
    console.log(info);
    console.log();

    // ── 3. glob_files ───────────────────────────────────────────

    console.log("─ 3. glob_files ──────────────────────────");
    console.log("   查找所有 .ts 文件\n");

    const allTs = await byName("glob_files").asyncHandler!({
      pattern: "**/*.ts",
      path: WORK_DIR,
    });
    console.log(allTs);
    console.log();

    // ── 4. create_file ──────────────────────────────────────────

    console.log("─ 4. create_file ─────────────────────────");
    console.log("   创建新文件: features.ts\n");

    const created = await byName("create_file").asyncHandler!({
      path: path.join(WORK_DIR, "features.ts"),
      content: [
        "// features.ts",
        "export interface Feature {",
        "  name: string;",
        "  enabled: boolean;",
        "}",
        "",
        "export const features: Feature[] = [",
        '  { name: "auth", enabled: true },',
        '  { name: "analytics", enabled: false },',
        "];",
        "",
      ].join("\n"),
    });
    console.log(created);
    console.log();

    // ── 5. search_in_files ──────────────────────────────────────

    console.log("─ 5. search_in_files ─────────────────────");
    console.log('   搜索 "export function" 模式\n');

    const searchResult = await byName("search_in_files").asyncHandler!({
      pattern: "export function",
      path: WORK_DIR,
      context: 1,
    });
    console.log(searchResult);
    console.log();

    // ── 6. glob again — verify create worked ────────────────────

    console.log("─ 6. 验证创建结果 ────────────────────────");
    console.log("   重新查找所有 .ts 文件（确认新文件已出现）\n");

    const allTsAgain = await byName("glob_files").asyncHandler!({
      pattern: "**/*.ts",
      path: WORK_DIR,
    });
    console.log(allTsAgain);
    console.log();

    // ── 7. delete_file ──────────────────────────────────────────

    console.log("─ 7. delete_file ─────────────────────────");
    console.log("   删除临时文件: data.json\n");

    const deleted = await byName("delete_file").asyncHandler!({
      path: path.join(WORK_DIR, "data.json"),
    });
    console.log(deleted);
    console.log();

    // ── 8. 最终验证 ─────────────────────────────────────────────

    console.log("─ 8. 最终目录状态 ────────────────────────");

    const finalListing = await byName("list_directory").asyncHandler!({
      path: WORK_DIR,
      depth: 2,
    });
    console.log(finalListing);
    console.log();

    console.log("━━━ ✅ 扩展文件系统示例完成 ━━━");
  } finally {
    cleanupWorkDir();
  }
}

main().catch((err) => {
  cleanupWorkDir();
  console.error(err);
  process.exit(1);
});
