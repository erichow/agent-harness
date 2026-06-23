/**
 * 第 11 章测试 — ACI 文件工具：Viewport 读取 + 行范围编辑
 *
 * 覆盖：
 *   readFileViewport:
 *     1. 基本读取 + 行号渲染
 *     2. Envelope footer（行范围、MORE 指示）
 *     3. offset 参数
 *     4. limit 参数 + 上限 clamp
 *     5. 错误处理（不存在、是目录）
 *     6. 空路径
 *     7. 小文件（完整显示）
 *     8. 通过 registry 集成
 *
 *   editLines:
 *     9. 替换一段行
 *    10. 删除行
 *    11. 插入（不覆盖）
 *    12. 追加
 *    13. 边界检查
 *    14. context 预览
 *    15. 文件不存在
 *    16. 通过 registry 集成
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
import { fileViewportTool, editLinesTool } from "../src/harness/tools/files.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

const TEST_DIR = ".test-ch11";

/** 创建测试文件 */
function createTestFile(name: string, lines: string[]): string {
  const filePath = path.join(TEST_DIR, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

function removeTestFile(filePath: string): void {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

describe("readFileViewport", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /* ─── 基本读取 ──────────────────────────────────────────────── */

  it("reads first 100 lines by default", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const filePath = createTestFile("basic.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath });

    // 包含行号（trailing newline 会使总行数+1）
    expect(result).toContain(" 1  line 1");
    expect(result).toContain("50  line 50");

    // Envelope footer
    expect(result).toContain("[file:");
    expect(result).toContain("end of file");
    expect(result).toContain("of 51");
    expect(result).not.toContain("MORE below");
  });

  it("shows MORE below indicator when file exceeds limit", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const filePath = createTestFile("long.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath });

    expect(result).toContain("lines 1-100 of 201");
    expect(result).toContain("MORE below — call with offset=100");
    expect(result).not.toContain("MORE above");
  });

  it("uses custom offset", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const filePath = createTestFile("offset.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath, offset: 150 });

    expect(result).toContain("151  line 151");
    expect(result).toContain("lines 151-201 of 201");
    expect(result).toContain("MORE above — call with offset=0");
    expect(result).toContain("end of file");
  });

  it("shows both MORE indicators in the middle", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
    const filePath = createTestFile("middle.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath, offset: 200 });

    expect(result).toContain("MORE below — call with offset=300");
    expect(result).toContain("MORE above — call with offset=0");
    expect(result).not.toContain("end of file");
  });

  /* ─── limit 参数 ────────────────────────────────────────────── */

  it("respects custom limit", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const filePath = createTestFile("custom-limit.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath, limit: 20 });

    expect(result).toContain("lines 1-20 of 201");
    expect(result).toContain(" 1  line 1");
    expect(result).toContain("20  line 20");
    expect(result).not.toContain("21  line 21");
  });

  it("clamps limit to max 500", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    const filePath = createTestFile("clamp.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath, limit: 9999 });

    // 最多 500 行 + header 行
    const lineCount = result.split("\n").filter((l) => /^\s+\d+\s+line/.test(l)).length;
    expect(lineCount).toBeLessThanOrEqual(500);
    expect(result).toContain("lines 1-500 of 1001");
  });

  it("clamps limit to minimum 1", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const filePath = createTestFile("min-limit.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath, limit: 0 });

    expect(result).toContain("lines 1-1 of 11");
  });

  /* ─── 行号对齐 ──────────────────────────────────────────────── */

  it("pads line numbers for alignment", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    const filePath = createTestFile("padding.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath, limit: 3 });

    // 1000 行需要 4 位宽度
    expect(result).toContain("   1  line 1");
    expect(result).toContain("   2  line 2");
    expect(result).toContain("   3  line 3");
  });

  /* ─── 错误处理 ──────────────────────────────────────────────── */

  it("returns error for non-existent file", () => {
    const [_, handler] = fileViewportTool();
    const result = handler({ path: "/tmp/non-existent-xyz-12345" });
    expect(result).toContain("file does not exist");
  });

  it("returns error for directory", () => {
    const [_, handler] = fileViewportTool();
    const result = handler({ path: TEST_DIR });
    expect(result).toContain("not a regular file");
  });

  it("returns error for empty path", () => {
    const [_, handler] = fileViewportTool();
    const result = handler({ path: "" });
    expect(result).toContain("path cannot be empty");
  });

  /* ─── 小文件 ────────────────────────────────────────────────── */

  it("shows entire small file", () => {
    const lines = ["short", "file", "here"];
    const filePath = createTestFile("small.txt", lines);
    const [_, handler] = fileViewportTool();

    const result = handler({ path: filePath });

    expect(result).toContain("1  short");
    expect(result).toContain("2  file");
    expect(result).toContain("3  here");
    expect(result).toContain("lines 1-4 of 4");
    expect(result).toContain("end of file");
  });

  /* ─── Registry 集成 ─────────────────────────────────────────── */

  it("works through the registry", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `data ${i}`);
    const filePath = createTestFile("registry-test.txt", lines);
    const registry = new ToolRegistry();
    registry.register(...fileViewportTool());

    const result = registry.execute(
      "read_file_viewport",
      { path: filePath },
      "call-1",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain(" 1  data 0");
    expect(result.content).toContain("lines 1-31 of 31");
  });

  /* ─── 自测：读项目文件 ──────────────────────────────────────── */

  it("can read its own source file", () => {
    const [_, handler] = fileViewportTool();
    const result = handler({
      path: path.join(PROJECT_ROOT, "src/harness/tools/files.ts"),
      limit: 5,
    });
    expect(result).toContain("file:");
    expect(result).toContain("lines 1-5 of");
    expect(result).toContain(" 1");
  });
});

/* ─── editLines ──────────────────────────────────────────────────── */

describe("editLines", () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  let originalContent: string[];
  let filePath: string;

  beforeEach(() => {
    originalContent = [
      "line 1: intro",
      "line 2: setup",
      "line 3: middle",
      "line 4: process",
      "line 5: cleanup",
      "line 6: teardown",
      "line 7: done",
    ];
    filePath = createTestFile("edit-test.txt", originalContent);
  });

  /* ─── 替换 ──────────────────────────────────────────────────── */

  it("replaces a line range", () => {
    const [_, handler] = editLinesTool();
    const result = handler({
      path: filePath,
      start_line: 3,
      end_line: 5,
      replacement: "line 3: REPLACED\nline 4: STILL HERE",
    });

    expect(result).toContain("edited");
    expect(result).toContain("removed 3 lines");
    expect(result).toContain("added 2 lines");

    // 验证文件内容
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("line 3: REPLACED");
    expect(content).toContain("line 4: STILL HERE");
    expect(content).not.toContain("line 3: middle");
    expect(content).not.toContain("line 5: cleanup");
    // 前后的行保留
    expect(content).toContain("line 2: setup");
    expect(content).toContain("line 6: teardown");
  });

  /* ─── 删除 ──────────────────────────────────────────────────── */

  it("deletes lines with empty replacement", () => {
    const [_, handler] = editLinesTool();
    const result = handler({
      path: filePath,
      start_line: 2,
      end_line: 4,
      replacement: "",
    });

    expect(result).toContain("removed 3 lines");
    expect(result).toContain("added 0 lines");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("line 1: intro");
    expect(content).toContain("line 5: cleanup");
    expect(content).not.toContain("line 2: setup");
    expect(content).not.toContain("line 3: middle");
    expect(content).not.toContain("line 4: process");
  });

  /* ─── 插入 ──────────────────────────────────────────────────── */

  it("inserts at position without removing", () => {
    const [_, handler] = editLinesTool();
    // Insert before line 3: start=3, end=2
    const result = handler({
      path: filePath,
      start_line: 3,
      end_line: 2,
      replacement: "line 2.5: inserted",
    });

    expect(result).toContain("removed 0 lines");
    expect(result).toContain("added 1 lines");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("line 2.5: inserted");
    // 原始 line 3 仍然在
    const lines = content.split(/\r?\n/);
    expect(lines[2]).toContain("inserted");
    expect(lines[3]).toContain("line 3: middle");
  });

  /* ─── 追加 ──────────────────────────────────────────────────── */

  it("appends to end of file", () => {
    const [_, handler] = editLinesTool();
    const result = handler({
      path: filePath,
      start_line: 8,
      end_line: 7,
      replacement: "line 8: appended",
    });

    expect(result).toContain("added 1 lines");

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("line 8: appended");
    expect(content).toContain("line 7: done");
  });

  /* ─── 边界检查 ──────────────────────────────────────────────── */

  it("rejects start_line out of range", () => {
    const [_, handler] = editLinesTool();
    const result = handler({
      path: filePath,
      start_line: 100,
      end_line: 100,
      replacement: "nope",
    });

    expect(result).toContain("out of range");
  });

  it("rejects end_line before start_line - 1", () => {
    const [_, handler] = editLinesTool();
    const result = handler({
      path: filePath,
      start_line: 5,
      end_line: 2,
      replacement: "nope",
    });

    expect(result).toContain("out of range");
  });

  /* ─── context 预览 ──────────────────────────────────────────── */

  it("includes context preview in result", () => {
    const [_, handler] = editLinesTool();
    const result = handler({
      path: filePath,
      start_line: 3,
      end_line: 3,
      replacement: "line 3: UPDATED",
    });

    // Should show context lines around the edit
    expect(result).toContain("context:");
    // Line 2 (before edit)
    expect(result).toContain("line 2: setup");
    // Line 3 (edited)
    expect(result).toContain("line 3: UPDATED");
    // Line 4 (after edit)
    expect(result).toContain("line 4: process");
  });

  /* ─── 文件不存在 ────────────────────────────────────────────── */

  it("returns error for non-existent file", () => {
    const [_, handler] = editLinesTool();
    const result = handler({
      path: "/tmp/non-existent-xyz",
      start_line: 1,
      end_line: 1,
      replacement: "",
    });
    expect(result).toContain("file does not exist");
  });

  it("returns error for empty path", () => {
    const [_, handler] = editLinesTool();
    const result = handler({
      path: "",
      start_line: 1,
      end_line: 1,
      replacement: "",
    });
    expect(result).toContain("path cannot be empty");
  });

  /* ─── Registry 集成 ─────────────────────────────────────────── */

  it("works through the registry", () => {
    const registry = new ToolRegistry();
    registry.register(...editLinesTool());

    const result = registry.execute(
      "edit_lines",
      {
        path: filePath,
        start_line: 2,
        end_line: 2,
        replacement: "line 2: CHANGED",
      },
      "call-1",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("edited");
    expect(result.content).toContain("CHANGED");
  });

  /* ─── 保留尾换行 ────────────────────────────────────────────── */

  it("preserves trailing newline of original file", () => {
    const [_, handler] = editLinesTool();
    handler({
      path: filePath,
      start_line: 1,
      end_line: 1,
      replacement: "line 1: updated",
    });

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });
});
