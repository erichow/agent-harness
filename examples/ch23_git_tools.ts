/**
 * 第 23 章 Git 工具示例 — 结构化的版本控制操作
 *
 * 对应设计文档「ch23-git-tools.md」
 *
 * 展示 8 个 git 工具的只读和写操作：
 *   1. git_status     — 查看仓库状态
 *   2. git_diff       — 查看文件差异
 *   3. git_log        — 查看提交历史
 *   4. git_commit     — 创建提交
 *   5. git_stash      — 暂存/恢复改动
 *   6. git_branch     — 分支管理
 *
 * 运行方式：
 *   npx tsx examples/ch23_git_tools.ts
 */

import { createGitTools } from "../src/harness/tools/git.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, ".ex23-temp-repo");

/* ─── 辅助 ───────────────────────────────────────────────────────── */

function run(cmd: string, cwd = TEST_DIR): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

function setup(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  run("git init");
  run('git config user.email "demo@example.com"');
  run('git config user.name "Demo"');

  fs.writeFileSync(path.join(TEST_DIR, "README.md"), "# Demo Repo\n", "utf-8");
  fs.writeFileSync(path.join(TEST_DIR, "index.ts"), 'console.log("hello");\n', "utf-8");
  run("git add .");
  run('git commit -m "Initial commit"');
}

/* ─── 主流程 ─────────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch23: Git 版本控制工具 ━━━\n");

  setup();

  const tools = createGitTools(TEST_DIR);
  const byName = (name: string) => tools.find(t => t.definition.name === name)!;

  // ── 1. git_status ─────────────────────────────────────────────

  console.log("─ 1. git_status ────────────────────────");

  // 修改一个文件
  fs.writeFileSync(path.join(TEST_DIR, "index.ts"), 'console.log("modified");\n', "utf-8");
  const status = await byName("git_status").asyncHandler!({});
  console.log(status.slice(0, 400));
  console.log();

  // ── 2. git_diff ───────────────────────────────────────────────

  console.log("─ 2. git_diff ──────────────────────────");

  const diff = await byName("git_diff").asyncHandler!({});
  console.log(diff.slice(0, 300));
  console.log();

  // ── 3. git_commit ─────────────────────────────────────────────

  console.log("─ 3. git_commit ────────────────────────");

  const commit = await byName("git_commit").asyncHandler!({
    message: "Update index.ts",
    files: ["index.ts"],
  });
  console.log(commit);
  console.log();

  // ── 4. git_log ────────────────────────────────────────────────

  console.log("─ 4. git_log ───────────────────────────");

  const log = await byName("git_log").asyncHandler!({ max_count: 5 });
  console.log(log.slice(0, 400));
  console.log();

  // ── 5. git_stash ──────────────────────────────────────────────

  console.log("─ 5. git_stash ─────────────────────────");

  // 再做一个未提交的改动
  fs.writeFileSync(path.join(TEST_DIR, "stash-me.txt"), "stash content\n", "utf-8");

  const stash = await byName("git_stash").asyncHandler!({ action: "push" });
  console.log(stash);
  console.log();

  const stashList = await byName("git_stash").asyncHandler!({ action: "list" });
  console.log(stashList.slice(0, 200));
  console.log();

  // ── 6. git_branch ─────────────────────────────────────────────

  console.log("─ 6. git_branch ────────────────────────");

  const branchCreate = await byName("git_branch").asyncHandler!({
    action: "create",
    name: "feature/demo",
  });
  console.log(branchCreate);

  const branchSwitch = await byName("git_branch").asyncHandler!({
    action: "switch",
    name: "feature/demo",
  });
  console.log(branchSwitch);

  const branchList = await byName("git_branch").asyncHandler!({ action: "list" });
  console.log(branchList.slice(0, 200));
  console.log();

  // ── 清理 ──────────────────────────────────────────────────────

  fs.rmSync(TEST_DIR, { recursive: true });
  console.log("━━━ ✅ Git 工具示例完成 ━━━");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
