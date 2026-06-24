/**
 * 第 24 章终端执行示例 — 安全的命令运行工具
 *
 * 对应设计文档「ch24-terminal-exec.md」
 *
 * 展示 5 个终端工具：
 *   1. run_command     — 同步执行命令
 *   2. which_command   — 检查命令是否可用
 *   3. run_command_async — 后台异步执行
 *   4. get_job_output  — 读取后台任务输出
 *   5. stop_job        — 终止后台任务
 *
 * 运行方式：
 *   npx tsx examples/ch24_terminal_exec.ts
 */

import { createTerminalTools } from "../src/harness/tools/terminal.js";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/* ─── 主流程 ─────────────────────────────────────────────────────── */

async function main() {
  console.log("━━━ ch24: 终端执行工具 ━━━\n");

  const tools = createTerminalTools(projectRoot);
  const byName = (name: string) => tools.find(t => t.definition.name === name)!;

  // ── 1. which_command ──────────────────────────────────────────

  console.log("─ 1. which_command（检查命令）────────────");

  const whichNode = await byName("which_command").asyncHandler!({ command: "node" });
  console.log(`  node: ${whichNode}`);

  const whichGit = await byName("which_command").asyncHandler!({ command: "git" });
  console.log(`  git:  ${whichGit}`);

  const whichNone = await byName("which_command").asyncHandler!({ command: "nonexistent-cmd-xyz" });
  console.log(`  bogus: ${whichNone}`);
  console.log();

  // ── 2. run_command（同步）─────────────────────────────────────

  console.log("─ 2. run_command（同步执行）──────────────");

  const echo = await byName("run_command").asyncHandler!({ command: "echo 'Hello from agent harness!'" });
  console.log(`  echo: ${echo}`);

  const ls = await byName("run_command").asyncHandler!({ command: "ls -la src/harness/tools/ | head -6" });
  console.log(`  ls tools/:\n${ls}`);
  console.log();

  // ── 3. run_command 安全拦截 ───────────────────────────────────

  console.log("─ 3. run_command 安全拦截 ────────────────");

  const blocked = await byName("run_command").asyncHandler!({ command: "rm -rf /" });
  console.log(`  高危拦截: ${blocked}`);
  console.log();

  // ── 4. run_command_async（后台任务）────────────────────────────

  console.log("─ 4. run_command_async（异步执行）────────");

  const asyncJob = await byName("run_command_async").asyncHandler!({
    command: "node -e \"setTimeout(() => console.log('async done'), 1000)\"",
  });
  console.log(`  ${asyncJob}`);
  console.log();

  // 等待后读取输出
  await new Promise(r => setTimeout(r, 1500));

  const jobOutput = await byName("get_job_output").asyncHandler!({ jobId: 1 });
  console.log(`  后台输出:\n${jobOutput}`);
  console.log();

  // ── 5. 工具统计 ───────────────────────────────────────────────

  console.log("─ 5. 工具清单 ────────────────────────────");
  const names = tools.map(t => `  • ${t.definition.name}`);
  console.log(names.join("\n"));
  console.log();

  console.log("━━━ ✅ 终端执行示例完成 ━━━");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
