/**
 * 第 11 章 ACI 工具示例 — 为模型设计的文件工具
 *
 * 对应设计文档「ch11-aci-tools — 为模型设计的工具」
 *
 * 设计要点（ACI 四条原则）：
 *   1. Viewport, not dump — 窗口读取（100 行）+ 行号渲染 + envelope footer
 *   2. Targeted edit, not rewrite — 行范围编辑替代整文件重写
 *   3. Envelope — 每段内容附带头尾信息
 *   4. 具体错误 — "file does not exist" 而非状态码
 *
 * 运行方式：
 *   npx tsx examples/ch11_aci_tools.ts
 */

import { fileViewportTool, editLinesTool } from "../src/harness/tools/files.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import * as fs from "node:fs";
import * as path from "node:path";

const TEST_FILE = ".ex11-sample.txt";

/* ─── 准备测试文件 ────────────────────────────────────────────────── */

function setup(): void {
  const lines: string[] = [];
  for (let i = 1; i <= 50; i++) {
    lines.push(`This is line number ${i} of the sample file.`);
  }
  fs.writeFileSync(TEST_FILE, lines.join("\n") + "\n", "utf-8");
}

function cleanup(): void {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
}

/* ─── 演示 ──────────────────────────────────────────────────────── */

async function main() {
  setup();
  console.log("━━━ ch11: ACI 文件工具 ━━━\n");

  // 注册工具
  const registry = new ToolRegistry();
  registry.register(...fileViewportTool());
  registry.register(...editLinesTool());

  // 1. viewport 读取 — 默认前 100 行
  console.log("─ 1. readFileViewport（默认前 100 行）───");
  const r1 = registry.execute(
    "read_file_viewport",
    { path: TEST_FILE },
    "call-1",
  );
  console.log(r1.content);
  console.log();

  // 2. viewport 带 offset（滚动）
  console.log("─ 2. readFileViewport（offset=30, limit=10）─");
  const r2 = registry.execute(
    "read_file_viewport",
    { path: TEST_FILE, offset: 30, limit: 10 },
    "call-2",
  );
  console.log(r2.content);
  console.log();

  // 3. 错误处理 — 文件不存在
  console.log("─ 3. 错误处理：文件不存在 ──────────");
  const r3 = registry.execute(
    "read_file_viewport",
    { path: "/tmp/nonexistent.txt" },
    "call-3",
  );
  console.log(`   ${r3.content}`);
  console.log();

  // 4. editLines — 替换指定行
  console.log("─ 4. editLines — 替换第 10-12 行 ──");
  const r4 = registry.execute(
    "edit_lines",
    {
      path: TEST_FILE,
      start_line: 10,
      end_line: 12,
      replacement: "This is the REPLACED line 10.\nThis is the REPLACED line 11.\nThis is the REPLACED line 12.",
    },
    "call-4",
  );
  console.log(`   ${r4.content}`);
  console.log();

  // 验证修改
  console.log("─ 验证：读取修改后的行 ──────────────");
  const r5 = registry.execute(
    "read_file_viewport",
    { path: TEST_FILE, offset: 9, limit: 5 },
    "call-5",
  );
  console.log(r5.content);
  console.log();

  // 5. editLines — 追加（新行替换到文件末尾）
  console.log("─ 5. editLines — 追加新行 ───────────");
  const r6 = registry.execute(
    "edit_lines",
    {
      path: TEST_FILE,
      start_line: 51,
      end_line: 50,
      replacement: "This is an appended line at the end.",
    },
    "call-6",
  );
  console.log(`   ${r6.content}`);

  console.log("\n━━━ ✅ ACI 工具示例完成 ━━━");
  cleanup();
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
