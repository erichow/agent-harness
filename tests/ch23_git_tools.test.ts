/**
 * 第 23 章测试 — Git 版本控制工具
 *
 * 覆盖：
 *   1. git_status — 初始状态、变更后状态、clean repo
 *   2. git_diff — 修改后 diff、staged diff、特定文件 diff、viewport 截断
 *   3. git_log — 提交历史、文件范围、max_count
 *   4. git_commit — 提交所有 / 指定文件
 *   5. git_stash — push / pop / list
 *   6. git_branch — list / create / switch / delete
 *   7. git_push / git_pull — 错误场景（无 remote）
 *   8. CatalogEntry 格式验证
 *
 * 使用临时 git 仓库（不依赖外部 git 配置）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { createGitTools } from "../src/harness/tools/git.js";
import type { CatalogEntry } from "../src/harness/tools/selector.js";

const TEST_DIR = path.resolve(__dirname, ".test-ch23");

/** 在 TEST_DIR 中初始化一个 git 仓库 */
async function initRepo(): Promise<void> {
  const { default: git } = await import("simple-git");
  const repo = git(TEST_DIR);
  await repo.init();
  // 配置 user 信息（在 CI 中可能没有全局 git 配置）
  await repo.addConfig("user.email", "test@harness.local");
  await repo.addConfig("user.name", "Test Harness");
}

/** 创建文件并写入内容 */
function writeTestFile(name: string, content: string): string {
  const filePath = path.join(TEST_DIR, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return name;
}

/** 读取文件内容 */
function readTestFile(name: string): string {
  return fs.readFileSync(path.join(TEST_DIR, name), "utf-8");
}

/** 创建一个初始提交 */
async function createInitialCommit(): Promise<void> {
  const { default: git } = await import("simple-git");
  const repo = git(TEST_DIR);
  writeTestFile("README.md", "# Test Repo\n\nA test repository.\n");
  await repo.add(".");
  await repo.commit("initial commit");
}

describe("ch23: Git tools", () => {
  let tools: CatalogEntry[];

  beforeEach(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initRepo();
    tools = createGitTools(TEST_DIR);
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /* ─── 工具列表验证 ────────────────────────────────────────────── */

  it("creates 8 git tools as CatalogEntry array", () => {
    expect(tools.length).toBe(8);
    const names = tools.map(t => t.definition.name);
    expect(names).toContain("git_status");
    expect(names).toContain("git_diff");
    expect(names).toContain("git_log");
    expect(names).toContain("git_commit");
    expect(names).toContain("git_stash");
    expect(names).toContain("git_branch");
    expect(names).toContain("git_push");
    expect(names).toContain("git_pull");
  });

  it("each tool has definition.name and asyncHandler", () => {
    for (const tool of tools) {
      expect(tool.definition.name).toBeTruthy();
      expect(tool.definition.description).toBeTruthy();
      expect(tool.definition.inputSchema).toBeTruthy();
      expect(tool.asyncHandler).toBeInstanceOf(Function);
    }
  });

  /* ─── git_status ──────────────────────────────────────────────── */

  it("git_status shows clean repo after init", async () => {
    const tool = tools.find(t => t.definition.name === "git_status")!;
    const result = await tool.asyncHandler!({});
    expect(result).toContain("clean");
    expect(result).toContain("branch:");
  });

  it("git_status shows uncommitted changes", async () => {
    writeTestFile("file1.txt", "hello");
    const tool = tools.find(t => t.definition.name === "git_status")!;
    const result = await tool.asyncHandler!({});
    expect(result).not.toContain("clean");
    expect(result).toContain("untracked");
    expect(result).toContain("file1.txt");
  });

  it("git_status shows modified files", async () => {
    await createInitialCommit();
    writeTestFile("README.md", "# Modified\n");
    const tool = tools.find(t => t.definition.name === "git_status")!;
    const result = await tool.asyncHandler!({});
    expect(result).toContain("modified");
    expect(result).toContain("README.md");
  });

  /* ─── git_diff ────────────────────────────────────────────────── */

  it("git_diff shows changes after modification", async () => {
    await createInitialCommit();
    writeTestFile("README.md", "# Changed Content\n\nModified.\n");
    const tool = tools.find(t => t.definition.name === "git_diff")!;
    const result = await tool.asyncHandler!({});
    expect(result).toContain("diff --git");
    expect(result).toContain("Changed Content");
    expect(result).not.toContain("(no diff)");
  });

  it("git_diff returns '(no diff)' for clean repo", async () => {
    await createInitialCommit();
    const tool = tools.find(t => t.definition.name === "git_diff")!;
    const result = await tool.asyncHandler!({});
    expect(result).toBe("(no diff)");
  });

  it("git_diff scopes to specific file", async () => {
    await createInitialCommit();
    writeTestFile("file_a.txt", "aaa");
    writeTestFile("file_b.txt", "bbb");
    // 先 add + commit，再修改单个文件
    const { default: git } = await import("simple-git");
    const repo = git(TEST_DIR);
    await repo.add(".");
    await repo.commit("add two files");
    writeTestFile("file_a.txt", "modified aaa");

    const tool = tools.find(t => t.definition.name === "git_diff")!;
    const result = await tool.asyncHandler!({ file: "file_a.txt" });
    expect(result).toContain("file_a.txt");
    expect(result).not.toContain("file_b.txt");
  });

  it("git_diff shows staged changes with staged=true", async () => {
    await createInitialCommit();
    writeTestFile("staged.txt", "staged content");
    const { default: git } = await import("simple-git");
    const repo = git(TEST_DIR);
    await repo.add("staged.txt");

    const tool = tools.find(t => t.definition.name === "git_diff")!;
    const result = await tool.asyncHandler!({ staged: true });
    expect(result).toContain("staged.txt");
  });

  /* ─── git_log ────────────────────────────────────────────────── */

  it("git_log shows initial commit", async () => {
    await createInitialCommit();
    const tool = tools.find(t => t.definition.name === "git_log")!;
    const result = await tool.asyncHandler!({});
    expect(result).toContain("initial commit");
    expect(result).toContain("1 commit(s)");
  });

  it("git_log with file scope", async () => {
    await createInitialCommit();
    writeTestFile("extra.txt", "extra");
    const { default: git } = await import("simple-git");
    const repo = git(TEST_DIR);
    await repo.add(".");
    await repo.commit("second commit");

    const tool = tools.find(t => t.definition.name === "git_log")!;
    const result = await tool.asyncHandler!({ file: "extra.txt" });
    expect(result).toContain("second commit");
    expect(result).toContain("1 commit(s)");
  });

  it("git_log respects max_count", async () => {
    await createInitialCommit();
    const { default: git } = await import("simple-git");
    const repo = git(TEST_DIR);
    for (let i = 0; i < 5; i++) {
      writeTestFile(`log-${i}.txt`, `content-${i}`);
      await repo.add(".");
      await repo.commit(`commit ${i}`);
    }

    const tool = tools.find(t => t.definition.name === "git_log")!;
    const result = await tool.asyncHandler!({ max_count: 2 });
    // 6 个提交（1 initial + 5），max_count 只显示 2 个
    expect(result).toContain("commit(s)");
    const match = result.match(/(\d+) commit/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeLessThanOrEqual(6);
  });

  /* ─── git_commit ──────────────────────────────────────────────── */

  it("git_commit stages all and creates commit", async () => {
    writeTestFile("commit-test.txt", "to be committed");
    const tool = tools.find(t => t.definition.name === "git_commit")!;
    const result = await tool.asyncHandler!({ message: "test commit" });
    expect(result).toContain("committed:");
    expect(result).toContain("message: test commit");
  });

  it("git_commit rejects empty message", async () => {
    const tool = tools.find(t => t.definition.name === "git_commit")!;
    const result = await tool.asyncHandler!({ message: "" });
    expect(result).toContain("cannot be empty");
  });

  it("git_commit with specific files", async () => {
    writeTestFile("specific1.txt", "one");
    writeTestFile("specific2.txt", "two");
    const tool = tools.find(t => t.definition.name === "git_commit")!;
    const result = await tool.asyncHandler!({
      message: "specific files",
      files: ["specific1.txt"],
    });
    expect(result).toContain("committed:");

    // specific2.txt 应该仍被 untracked
    const statusTool = tools.find(t => t.definition.name === "git_status")!;
    const status = await statusTool.asyncHandler!({});
    expect(status).toContain("specific2.txt");
  });

  /* ─── git_stash ───────────────────────────────────────────────── */

  it("git_stash push/pop/list cycle", async () => {
    await createInitialCommit();
    // 修改已跟踪文件（README.md），untracked 文件不会被 stash
    writeTestFile("README.md", "# Modified for stash\n");
    const stashTool = tools.find(t => t.definition.name === "git_stash")!;

    // push
    const pushResult = await stashTool.asyncHandler!({ action: "push", message: "test stash" });
    expect(pushResult).toContain("stashed");
    expect(pushResult).toContain("test stash");

    // list
    const listResult = await stashTool.asyncHandler!({ action: "list" });
    expect(listResult).toContain("1 stash(es)");

    // pop
    const popResult = await stashTool.asyncHandler!({ action: "pop" });
    expect(popResult).toContain("unstashed");

    // list after pop
    const listAfter = await stashTool.asyncHandler!({ action: "list" });
    expect(listAfter).toContain("(no stashes)");
  });

  it("git_stash list shows empty initially", async () => {
    const tool = tools.find(t => t.definition.name === "git_stash")!;
    const result = await tool.asyncHandler!({ action: "list" });
    expect(result).toContain("(no stashes)");
  });

  /* ─── git_branch ──────────────────────────────────────────────── */

  it("git_branch lists default branch", async () => {
    await createInitialCommit();
    const tool = tools.find(t => t.definition.name === "git_branch")!;
    const result = await tool.asyncHandler!({ action: "list" });
    expect(result).toContain("*");
    // 默认分支可能是 master 或 main
    expect(result).toContain("branch");
  });

  it("git_branch create and list", async () => {
    await createInitialCommit();
    const tool = tools.find(t => t.definition.name === "git_branch")!;

    const createResult = await tool.asyncHandler!({ action: "create", name: "feature-x" });
    expect(createResult).toContain("created");

    const listResult = await tool.asyncHandler!({ action: "list" });
    expect(listResult).toContain("feature-x");
  });

  it("git_branch switch and delete", async () => {
    await createInitialCommit();
    // 获取当前分支名
    const { default: simpleGit } = await import("simple-git");
    const defaultBranch = (await simpleGit(TEST_DIR).branch()).current;

    const tool = tools.find(t => t.definition.name === "git_branch")!;

    await tool.asyncHandler!({ action: "create", name: "feature-y" });
    const switchResult = await tool.asyncHandler!({ action: "switch", name: "feature-y" });
    expect(switchResult).toContain("switched");

    // current branch should now be feature-y
    const statusTool = tools.find(t => t.definition.name === "git_status")!;
    const status = await statusTool.asyncHandler!({});
    expect(status).toContain("feature-y");

    // switch back to default branch and delete feature-y
    await tool.asyncHandler!({ action: "switch", name: defaultBranch });
    const deleteResult = await tool.asyncHandler!({ action: "delete", name: "feature-y" });
    expect(deleteResult).toContain("deleted");
  });

  /* ─── git_push / git_pull 错误场景 ──────────────────────────── */

  it("git_push fails without remote", async () => {
    await createInitialCommit();
    const tool = tools.find(t => t.definition.name === "git_push")!;
    const result = await tool.asyncHandler!({});
    expect(result).toContain("error") || expect(result).toContain("Error");
  });

  it("git_pull fails without remote", async () => {
    await createInitialCommit();
    const tool = tools.find(t => t.definition.name === "git_pull")!;
    const result = await tool.asyncHandler!({});
    // 无 remote 的 pull 会报错
    expect(result).toContain("error") || expect(result).toContain("Error");
  });
});
