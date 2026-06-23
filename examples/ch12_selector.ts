/**
 * 第 12 章 ToolCatalog 示例 — BM25 动态工具选择
 *
 * 对应设计文档「ch12-tool-cliff — 工具悬崖与动态加载」
 *
 * 设计要点：
 *   1. BM25 每回合从完整目录选 top-K 个工具
 *   2. 钉住（pinned）核心工具永远在列表里
 *   3. 0 分过滤 — 不匹配时只返回 pinned
 *   4. queryFromTranscript — 从对话提取检索 query
 *   5. 解决"工具悬崖"：30+ 工具时选择准确率断崖下降
 *
 * 运行方式：
 *   npx tsx examples/ch12_selector.ts
 */

import { ToolCatalog, createDiscoveryEntry } from "../src/harness/tools/selector.js";
import type { CatalogEntry } from "../src/harness/tools/selector.js";
import { Transcript, Message } from "../src/harness/messages.js";

/* ─── 构建 20 个工具的目录 ──────────────────────────────────────── */

function toolEntry(name: string, desc: string, kw: string): CatalogEntry {
  return {
    definition: {
      name,
      description: desc,
      inputSchema: { type: "object", properties: {} },
    },
    handler: () => `${name} executed`,
  };
}

function buildCatalog(): ToolCatalog {
  const tools: CatalogEntry[] = [
    toolEntry("read_file_viewport", "Read a slice of a text file with line numbers", "read file viewport text"),
    toolEntry("edit_lines", "Replace a line range in a file with new content", "edit lines replace write"),
    toolEntry("bash", "Run a shell command", "bash shell command run execute"),
    toolEntry("calc", "Evaluate a math expression", "calc math arithmetic compute"),
    toolEntry("search_docs", "Search documentation corpus by keywords", "search docs find query"),
    toolEntry("github_search", "Search code across GitHub repositories", "github search code repository"),
    toolEntry("npm_info", "Get info about an npm package", "npm package info"),
    toolEntry("run_tests", "Run the project test suite", "run tests pytest jest"),
    toolEntry("git_diff", "Show changes between commits", "git diff changes"),
    toolEntry("git_status", "Show working tree status", "git status changes"),
    toolEntry("http_fetch", "Fetch a URL", "http fetch url request"),
    toolEntry("slack_post", "Post a message to Slack", "slack post message"),
    toolEntry("scratchpad_list", "List keys in the scratchpad", "scratchpad list keys"),
    toolEntry("scratchpad_read", "Read a value from scratchpad", "scratchpad read key"),
    toolEntry("scratchpad_write", "Write a value to scratchpad", "scratchpad write key"),
    toolEntry("list_available_tools", "List all available tools", "list tools discover help"),
    toolEntry("search_code", "Search codebase for a function or pattern", "search code find grep"),
    toolEntry("file_metadata", "Get file metadata like size and mtime", "file metadata stat info"),
    toolEntry("create_file", "Create a new file with content", "create file new write"),
    toolEntry("delete_file", "Delete a file from the filesystem", "delete file remove rm"),
  ];

  return new ToolCatalog(tools);
}

/* ─── 演示 ──────────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch12: ToolCatalog 动态工具选择 ━━━\n");

  const catalog = buildCatalog();
  console.log(`目录中共 ${catalog.list().length} 个工具\n`);

  // 1. BM25 选择 — 文件编辑场景
  console.log("─ 1. 查询 'edit file content' → k=5 ────");
  const r1 = catalog.select("edit file content", 5);
  console.log(`   选中 ${r1.length} 个工具:`);
  for (const t of r1) {
    console.log(`     ${t.definition.name} — ${t.definition.description}`);
  }
  console.log();

  // 2. 代码搜索场景
  console.log("─ 2. 查询 'find function in code' → k=4 ──");
  const r2 = catalog.select("find function in code", 4);
  console.log(`   选中 ${r2.length} 个工具:`);
  for (const t of r2) {
    console.log(`     ${t.definition.name} — ${t.definition.description}`);
  }
  console.log();

  // 3. Git 操作场景
  console.log("─ 3. 查询 'check git changes' → k=3 ──────");
  const r3 = catalog.select("check git changes", 3);
  console.log(`   选中 ${r3.length} 个工具:`);
  for (const t of r3) {
    console.log(`     ${t.definition.name} — ${t.definition.description}`);
  }
  console.log();

  // 4. 钉住核心工具（mustInclude）
  console.log("─ 4. 钉住 read_file_viewport（mustInclude）─");
  const r4 = catalog.select("run tests", 3, new Set(["read_file_viewport"]));
  console.log(`   选中 ${r4.length} 个工具（含钉住的 read_file_viewport）:`);
  for (const t of r4) {
    console.log(`     ${t.definition.name}`);
  }
  console.log();

  // 5. 不匹配查询 — 0 分过滤
  console.log("─ 5. 查询 'zzzznonexistent' → k=5 ────────");
  const r5 = catalog.select("zzzznonexistent", 5);
  console.log(`   结果数: ${r5.length}（0 分过滤后不返回）`);
  console.log();

  // 6. discovery 工具
  console.log("─ 6. discovery 工具（list_available_tools）─");
  const discovery = createDiscoveryEntry(catalog);
  const result = discovery.handler({});
  const lines = (result as string).split("\n");
  console.log(`   ${lines.slice(0, 5).join("\n   ")}`);
  console.log(`   ...（共 ${lines.length} 行）`);

  console.log("\n━━━ ✅ ToolCatalog 示例完成 ━━━");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
