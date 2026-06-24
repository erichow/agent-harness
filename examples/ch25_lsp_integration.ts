/**
 * 第 25 章 LSP 集成示例 — 编辑器级别的代码智能
 *
 * 对应设计文档「ch25-lsp-integration.md」
 *
 * 展示 6 个 LSP 代码智能工具（使用 MockLSPManager 演示）：
 *   1. lsp_definition     — 跳转到符号定义
 *   2. lsp_references     — 查找所有引用
 *   3. lsp_hover           — 获取悬停文档/签名
 *   4. lsp_completion      — 获取补全建议
 *   5. lsp_signature_help  — 获取函数签名
 *   6. lsp_diagnostic      — 获取文件诊断
 *
 * 运行方式：
 *   npx tsx examples/ch25_lsp_integration.ts
 */

import { createLSPTools, MockLSPManager } from "../src/harness/tools/lsp.js";
import type {
  LspLocation, LspCompletionItem, LspSignatureInfo, LspDiagnosticItem,
} from "../src/harness/tools/lsp.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const TEST_FILE = path.join(__dirname, "__ch25_demo.ts");

/* ─── 准备测试文件 ────────────────────────────────────────────────── */

function setup(): void {
  const content = [
    "/**",
    " * Calculate the sum of two numbers.",
    " * @param a - First number",
    " * @param b - Second number",
    " * @returns The sum",
    " */",
    "function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "interface User {",
    "  id: number;",
    "  name: string;",
    "  email: string;",
    "}",
    "",
    "const users: User[] = [",
    '  { id: 1, name: "Alice", email: "alice@example.com" },',
    '  { id: 2, name: "Bob", email: "bob@example.com" },',
    "];",
    "",
    "// Find a user by name",
    "function findUser(name: string): User | undefined {",
    "  return users.find(u => u.name === name);",
    "}",
    "",
    "// Use the functions",
    'const result = add(3, 4);',
    'const found = findUser("Alice");',
    "",
    "console.log(result, found);",
    "",
  ].join("\n");
  fs.writeFileSync(TEST_FILE, content, "utf-8");
}

/* ─── 主流程 ─────────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch25: LSP 代码智能集成 ━━━\n");

  setup();

  // 使用 MockLSPManager 演示——无需安装真实语言服务器
  const mockLsp = new MockLSPManager(projectRoot);

  // 预设模拟数据
  const addDefLoc: LspLocation = {
    uri: `file://${TEST_FILE}`,
    range: { start: { line: 7, character: 10 }, end: { line: 7, character: 13 } },
  };
  mockLsp.setMockDefinition(`${TEST_FILE}:26:16`, addDefLoc);

  const addRefs: LspLocation[] = [
    { uri: `file://${TEST_FILE}`, range: { start: { line: 26, character: 16 }, end: { line: 26, character: 19 } } },
  ];
  mockLsp.setMockReferences(`${TEST_FILE}:7:10`, addRefs);

  mockLsp.setMockHover(`${TEST_FILE}:7:10`, {
    contents: "function add(a: number, b: number): number\n\nCalculate the sum of two numbers.",
  });

  mockLsp.setMockCompletion(`${TEST_FILE}:26:17`, [
    { label: "add", detail: "(a: number, b: number): number", kind: 2 },
    { label: "findUser", detail: "(name: string): User | undefined", kind: 2 },
  ]);

  mockLsp.setMockSignature(`${TEST_FILE}:26:16`, {
    label: "add(a: number, b: number): number",
    parameters: [
      { label: "a: number", documentation: "First number" },
      { label: "b: number", documentation: "Second number" },
    ],
    activeParameter: 1,
  });

  mockLsp.setMockDiagnostics(TEST_FILE, [
    {
      range: { start: { line: 32, character: 0 }, end: { line: 32, character: 20 } },
      severity: 2, message: "'found' is assigned but never used",
      source: "typescript", code: "noUnusedLocals",
    },
  ]);

  const tools = createLSPTools(projectRoot, mockLsp);
  const byName = (name: string) => tools.find(t => t.definition.name === name)!;

  // ── 1. lsp_definition ─────────────────────────────────────────

  console.log("─ 1. lsp_definition ─────────────────────");
  console.log("   查找 add(3,4) 中 add 的定义位置:");
  const def = await byName("lsp_definition").asyncHandler!({ file: TEST_FILE, line: 26, column: 16 });
  console.log(`  ${def.replace(/\n/g, "\n  ")}`);
  console.log();

  // ── 2. lsp_references ─────────────────────────────────────────

  console.log("─ 2. lsp_references ─────────────────────");
  console.log("   查找 add 函数的所有引用:");
  const refs = await byName("lsp_references").asyncHandler!({ file: TEST_FILE, line: 7, column: 10 });
  console.log(`  ${refs.replace(/\n/g, "\n  ")}`);
  console.log();

  // ── 3. lsp_hover ───────────────────────────────────────────────

  console.log("─ 3. lsp_hover ───────────────────────────");
  console.log("   查看 add 函数的文档:");
  const hover = await byName("lsp_hover").asyncHandler!({ file: TEST_FILE, line: 7, column: 10 });
  console.log(`  ${hover.replace(/\n/g, "\n  ")}`);
  console.log();

  // ── 4. lsp_completion ─────────────────────────────────────────

  console.log("─ 4. lsp_completion ──────────────────────");
  console.log("   在 add( 位置获取补全建议:");
  const comp = await byName("lsp_completion").asyncHandler!({ file: TEST_FILE, line: 26, column: 17 });
  console.log(`  ${comp.replace(/\n/g, "\n  ")}`);
  console.log();

  // ── 5. lsp_signature_help ──────────────────────────────────────

  console.log("─ 5. lsp_signature_help ──────────────────");
  console.log("   查看 add(3, 4) 中第二个参数的签名帮助:");
  const sig = await byName("lsp_signature_help").asyncHandler!({ file: TEST_FILE, line: 26, column: 18 });
  console.log(`  ${sig.replace(/\n/g, "\n  ")}`);
  console.log();

  // ── 6. lsp_diagnostic ─────────────────────────────────────────

  console.log("─ 6. lsp_diagnostic ──────────────────────");
  console.log("   检查文件诊断:");
  const diag = await byName("lsp_diagnostic").asyncHandler!({ file: TEST_FILE, line: 1, column: 1 });
  console.log(`  ${diag.replace(/\n/g, "\n  ")}`);
  console.log();

  // ── 清理 ──────────────────────────────────────────────────────

  try { fs.unlinkSync(TEST_FILE); } catch { /* ok */ }
  console.log("━━━ ✅ LSP 集成示例完成 ━━━");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
