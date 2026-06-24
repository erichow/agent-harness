/**
 * 第 25 章测试 — LSP 语言服务器协议集成
 *
 * 覆盖：
 *   1. 工具列表 — 6 个 LSP 工具的 CatalogEntry 数组
 *   2. MockLSPManager — 预设数据的 mock server
 *   3. lsp_definition — 跳转到定义
 *   4. lsp_references — 查找引用
 *   5. lsp_hover — 悬停文档
 *   6. lsp_completion — 补全建议
 *   7. lsp_signature_help — 函数签名
 *   8. lsp_diagnostic — 文件诊断
 *   9. 错误处理 — server 未初始化、无效参数
 *  10. 上下文片段格式化
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

import { createLSPTools, MockLSPManager } from "../src/harness/tools/lsp.js";
import type { CatalogEntry } from "../src/harness/tools/selector.js";
import type {
  LspLocation, LspHoverResult, LspCompletionItem,
  LspSignatureInfo, LspDiagnosticItem,
} from "../src/harness/tools/lsp.js";

/* ─── 辅助：创建临时测试文件 ──────────────────────────────────── */

const TEST_FILE = path.join(projectRoot, "tests", "__ch25_test_file.ts");

function writeTestFile(): void {
  const content = [
    "/**",
    " * Test file for LSP integration tests",
    " */",
    "function greet(name: string): string {",
    '  return `Hello, ${name}!`;',
    "}",
    "",
    "interface Person {",
    "  name: string;",
    "  age: number;",
    "}",
    "",
    "const alice: Person = {",
    '  name: "Alice",',
    "  age: 30,",
    "};",
    "",
    "// Call the function",
    "greet(alice.name);",
    "",
  ].join("\n");
  fs.writeFileSync(TEST_FILE, content, "utf-8");
}

function removeTestFile(): void {
  try { fs.unlinkSync(TEST_FILE); } catch { /* ok */ }
}

describe("ch25: LSP integration tools", () => {
  let tools: CatalogEntry[];
  let mockLsp: MockLSPManager;

  beforeEach(() => {
    writeTestFile();
    mockLsp = new MockLSPManager(projectRoot);
    tools = createLSPTools(projectRoot, mockLsp);
  });

  afterEach(() => {
    removeTestFile();
  });

  /* ─── 工具列表验证 ────────────────────────────────────────────── */

  it("creates 6 LSP tools as CatalogEntry array", () => {
    const names = tools.map(t => t.definition.name);
    expect(names).toEqual([
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
      "lsp_completion",
      "lsp_signature_help",
      "lsp_diagnostic",
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

  it("each tool has required file + line + column in schema", () => {
    for (const tool of tools) {
      const schema = tool.definition.inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("file");
      expect(props).toHaveProperty("line");
      expect(props).toHaveProperty("column");
    }
  });

  /* ─── MockLSPManager ──────────────────────────────────────────── */

  it("MockLSPManager is initialized by default", () => {
    expect(mockLsp.isInitialized).toBe(true);
  });

  it("MockLSPManager stores and returns preset definitions", async () => {
    const loc: LspLocation = {
      uri: `file://${TEST_FILE}`,
      range: { start: { line: 4, character: 10 }, end: { line: 4, character: 22 } },
    };
    mockLsp.setMockDefinition(`${TEST_FILE}:4:10`, loc);
    const result = await mockLsp.getDefinition(TEST_FILE, 4, 10);
    expect(result).toEqual(loc);
  });

  it("MockLSPManager returns null for unknown positions", async () => {
    const result = await mockLsp.getDefinition(TEST_FILE, 1, 1);
    expect(result).toBeNull();
  });

  /* ─── lsp_definition ──────────────────────────────────────────── */

  it("lsp_definition returns definition location with context snippet", async () => {
    const loc: LspLocation = {
      uri: `file://${TEST_FILE}`,
      range: { start: { line: 4, character: 10 }, end: { line: 4, character: 22 } },
    };
    mockLsp.setMockDefinition(`${TEST_FILE}:4:10`, loc);

    const tool = tools.find(t => t.definition.name === "lsp_definition")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 4, column: 10 });

    expect(result).toContain("definition:");
    expect(result).toContain("greet");
  });

  it("lsp_definition returns 'no definition found' for unknown symbol", async () => {
    const tool = tools.find(t => t.definition.name === "lsp_definition")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 1, column: 1 });
    expect(result).toContain("no definition found");
  });

  /* ─── lsp_references ──────────────────────────────────────────── */

  it("lsp_references returns reference locations with context", async () => {
    const refs: LspLocation[] = [
      {
        uri: `file://${TEST_FILE}`,
        range: { start: { line: 18, character: 0 }, end: { line: 18, character: 5 } },
      },
    ];
    mockLsp.setMockReferences(`${TEST_FILE}:4:10`, refs);

    const tool = tools.find(t => t.definition.name === "lsp_references")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 4, column: 10 });
    expect(result).toContain("1 results");
    expect(result).toContain("references:");
  });

  it("lsp_references returns '(no results)' for unreferenced symbol", async () => {
    mockLsp.setMockReferences(`${TEST_FILE}:99:1`, []);

    const tool = tools.find(t => t.definition.name === "lsp_references")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 99, column: 1 });
    expect(result).toContain("no results");
  });

  /* ─── lsp_hover ───────────────────────────────────────────────── */

  it("lsp_hover returns type signature and documentation", async () => {
    mockLsp.setMockHover(`${TEST_FILE}:4:10`, {
      contents: "function greet(name: string): string\n\nJSDoc for greet",
    });

    const tool = tools.find(t => t.definition.name === "lsp_hover")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 4, column: 10 });
    expect(result).toContain("hover at");
    expect(result).toContain("greet");
  });

  it("lsp_hover returns 'no hover information' for untyped positions", async () => {
    const tool = tools.find(t => t.definition.name === "lsp_hover")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 1, column: 1 });
    expect(result).toContain("no hover information");
  });

  /* ─── lsp_completion ──────────────────────────────────────────── */

  it("lsp_completion returns suggestion list", async () => {
    mockLsp.setMockCompletion(`${TEST_FILE}:18:1`, [
      { label: "greet", detail: "(name: string): string", kind: 2 },
      { label: "console", detail: "var", kind: 7 },
    ]);

    const tool = tools.find(t => t.definition.name === "lsp_completion")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 18, column: 1 });
    expect(result).toContain("2 items");
    expect(result).toContain("greet");
    expect(result).toContain("console");
  });

  it("lsp_completion returns empty message when no suggestions", async () => {
    mockLsp.setMockCompletion(`${TEST_FILE}:1:1`, []);

    const tool = tools.find(t => t.definition.name === "lsp_completion")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 1, column: 1 });
    expect(result).toContain("no completions");
  });

  /* ─── lsp_signature_help ──────────────────────────────────────── */

  it("lsp_signature_help returns function signature with parameters", async () => {
    mockLsp.setMockSignature(`${TEST_FILE}:18:1`, {
      label: "greet(name: string): string",
      parameters: [
        { label: "name: string", documentation: "The name to greet" },
      ],
      activeParameter: 0,
    });

    const tool = tools.find(t => t.definition.name === "lsp_signature_help")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 18, column: 1 });
    expect(result).toContain("signature:");
    expect(result).toContain("greet");
    expect(result).toContain("name: string");
  });

  it("lsp_signature_help returns 'no signature' outside function calls", async () => {
    const tool = tools.find(t => t.definition.name === "lsp_signature_help")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 1, column: 1 });
    expect(result).toContain("no signature");
  });

  /* ─── lsp_diagnostic ──────────────────────────────────────────── */

  it("lsp_diagnostic returns sorted diagnostics list", async () => {
    mockLsp.setMockDiagnostics(TEST_FILE, [
      { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } },
        severity: 2, message: "'greet' is assigned but never used", source: "ts",
        code: "noUnusedLocals" },
      { range: { start: { line: 10, character: 0 }, end: { line: 10, character: 15 } },
        severity: 1, message: "Type 'number' is not assignable to type 'string'",
        source: "ts", code: 2322 },
    ]);

    const tool = tools.find(t => t.definition.name === "lsp_diagnostic")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 1, column: 1 });
    expect(result).toContain("1 errors");
    expect(result).toContain("1 warnings");
    expect(result).toContain("2322");
  });

  it("lsp_diagnostic returns 'file is clean' when no diagnostics", async () => {
    mockLsp.setMockDiagnostics(TEST_FILE, []);

    const tool = tools.find(t => t.definition.name === "lsp_diagnostic")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 1, column: 1 });
    expect(result).toContain("no diagnostics");
  });

  /* ─── 错误处理 ────────────────────────────────────────────────── */

  it("returns LSP-not-initialized message when no manager given", async () => {
    const toolsNoLsp = createLSPTools(projectRoot);
    const tool = toolsNoLsp.find(t => t.definition.name === "lsp_definition")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 4, column: 10 });
    expect(result).toContain("LSP not initialized");
  });

  it("rejects invalid line number", async () => {
    const tool = tools.find(t => t.definition.name === "lsp_definition")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 0, column: 1 });
    expect(result).toContain("line must be a positive integer");
  });

  it("rejects invalid column number", async () => {
    const tool = tools.find(t => t.definition.name === "lsp_definition")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 4, column: -1 });
    expect(result).toContain("column must be a positive integer");
  });

  it("rejects empty file path", async () => {
    const tool = tools.find(t => t.definition.name === "lsp_definition")!;
    const result = await tool.asyncHandler!({ file: "", line: 4, column: 10 });
    expect(result).toContain("file path is required");
  });

  /* ─── 上下文片段格式化 ────────────────────────────────────────── */

  it("lsp_definition includes code context snippet around definition", async () => {
    // Create a mock definition for the `greet` function at line 4
    const loc: LspLocation = {
      uri: `file://${TEST_FILE}`,
      range: { start: { line: 4, character: 10 }, end: { line: 4, character: 15 } },
    };
    mockLsp.setMockDefinition(`${TEST_FILE}:4:10`, loc);

    const tool = tools.find(t => t.definition.name === "lsp_definition")!;
    const result = await tool.asyncHandler!({ file: TEST_FILE, line: 4, column: 10 });

    // Should include the function definition line (line 4)
    expect(result).toContain("function greet");
    // Should include surrounding context
    expect(result).toContain("/**");       // JSDoc above (line 2)
    expect(result).toContain("Hello");     // Inside the function body (line 5)
  });
});
