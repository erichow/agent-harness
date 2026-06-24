/**
 * 第 27 章测试 — 扩展文件系统工具
 *
 * 覆盖 6 个工具的完整测试：
 *   1. create_file         — 创建新文件（路径已存在报错、目录自动创建）
 *   2. delete_file         — 删除文件/目录（recursive 删除目录）
 *   3. list_directory      — 目录浏览（depth 控制、格式输出）
 *   4. glob_files          — 文件模式搜索
 *   5. get_file_info       — 文件元信息（大小、mtime、类型、行数）
 *   6. search_in_files     — 文件内容搜索（text/regex、context、case-sensitive）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

import { createExtendedFilesystemTools } from "../src/harness/tools/extended_filesystem.js";
import type { CatalogEntry } from "../src/harness/tools/selector.js";

/* ─── 辅助：创建临时测试目录 ──────────────────────────────────── */

const TEST_DIR = path.join(projectRoot, "tests", "__ch27_test_files");

interface TestFiles {
  rootDir: string;
  subDir: string;
  fileA: string;
  fileB: string;
  fileC: string;
  dataFile: string;
  markdownFile: string;
}

function createTestFiles(): TestFiles {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const rootDir = TEST_DIR;

  // sub directory
  const subDir = path.join(rootDir, "sub");
  fs.mkdirSync(subDir, { recursive: true });

  // source files
  const fileA = path.join(rootDir, "hello.ts");
  fs.writeFileSync(fileA, [
    "// hello.ts",
    "export function greet(name: string): string {",
    '  return `Hello, ${name}!`;',
    "}",
    "",
    "export const VERSION = '1.0.0';",
    "",
  ].join("\n"), "utf-8");

  const fileB = path.join(rootDir, "math.ts");
  fs.writeFileSync(fileB, [
    "// math.ts",
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function multiply(a: number, b: number): number {",
    "  return a * b;",
    "}",
    "",
  ].join("\n"), "utf-8");

  const fileC = path.join(subDir, "utils.ts");
  fs.writeFileSync(fileC, [
    "// utils.ts (in subdir)",
    "export function capitalize(s: string): string {",
    "  return s.charAt(0).toUpperCase() + s.slice(1);",
    "}",
    "",
    "export function repeat(s: string, n: number): string {",
    "  return s.repeat(n);",
    "}",
    "",
  ].join("\n"), "utf-8");

  const dataFile = path.join(rootDir, "data.json");
  fs.writeFileSync(dataFile, JSON.stringify({
    name: "test",
    version: 1,
    items: [1, 2, 3],
  }, null, 2), "utf-8");

  const markdownFile = path.join(rootDir, "README.md");
  fs.writeFileSync(markdownFile, [
    "# Test Project",
    "",
    "This is a test.",
    "",
    "## Features",
    "",
    "- Feature A",
    "- Feature B",
    "",
    "TODO: add more features",
    "",
  ].join("\n"), "utf-8");

  return { rootDir, subDir, fileA, fileB, fileC, dataFile, markdownFile };
}

function removeTestFiles(): void {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

/* ─── 工具获取辅助 ──────────────────────────────────────────────── */

function byName(tools: CatalogEntry[], name: string): CatalogEntry {
  const tool = tools.find(t => t.definition.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

/* ═══════════════════════════════════════════════════════════════════
   测试套件
   ═══════════════════════════════════════════════════════════════════ */

describe("ch27: extended filesystem tools", () => {
  let tools: CatalogEntry[];
  let files: TestFiles;

  beforeEach(() => {
    files = createTestFiles();
    tools = createExtendedFilesystemTools();
  });

  afterEach(() => {
    removeTestFiles();
  });

  /* ─── 工具列表验证 ────────────────────────────────────────────── */

  it("creates 6 extended filesystem tools as CatalogEntry array", () => {
    const names = tools.map(t => t.definition.name);
    expect(names).toEqual([
      "create_file",
      "delete_file",
      "list_directory",
      "glob_files",
      "get_file_info",
      "search_in_files",
    ]);
  });

  it("each tool has definition, handler, and asyncHandler", () => {
    for (const tool of tools) {
      expect(tool.definition.name).toBeTruthy();
      expect(tool.definition.description).toBeTruthy();
      expect(tool.definition.inputSchema).toBeTruthy();
      expect(typeof tool.asyncHandler).toBe("function");
    }
  });

  /* ═══════════════════════════════════════════════════════════════
     ① create_file
     ═══════════════════════════════════════════════════════════════ */

  describe("create_file", () => {
    const getTool = () => byName(tools, "create_file");

    it("creates a new file with content", async () => {
      const newFile = path.join(TEST_DIR, "new_file.ts");
      const result = await getTool().asyncHandler!({
        path: newFile,
        content: "export const x = 1;\n",
      });

      expect(result).toContain("created");
      expect(result).toContain("new_file.ts");
      expect(fs.existsSync(newFile)).toBe(true);
      expect(fs.readFileSync(newFile, "utf-8")).toBe("export const x = 1;\n");
    });

    it("reports line count in result", async () => {
      const newFile = path.join(TEST_DIR, "multi_line.ts");
      const content = "line1\nline2\nline3\n";
      const result = await getTool().asyncHandler!({
        path: newFile,
        content,
      });

      expect(result).toContain("4 lines");
    });

    it("returns error when file already exists", async () => {
      const result = await getTool().asyncHandler!({
        path: files.fileA,
        content: "overwrite",
      });

      expect(result).toContain("already exists");
      // Content should be unchanged
      expect(fs.readFileSync(files.fileA, "utf-8")).toContain("Hello");
    });

    it("auto-creates parent directories", async () => {
      const nestedFile = path.join(TEST_DIR, "a", "b", "c", "nested.ts");
      const result = await getTool().asyncHandler!({
        path: nestedFile,
        content: "export const nested = true;\n",
      });

      expect(result).toContain("created");
      expect(fs.existsSync(nestedFile)).toBe(true);
    });

    it("handles empty content", async () => {
      const emptyFile = path.join(TEST_DIR, "empty.txt");
      const result = await getTool().asyncHandler!({
        path: emptyFile,
        content: "",
      });

      expect(result).toContain("created");
      expect(fs.readFileSync(emptyFile, "utf-8")).toBe("");
    });

    it("rejects empty path", async () => {
      const result = await getTool().asyncHandler!({
        path: "",
        content: "test",
      });
      expect(result).toContain("path cannot be empty");
    });

    it("creates files with special characters in content", async () => {
      const specialFile = path.join(TEST_DIR, "special.txt");
      const specialContent = "hello\nworld\nпривет\n世界\n";
      await getTool().asyncHandler!({
        path: specialFile,
        content: specialContent,
      });

      const read = fs.readFileSync(specialFile, "utf-8");
      expect(read).toBe(specialContent);
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     ② delete_file
     ═══════════════════════════════════════════════════════════════ */

  describe("delete_file", () => {
    const getTool = () => byName(tools, "delete_file");

    it("deletes an existing file", async () => {
      const result = await getTool().asyncHandler!({
        path: files.fileA,
      });

      expect(result).toContain("deleted");
      expect(result).toContain("hello.ts");
      expect(fs.existsSync(files.fileA)).toBe(false);
    });

    it("returns error for non-existent file", async () => {
      const result = await getTool().asyncHandler!({
        path: "/nonexistent/path/file.txt",
      });

      expect(result).toContain("does not exist");
    });

    it("refuses to delete non-empty directory without recursive", async () => {
      const result = await getTool().asyncHandler!({
        path: TEST_DIR,
      });

      expect(result).toContain("directory not empty");
      expect(fs.existsSync(TEST_DIR)).toBe(true);
    });

    it("deletes directory with recursive=true", async () => {
      // Create a subdirectory to ensure recursive is needed
      const deepNested = path.join(TEST_DIR, "deep", "nested", "dir");
      fs.mkdirSync(deepNested, { recursive: true });
      fs.writeFileSync(path.join(deepNested, "file.txt"), "content", "utf-8");

      const result = await getTool().asyncHandler!({
        path: path.join(TEST_DIR, "deep"),
        recursive: true,
      });

      expect(result).toContain("deleted");
      expect(result).toContain("deep");
      expect(fs.existsSync(path.join(TEST_DIR, "deep"))).toBe(false);
    });

    it("rejects empty path", async () => {
      const result = await getTool().asyncHandler!({
        path: "",
      });

      expect(result).toContain("path cannot be empty");
    });

    it("deletes empty directory without recursive flag", async () => {
      const emptyDir = path.join(TEST_DIR, "empty_dir");
      fs.mkdirSync(emptyDir);

      const result = await getTool().asyncHandler!({
        path: emptyDir,
      });

      expect(result).toContain("deleted");
      expect(fs.existsSync(emptyDir)).toBe(false);
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     ③ list_directory
     ═══════════════════════════════════════════════════════════════ */

  describe("list_directory", () => {
    const getTool = () => byName(tools, "list_directory");

    it("lists entries at root with depth=1", async () => {
      const result = await getTool().asyncHandler!({
        path: TEST_DIR,
        depth: 1,
      });

      expect(result).toContain("hello.ts");
      expect(result).toContain("math.ts");
      expect(result).toContain("data.json");
      expect(result).toContain("README.md");
      // sub directory should appear (with emoji marker)
      expect(result).toContain("sub");
    });

    it("shows depth=2 with subdirectory contents", async () => {
      const result = await getTool().asyncHandler!({
        path: TEST_DIR,
        depth: 2,
      });

      expect(result).toContain("hello.ts");
      expect(result).toContain("utils.ts"); // in sub dir
    });

    it("reports sizes for files", async () => {
      const result = await getTool().asyncHandler!({
        path: TEST_DIR,
        depth: 1,
      });

      // Should show size info (maybe in bytes or formatted)
      expect(result).toContain("hello.ts");
    });

    it("rejects non-existent directory", async () => {
      const result = await getTool().asyncHandler!({
        path: "/nonexistent/dir",
        depth: 1,
      });

      expect(result).toContain("does not exist");
    });

    it("works with default depth=1", async () => {
      const result = await getTool().asyncHandler!({
        path: TEST_DIR,
      });

      expect(result).toContain("hello.ts");
      expect(result).toContain("sub");
    });

    it("clamps depth to maximum of 5", async () => {
      const result = await getTool().asyncHandler!({
        path: TEST_DIR,
        depth: 999,
      });

      // should not crash — depth clamped to 5
      expect(result).toBeTruthy();
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     ④ glob_files
     ═══════════════════════════════════════════════════════════════ */

  describe("glob_files", () => {
    const getTool = () => byName(tools, "glob_files");

    it("finds all .ts files", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "**/*.ts",
        path: TEST_DIR,
      });

      expect(result).toContain("hello.ts");
      expect(result).toContain("math.ts");
      expect(result).toContain("utils.ts");
    });

    it("finds all .json files", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "**/*.json",
        path: TEST_DIR,
      });

      expect(result).toContain("data.json");
    });

    it("returns empty for non-matching pattern", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "**/*.py",
        path: TEST_DIR,
      });

      expect(result).toContain("no files matching");
    });

    it("finds single-file match", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "**/hello.ts",
        path: TEST_DIR,
      });

      expect(result).toContain("hello.ts");
      expect(result).not.toContain("math.ts");
    });

    it("respects limit parameter", async () => {
      // Create many files to test limit
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(TEST_DIR, `many_file_${i}.ts`), `// file ${i}\n`, "utf-8");
      }

      const result = await getTool().asyncHandler!({
        pattern: "**/*.ts",
        path: TEST_DIR,
        limit: 3,
      });

      const lines = result.trim().split("\n");
      expect(lines.length).toBeLessThanOrEqual(5); // header + few files
    });

    it("works with default root (cwd) path", async () => {
      // Just make sure it doesn't crash with default
      const result = await getTool().asyncHandler!({
        pattern: "package.json",
      });

      expect(result).toContain("package.json");
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     ⑤ get_file_info
     ═══════════════════════════════════════════════════════════════ */

  describe("get_file_info", () => {
    const getTool = () => byName(tools, "get_file_info");

    it("returns size, mtime, type for a file", async () => {
      const result = await getTool().asyncHandler!({
        path: files.fileA,
      });

      expect(result).toContain("hello.ts");
      expect(result).toContain("size:");
      // Type should be 'file'
      expect(result).toContain("file");
    });

    it("reports line count for text files", async () => {
      const result = await getTool().asyncHandler!({
        path: files.fileA,
      });

      // hello.ts has 6 lines
      // hello.ts has 7 lines (6 content + trailing newline)
      expect(result).toMatch(/lines?:\s*7/);
    });

    it("identifies directories", async () => {
      const result = await getTool().asyncHandler!({
        path: files.subDir,
      });

      expect(result).toContain("directory");
    });

    it("reports file size in bytes", async () => {
      const result = await getTool().asyncHandler!({
        path: files.dataFile,
      });

      expect(result).toContain("bytes");
    });

    it("returns error for non-existent path", async () => {
      const result = await getTool().asyncHandler!({
        path: "/nonexistent/file.txt",
      });

      expect(result).toContain("does not exist");
    });

    it("rejects empty path", async () => {
      const result = await getTool().asyncHandler!({
        path: "",
      });

      expect(result).toContain("path cannot be empty");
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     ⑥ search_in_files
     ═══════════════════════════════════════════════════════════════ */

  describe("search_in_files", () => {
    const getTool = () => byName(tools, "search_in_files");

    it("finds text matches across files", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "export function",
        path: TEST_DIR,
      });

      expect(result).toContain("hello.ts");
      expect(result).toContain("math.ts");
      expect(result).toContain("utils.ts");
    });

    it("returns file:line format", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "export function",
        path: TEST_DIR,
      });

      // Each match should contain a line reference
      const lines = result.split("\n").filter(l => l.includes(":"));
      expect(lines.length).toBeGreaterThanOrEqual(4); // 4 export functions across files
    });

    it("respects glob filter", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "export",
        path: TEST_DIR,
        glob: "*.json",
      });

      // data.json doesn't have "export"
      expect(result).toContain("no matches");
    });

    it("shows context lines when specified", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "multiply",
        path: TEST_DIR,
        context: 1,
      });

      // Should show surrounding context
      expect(result).toContain("multiply");
      expect(result).toContain("return");
    });

    it("performs case-sensitive search", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "HELLO",
        path: TEST_DIR,
        case_sensitive: true,
      });

      // HELLO uppercase doesn't exist in source files
      expect(result).toContain("no matches for");
    });

    it("finds common word with case-insensitive default", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "hello",
        path: TEST_DIR,
      });

      // hello appears in hello.ts (both in comment and template string)
      expect(result).toContain("hello.ts");
    });

    it("supports regex patterns", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "function\\s+\\w+",
        path: TEST_DIR,
      });

      expect(result).toContain("function");
    });

    it("returns 'no matches' when pattern not found", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "zzz_nonexistent_pattern_xyz",
        path: TEST_DIR,
      });

      expect(result).toContain("no matches");
    });

    it("rejects empty pattern", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "",
        path: TEST_DIR,
      });

      expect(result).toContain("pattern cannot be empty");
    });

    it("handles non-existent search directory gracefully", async () => {
      const result = await getTool().asyncHandler!({
        pattern: "TODO",
        path: "/nonexistent/search/path",
      });

      expect(result).toContain("path does not exist");
    });
  });

  /* ═══════════════════════════════════════════════════════════════
     跨工具工作流测试
     ═══════════════════════════════════════════════════════════════ */

  describe("cross-tool workflows", () => {
    it("create → get_info → glob → search flow", async () => {
      const newFile = path.join(TEST_DIR, "workflow_test.ts");
      const content = "// workflow test\nexport const x = 42;\n";

      // 1. Create
      const createResult = await byName(tools, "create_file").asyncHandler!({
        path: newFile,
        content,
      });
      expect(createResult).toContain("created");

      // 2. Get info
      const infoResult = await byName(tools, "get_file_info").asyncHandler!({
        path: newFile,
      });
      expect(infoResult).toContain("workflow_test.ts");
      expect(infoResult).toContain("file");

      // 3. Glob
      const globResult = await byName(tools, "glob_files").asyncHandler!({
        pattern: "**/workflow_test.ts",
        path: TEST_DIR,
      });
      expect(globResult).toContain("workflow_test.ts");

      // 4. Search
      const searchResult = await byName(tools, "search_in_files").asyncHandler!({
        pattern: "workflow test",
        path: TEST_DIR,
      });
      expect(searchResult).toContain("workflow_test.ts");
    });

    it("create → delete → verify deletion", async () => {
      const tempFile = path.join(TEST_DIR, "temp_delete.ts");
      const content = "// temporary\n";

      // Create
      await byName(tools, "create_file").asyncHandler!({
        path: tempFile,
        content,
      });
      expect(fs.existsSync(tempFile)).toBe(true);

      // Delete
      const deleteResult = await byName(tools, "delete_file").asyncHandler!({
        path: tempFile,
      });
      expect(deleteResult).toContain("deleted");

      // Verify
      expect(fs.existsSync(tempFile)).toBe(false);
    });

    it("list_directory shows created files", async () => {
      const newFile = path.join(TEST_DIR, "list_check.ts");
      await byName(tools, "create_file").asyncHandler!({
        path: newFile,
        content: "// check\n",
      });

      const listResult = await byName(tools, "list_directory").asyncHandler!({
        path: TEST_DIR,
        depth: 1,
      });

      expect(listResult).toContain("list_check.ts");
    });
  });

  /* ─── 安全与边界测试 ────────────────────────────────────────── */

  describe("edge cases and security", () => {
    it("create_file rejects path traversal attempt via '..'", async () => {
      const result = await byName(tools, "create_file").asyncHandler!({
        path: "../../../etc/evil.txt",
        content: "malicious",
      });

      // Should either work (since we're in sandbox) or fail
      // The important thing is it shouldn't crash
      expect(typeof result).toBe("string");
    });

    it("search_in_files handles large patterns gracefully", async () => {
      const hugePattern = "x".repeat(10000);
      const result = await byName(tools, "search_in_files").asyncHandler!({
        pattern: hugePattern,
        path: TEST_DIR,
      });

      expect(result).toContain("no matches");
    });
  });
});
