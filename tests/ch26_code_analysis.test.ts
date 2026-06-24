/**
 * 第 26 章测试 — 代码分析工具（AST 解析、依赖分析、复杂度、模式搜索、安全扫描）
 *
 * 覆盖：
 *   1. createCodeAnalysisTools — 5 个工具的 CatalogEntry 数组
 *   2. parse_ast — 解析 TypeScript 文件输出结构概览
 *   3. analyze_dependencies — 直接依赖 + 传递依赖
 *   4. analyze_complexity — 圈复杂度计算
 *   5. find_patterns — try-catch / promise-all / console-log / any-type / todo-comment
 *   6. scan_security — 硬编码密钥 / SQL 注入 / 命令注入 / eval / 路径遍历
 *   7. 错误处理 — 文件不存在、无效参数、不被支持的模式
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

import { createCodeAnalysisTools } from "../src/harness/tools/code_analysis.js";
import type { CatalogEntry } from "../src/harness/tools/selector.js";

/* ─── 辅助：创建临时测试文件 ──────────────────────────────────── */

const TEST_DIR = path.join(projectRoot, "tests", "__ch26_test_files");

interface TestFiles {
  main: string;
  helper: string;
  complex: string;
  securityRisk: string;
  patterns: string;
}

function createTestFiles(): TestFiles {
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const main = path.join(TEST_DIR, "main.ts");
  fs.writeFileSync(main, [
    'import { helper } from "./helper";',
    'import * as fs from "node:fs";',
    'import { EventEmitter } from "events";',
    '',
    "export interface UserConfig {",
    "  name: string;",
    "  age: number;",
    "}",
    "",
    "export type JsonValue = string | number | boolean | null;",
    "",
    "/**",
    " * Greet a user by name.",
    ' * @param name - The person to greet',
    " */",
    "export function greet(name: string): string {",
    '  if (!name) return "Hello, World!";',
    "  if (name.length > 100) return name.slice(0, 100);",
    '  return `Hello, ${name}!`;',
    "}",
    "",
    "export class Greeter {",
    "  private prefix: string;",
    "",
    "  constructor(prefix: string) {",
    "    this.prefix = prefix;",
    "  }",
    "",
    "  greet(name: string): string {",
    "    return `${this.prefix}, ${name}!`;",
    "  }",
    "}",
    "",
    "const DEFAULT_NAME = 'World';",
    "",
    "const greetFn = (n: string): string => `Hi ${n}`;",
    "",
  ].join("\n"), "utf-8");

  const helper = path.join(TEST_DIR, "helper.ts");
  fs.writeFileSync(helper, [
    'import { EventEmitter } from "events";',
    '',
    "export function helper(name: string): string {",
    "  return `helper(${name})`;",
    "}",
    "",
    "export const VERSION = '1.0.0';",
    "",
  ].join("\n"), "utf-8");

  const complex = path.join(TEST_DIR, "complex.ts");
  fs.writeFileSync(complex, [
    "/** A complex function for complexity testing */",
    "export function complexFn(a: number, b: number, c: number): number {",
    "  let result = 0;",
    "  if (a > 0) {",
    "    if (b > 0) {",
    "      if (c > 0) {",
    "        result = a + b + c;",
    "      } else {",
    "        result = a + b;",
    "      }",
    "    } else {",
    "      result = a;",
    "    }",
    "  } else {",
    "    for (let i = 0; i < 10; i++) {",
    "      result += i;",
    "    }",
    "  }",
    "  return result;",
    "}",
    "",
    "export function simpleFn(): string {",
    '  return "hello";',
    "}",
    "",
    "export const arrowComplex = (x: number): number => {",
    "  if (x < 0) return 0;",
    "  if (x > 100) return 100;",
    "  return x;",
    "};",
    "",
  ].join("\n"), "utf-8");

  const securityRisk = path.join(TEST_DIR, "security_risk.ts");
  fs.writeFileSync(securityRisk, [
    'const SECRET_KEY = "sk-1234567890abcdef";',
    "const password = 'super-secret-password';",
    '',
    "function query(db: any, input: string) {",
    '  const sql = "SELECT * FROM users WHERE name = \'" + input + "\'";',
    "  db.run(sql);",
    "}",
    "",
    "function runCmd(cmd: string) {",
    "  const result = require('child_process').execSync('ls ' + cmd);",
    "  return result;",
    "}",
    "",
    "function evaluate(code: string) {",
    "  return eval(code);",
    "}",
    "",
    "function loadFile(userPath: string) {",
    "  const fullPath = path.join('/var/data', userPath);",
    "  return fs.readFileSync(fullPath);",
    "}",
    "",
  ].join("\n"), "utf-8");

  const patterns = path.join(TEST_DIR, "patterns.ts");
  fs.writeFileSync(patterns, [
    "export async function loadData() {",
    "  try {",
    "    const data = await fetch('/api/data');",
    "    return data.json();",
    "  } catch (err) {",
    "    console.error('failed to load', err);",
    "    return null;",
    "  }",
    "}",
    "",
    "export async function loadAll() {",
    "  const [a, b] = await Promise.all([",
    "    fetch('/a'),",
    "    fetch('/b'),",
    "  ]);",
    "  return { a, b };",
    "}",
    "",
    "function processItem(item: any): any {",
    "  console.log('processing', item);",
    "  return item;",
    "}",
    "",
    "// TODO: refactor this to use proper error handling",
    "// FIXME: this is a temporary workaround",
    "",
    "function handler(_req: any, _res: any) {",
    '  return "ok";',
    "}",
    "",
  ].join("\n"), "utf-8");

  return { main, helper, complex, securityRisk, patterns };
}

function removeTestFiles(): void {
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

describe("ch26: code analysis tools", () => {
  let tools: CatalogEntry[];
  let files: TestFiles;

  beforeEach(() => {
    files = createTestFiles();
    tools = createCodeAnalysisTools(projectRoot);
  });

  afterEach(() => {
    removeTestFiles();
  });

  /* ─── 工具列表验证 ────────────────────────────────────────────── */

  it("creates 5 code analysis tools as CatalogEntry array", () => {
    const names = tools.map(t => t.definition.name);
    expect(names).toEqual([
      "parse_ast",
      "analyze_dependencies",
      "analyze_complexity",
      "find_patterns",
      "scan_security",
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

  /* ─── ① parse_ast ────────────────────────────────────────────── */

  describe("parse_ast", () => {
    it("returns AST outline with imports, exports, and internal symbols", async () => {
      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 1 });

      expect(result).toContain("AST outline for");
      expect(result).toContain("imports");
      expect(result).toContain("exports");
      expect(result).toContain("internal");
    });

    it("identifies imported modules", async () => {
      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 1 });

      expect(result).toContain("./helper");
      expect(result).toContain("node:fs");
      expect(result).toContain("events");
    });

    it("identifies exported symbols with their kinds", async () => {
      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 1 });

      expect(result).toContain("UserConfig");
      expect(result).toContain("JsonValue");
      expect(result).toContain("greet");
      expect(result).toContain("Greeter");
    });

    it("identifies exported interface and type alias", async () => {
      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 1 });

      expect(result).toContain("interface");
      expect(result).toContain("type-alias");
    });

    it("shows internal (non-exported) symbols", async () => {
      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 1 });

      expect(result).toContain("DEFAULT_NAME");
    });

    it("rejects empty file path", async () => {
      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const result = await tool.asyncHandler!({ file: "", depth: 1 });
      expect(result).toContain("file path is required");
    });

    it("returns error for non-existent file", async () => {
      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const result = await tool.asyncHandler!({ file: "/nonexistent/file.ts", depth: 1 });
      expect(result).toContain("file not found");
    });

    it("outputs total symbol count summary", async () => {
      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 1 });

      expect(result).toMatch(/total:/);
      expect(result).toMatch(/\d+ exported symbols/);
    });

    it("with depth=2 includes class method children", async () => {
      // Create a file with a class for depth testing
      const classFile = path.join(TEST_DIR, "class_depth.ts");
      fs.writeFileSync(classFile, [
        "export class Calculator {",
        "  add(a: number, b: number): number { return a + b; }",
        "  sub(a: number, b: number): number { return a - b; }",
        "}",
      ].join("\n"), "utf-8");

      const tool = tools.find(t => t.definition.name === "parse_ast")!;
      const resultDepth1 = await tool.asyncHandler!({ file: classFile, depth: 1 });
      const resultDepth2 = await tool.asyncHandler!({ file: classFile, depth: 2 });

      // Depth 2 should show methods inside the class
      expect(resultDepth2).toContain("add");
      expect(resultDepth2).toContain("sub");
    });
  });

  /* ─── ② analyze_dependencies ─────────────────────────────────── */

  describe("analyze_dependencies", () => {
    it("returns direct imports for depth=0", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_dependencies")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 0 });

      expect(result).toContain("Dependencies for");
      expect(result).toContain("./helper");
      expect(result).toContain("node:fs");
      expect(result).toContain("events");
      expect(result).toContain("external");
    });

    it("reports relative vs external imports correctly", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_dependencies")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 0 });

      // ./helper is a relative import (no [external] tag)
      // node:fs and events are external (have [external] tag)
      const lines = result.split("\n");
      const helperLine = lines.find(l => l.includes("./helper"));
      const fsLine = lines.find(l => l.includes("node:fs"));
      expect(helperLine).toBeTruthy();
      expect(fsLine).toBeTruthy();
      expect(helperLine).not.toContain("[external]");
      expect(fsLine).toContain("[external]");
    });

    it("rejects empty file path", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_dependencies")!;
      const result = await tool.asyncHandler!({ file: "", depth: 0 });
      expect(result).toContain("file path is required");
    });

    it("returns error for non-existent file", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_dependencies")!;
      const result = await tool.asyncHandler!({ file: "/fake/file.ts", depth: 0 });
      expect(result).toContain("file not found");
    });

    it("includes total import count in output", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_dependencies")!;
      const result = await tool.asyncHandler!({ file: files.main, depth: 0 });

      expect(result).toMatch(/external packages/);
    });
  });

  /* ─── ③ analyze_complexity ───────────────────────────────────── */

  describe("analyze_complexity", () => {
    it("returns complexity scores for each function", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_complexity")!;
      const result = await tool.asyncHandler!({ file: files.complex, threshold: 0 });

      expect(result).toContain("Cyclomatic complexity");
      expect(result).toContain("complexFn");
      expect(result).toContain("simpleFn");
      expect(result).toContain("arrowComplex");
    });

    it("complexFn has higher score than simpleFn", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_complexity")!;
      const result = await tool.asyncHandler!({ file: files.complex, threshold: 0 });

      // complexFn has multiple if/else branches and a for loop → higher complexity
      // simpleFn just returns a string → complexity 1
      const complexLine = result.split("\n").find(l => l.includes("complexFn"));
      const simpleLine = result.split("\n").find(l => l.includes("simpleFn"));

      const complexScore = parseInt(complexLine?.match(/\d+/)?.[0] ?? "0", 10);
      const simpleScore = parseInt(simpleLine?.match(/\d+/)?.[0] ?? "99", 10);

      expect(complexScore).toBeGreaterThan(simpleScore);
    });

    it("filters by threshold", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_complexity")!;
      const resultHigh = await tool.asyncHandler!({ file: files.complex, threshold: 10 });

      // With threshold 10, simpleFn (complexity 1) should be excluded
      expect(resultHigh).not.toContain("simpleFn");
    });

    it("returns 'no functions' message when no functions found in empty file", async () => {
      const emptyFile = path.join(TEST_DIR, "empty.ts");
      fs.writeFileSync(emptyFile, "// just a comment\n", "utf-8");

      const tool = tools.find(t => t.definition.name === "analyze_complexity")!;
      const result = await tool.asyncHandler!({ file: emptyFile, threshold: 0 });
      expect(result).toContain("no functions found");
    });

    it("rejects empty file path", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_complexity")!;
      const result = await tool.asyncHandler!({ file: "", threshold: 0 });
      expect(result).toContain("file path is required");
    });

    it("includes average and max in summary", async () => {
      const tool = tools.find(t => t.definition.name === "analyze_complexity")!;
      const result = await tool.asyncHandler!({ file: files.complex, threshold: 0 });

      expect(result).toContain("Average:");
      expect(result).toContain("Max:");
    });
  });

  /* ─── ④ find_patterns ────────────────────────────────────────── */

  describe("find_patterns", () => {
    it("finds try-catch patterns", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const result = await tool.asyncHandler!({ pattern: "try-catch", path: files.patterns });

      expect(result).toContain("try-catch");
      expect(result).toContain("patterns.ts");
    });

    it("finds promise-all patterns", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const result = await tool.asyncHandler!({ pattern: "promise-all", path: files.patterns });

      expect(result).toContain("promise-all");
      expect(result).toContain("Promise.all");
    });

    it("finds console-log patterns", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const result = await tool.asyncHandler!({ pattern: "console-log", path: files.patterns });

      expect(result).toContain("console-log");
      expect(result).toContain("console.error");
      expect(result).toContain("console.log");
    });

    it("finds any-type patterns", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const result = await tool.asyncHandler!({ pattern: "any-type", path: files.patterns });

      expect(result).toContain("any-type");
      expect(result).toContain("any");
    });

    it("finds todo-comment patterns", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const result = await tool.asyncHandler!({ pattern: "todo-comment", path: files.patterns });

      expect(result).toContain("todo-comment");
      expect(result).toContain("TODO");
      expect(result).toContain("FIXME");
    });

    it("finds unused-parameter patterns", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const result = await tool.asyncHandler!({ pattern: "unused-parameter", path: files.patterns });

      expect(result).toContain("unused-parameter");
      expect(result).toContain("_req");
      expect(result).toContain("_res");
    });

    it("returns 'no matches' for unsupported pattern name", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const result = await tool.asyncHandler!({ pattern: "nonexistent-pattern", path: files.patterns });
      expect(result).toContain("Unknown pattern");
    });

    it("returns 'no matches' when pattern not found", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const cleanFile = path.join(TEST_DIR, "clean.ts");
      fs.writeFileSync(cleanFile, "export const x = 1;\n", "utf-8");

      const result = await tool.asyncHandler!({ pattern: "try-catch", path: cleanFile });
      expect(result).toContain("no matches");
    });

    it("returns 'no matches' for non-existent directory", async () => {
      const tool = tools.find(t => t.definition.name === "find_patterns")!;
      const result = await tool.asyncHandler!({ pattern: "console-log", path: "/nonexistent/path" });
      expect(result).toContain("no matches");
    });
  });

  /* ─── ⑤ scan_security ────────────────────────────────────────── */

  describe("scan_security", () => {
    it("finds hardcoded secrets", async () => {
      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const result = await tool.asyncHandler!({ path: files.securityRisk, severity: "info" });

      expect(result).toContain("hardcoded-secret");
      expect(result).toContain("SECRET_KEY");
      expect(result).toContain("password");
    });

    it("finds SQL injection patterns", async () => {
      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const result = await tool.asyncHandler!({ path: files.securityRisk, severity: "info" });

      expect(result).toContain("sql-injection");
    });

    it("finds command injection patterns", async () => {
      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const result = await tool.asyncHandler!({ path: files.securityRisk, severity: "info" });

      expect(result).toContain("command-injection");
    });

    it("finds eval usage", async () => {
      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const result = await tool.asyncHandler!({ path: files.securityRisk, severity: "info" });

      expect(result).toContain("eval-usage");
      expect(result).toContain("eval");
    });

    it("finds path traversal risks", async () => {
      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const result = await tool.asyncHandler!({ path: files.securityRisk, severity: "info" });

      expect(result).toContain("path-traversal");
    });

    it("reports 'no issues found' for clean file", async () => {
      const cleanFile = path.join(TEST_DIR, "clean.ts");
      fs.writeFileSync(cleanFile, [
        "const a: number = 1;",
        "function add(x: number, y: number): number { return x + y; }",
      ].join("\n"), "utf-8");

      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const result = await tool.asyncHandler!({ path: cleanFile, severity: "error" });
      expect(result).toContain("no issues found");
    });

    it("filters by severity level", async () => {
      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const resultError = await tool.asyncHandler!({ path: files.securityRisk, severity: "error" });

      // With severity=error, only hardcoded-secrets, sql-injection, command-injection should show
      expect(resultError).toContain("hardcoded-secret");
      expect(resultError).toContain("sql-injection");
      expect(resultError).not.toContain("eval-usage"); // eval is warning level
    });

    it("returns error for invalid severity", async () => {
      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const result = await tool.asyncHandler!({ path: files.securityRisk, severity: "critical" });
      expect(result).toContain("invalid severity");
    });

    it("returns summary counts", async () => {
      const tool = tools.find(t => t.definition.name === "scan_security")!;
      const result = await tool.asyncHandler!({ path: files.securityRisk, severity: "info" });

      expect(result).toContain("Summary:");
      expect(result).toContain("errors");
      expect(result).toContain("warnings");
    });
  });

  /* ─── 跨工具测试 ─────────────────────────────────────────────── */

  it("all tools can be called without crashing on a real TS file", async () => {
    const realFile = "src/harness/tools/code_analysis.ts";

    for (const tool of tools) {
      const name = tool.definition.name;
      const args: Record<string, unknown> = { file: realFile, depth: 1 };

      if (name === "analyze_dependencies") {
        args.depth = 0;
      } else if (name === "analyze_complexity") {
        args.threshold = 0;
      } else if (name === "find_patterns") {
        args.pattern = "console-log";
        args.path = realFile;
        delete args.file;
        delete args.depth;
      } else if (name === "scan_security") {
        args.path = realFile;
        args.severity = "info";
        delete args.file;
        delete args.depth;
      }

      const result = await tool.asyncHandler!(args);
      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
    }
  });
});
