/**
 * 第 24 章测试 — 终端执行与安全命令运行
 *
 * 覆盖：
 *   1. run_command — 正常执行、超时、输出截断、cwd 沙箱
 *   2. 安全预检 — BLOCKED_PATTERNS 拦截、WARN_PATTERNS 警告
 *   3. which_command — 找到/未找到
 *   4. run_command_async — 启动/输出/停止
 *   5. get_job_output / stop_job — job 管理
 *   6. CatalogEntry 格式验证
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createTerminalTools } from "../src/harness/tools/terminal.js";
import type { CatalogEntry } from "../src/harness/tools/selector.js";

describe("ch24: Terminal exec tools", () => {
  let tools: CatalogEntry[];

  beforeEach(() => {
    tools = createTerminalTools(process.cwd());
  });

  /* ─── 工具列表验证 ────────────────────────────────────────────── */

  it("creates 5 terminal tools as CatalogEntry array", () => {
    const names = tools.map(t => t.definition.name);
    expect(names).toContain("run_command");
    expect(names).toContain("run_command_async");
    expect(names).toContain("get_job_output");
    expect(names).toContain("stop_job");
    expect(names).toContain("which_command");
  });

  it("each tool has definition and asyncHandler", () => {
    for (const tool of tools) {
      expect(tool.definition.name).toBeTruthy();
      expect(tool.definition.inputSchema).toBeTruthy();
      expect(tool.asyncHandler).toBeInstanceOf(Function);
    }
  });

  /* ─── run_command ────────────────────────────────────────────── */

  it("executes a simple command and returns stdout", async () => {
    const tool = tools.find(t => t.definition.name === "run_command")!;
    const result = await tool.asyncHandler!({ command: "echo hello world" });
    expect(result).toContain("hello world");
  });

  it("reports non-zero exit codes", async () => {
    const tool = tools.find(t => t.definition.name === "run_command")!;
    const result = await tool.asyncHandler!({ command: "node -e 'process.exit(42)'" });
    expect(result).toContain("code 42");
  });

  it("blocks dangerous commands", async () => {
    const tool = tools.find(t => t.definition.name === "run_command")!;
    const result = await tool.asyncHandler!({ command: "rm -rf /" });
    expect(result).toContain("BLOCKED");
    expect(result).toContain("rm");
  });

  it("rejects empty command", async () => {
    const tool = tools.find(t => t.definition.name === "run_command")!;
    const result = await tool.asyncHandler!({ command: "" });
    expect(result).toContain("cannot be empty");
  });

  it("respects cwd parameter", async () => {
    const tool = tools.find(t => t.definition.name === "run_command")!;
    // 用 pwd/cd 验证 cwd 生效
    const result = await tool.asyncHandler!({ command: "node -e \"console.log(process.cwd())\"", cwd: "src" });
    expect(result).toContain("src");
  });

  it("rejects cwd outside project root", async () => {
    const tool = tools.find(t => t.definition.name === "run_command")!;
    const result = await tool.asyncHandler!({ command: "echo test", cwd: "../../etc" });
    expect(result).toMatch(/outside|Error/i);
  });

  it("times out on long-running commands", async () => {
    const tool = tools.find(t => t.definition.name === "run_command")!;
    const result = await tool.asyncHandler!({ command: "sleep 10", timeoutSec: 1 });
    expect(result).toMatch(/timed out|killed/i);
  });

  it("outputs warnings for WARN_PATTERNS", async () => {
    const tool = tools.find(t => t.definition.name === "run_command")!;
    const result = await tool.asyncHandler!({ command: "echo test | sudo ls" });
    // 应该包含 sudo 警告（即使命令本身因为 pipe 可能出错）
    // 重点是验证 warn 机制触发
    expect(result).toMatch(/warn|sudo/i);
  });

  /* ─── which_command ──────────────────────────────────────────── */

  it("which_command finds node", async () => {
    const tool = tools.find(t => t.definition.name === "which_command")!;
    const result = await tool.asyncHandler!({ command: "node" });
    expect(result).toContain("node at");
    expect(result).toContain("node");
  });

  it("which_command returns not found for unknown command", async () => {
    const tool = tools.find(t => t.definition.name === "which_command")!;
    const result = await tool.asyncHandler!({ command: "nonexistent-command-abc123" });
    expect(result).toContain("not found");
  });

  it("which_command rejects empty command", async () => {
    const tool = tools.find(t => t.definition.name === "which_command")!;
    const result = await tool.asyncHandler!({ command: "" });
    expect(result).toContain("cannot be empty");
  });

  it("which_command rejects paths", async () => {
    const tool = tools.find(t => t.definition.name === "which_command")!;
    const result = await tool.asyncHandler!({ command: "/usr/bin/node" });
    expect(result).toContain("command name");
  });

  /* ─── run_command_async / job management ───────────────────────── */

  it("run_command_async starts a background job", async () => {
    const tool = tools.find(t => t.definition.name === "run_command_async")!;
    const result = await tool.asyncHandler!({ command: "echo async test" });
    expect(result).toContain("job");
    expect(result).toContain("started");
  });

  it("get_job_output returns 'not found' for invalid job id", async () => {
    const tool = tools.find(t => t.definition.name === "get_job_output")!;
    const result = await tool.asyncHandler!({ jobId: 99999 });
    expect(result).toContain("not found");
  });

  it("run_command_async blocks dangerous commands", async () => {
    const tool = tools.find(t => t.definition.name === "run_command_async")!;
    const result = await tool.asyncHandler!({ command: "rm -rf /" });
    expect(result).toContain("BLOCKED");
  });

  it("stop_job handles invalid job id", async () => {
    const tool = tools.find(t => t.definition.name === "stop_job")!;
    const result = await tool.asyncHandler!({ jobId: 99999 });
    expect(result).toContain("not found");
  });
});
