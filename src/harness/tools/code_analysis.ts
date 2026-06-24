/**
 * 代码分析工具（第 26 章）
 *
 * 为 agent 提供 LSP scope 之外的结构化代码理解——AST 解析、依赖图、
 * 圈复杂度、模式搜索、安全扫描。
 *
 * 工具清单：
 *   1. parse_ast             — 解析文件 AST 输出结构概览
 *   2. analyze_dependencies  — 分析 import/require 依赖图
 *   3. analyze_complexity    — 计算圈复杂度（McCabe 度量）
 *   4. find_patterns         — 按 AST 结构模板搜索代码模式
 *   5. scan_security         — 安全扫描
 *
 * 底层使用 @babel/parser 做 AST 解析 + 自定义递归 walker。
 */
import * as parser from "@babel/parser";
import type * as BabelTypes from "@babel/types";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogEntry } from "./selector.js";
import type { ToolDefinition } from "./registry.js";

/* ═══════════════════════════════════════════════════════════════════
   AST Walker — 递归遍历 Babel AST，无需 @babel/traverse
   ═══════════════════════════════════════════════════════════════════ */

type AstNode = Record<string, unknown> & { type: string };

/** 遍历 AST 的访问者回调 */
interface VisitorCallbacks {
  enter?: (node: AstNode, parents: AstNode[]) => void;
  leave?: (node: AstNode, parents: AstNode[]) => void;
}

/** 递归 AST walker */
function walkAst(node: AstNode, visitors: VisitorCallbacks, parents: AstNode[] = []): void {
  if (!node || typeof node !== "object") return;

  visitors.enter?.(node, parents);

  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" ||
        key === "errors" || key === "leadingComments" || key === "trailingComments" ||
        key === "innerComments") {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && (item as AstNode).type) {
          walkAst(item as AstNode, visitors, [...parents, node]);
        }
      }
    } else if (child && typeof child === "object" && (child as AstNode).type) {
      walkAst(child as AstNode, visitors, [...parents, node]);
    }
  }

  visitors.leave?.(node, parents);
}

/** 获取节点所在行号（1-based） */
function nodeLine(node: AstNode): number {
  const loc = node.loc as { start: { line: number } } | undefined;
  return loc?.start.line ?? 0;
}

/** 获取节点所在列号（1-based） */
function nodeColumn(node: AstNode): number {
  const loc = node.loc as { start: { column: number } } | undefined;
  return (loc?.start.column ?? 0) + 1;
}

/* ═══════════════════════════════════════════════════════════════════
   辅助函数
   ═══════════════════════════════════════════════════════════════════ */

/** 解析文件内容为 AST */
function parseToAst(filePath: string): {
  ast: AstNode;
  content: string;
  sourceType: "module" | "script";
} {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf-8");

  // 检测源类型
  const ext = path.extname(filePath).toLowerCase();
  const isModule = ext === ".mjs" || ext === ".mts" || content.includes("import ") || content.includes("export ");

  const plugins = ["decorators"] as string[];
  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
    plugins.push("typescript");
  }
  if (ext === ".tsx") {
    plugins.push("jsx");
  }

  const ast = parser.parse(content, {
    sourceType: isModule ? "module" : "script",
    plugins: plugins as any,
    attachComment: true,
  });

  return { ast: ast as unknown as AstNode, content, sourceType: isModule ? "module" : "script" };
}

/** 从 AST node 中提取符号名 */
function getNodeName(node: AstNode): string {
  if (node.id && typeof node.id === "object" && (node.id as AstNode).type) {
    return String((node.id as Record<string, unknown>).name ?? "anonymous");
  }
  if (node.key && typeof node.key === "object" && (node.key as AstNode).type === "Identifier") {
    return String((node.key as Record<string, unknown>).name ?? "");
  }
  return "anonymous";
}

/* ═══════════════════════════════════════════════════════════════════
   ① parse_ast — AST 结构概览
   ═══════════════════════════════════════════════════════════════════ */

interface AstSymbol {
  name: string;
  kind: string;
  line: number;
  column: number;
  children: AstSymbol[];
}

function parseAstOutline(filePath: string, depth: number): AstSymbol[] {
  const { ast } = parseToAst(filePath);
  const program = ast.program as AstNode;
  const symbols: AstSymbol[] = [];

  for (const stmt of (program.body as AstNode[])) {
    const symbol = extractTopLevelSymbol(stmt, depth);
    if (symbol) {
      symbols.push(symbol);
    }
  }

  return symbols;
}

function extractTopLevelSymbol(node: AstNode, depth: number): AstSymbol | null {
  const type = node.type;

  switch (type) {
    case "ImportDeclaration": {
      const source = node.source as AstNode;
      const specifiers = node.specifiers as AstNode[];
      const imported = specifiers.map((s) => {
        if (s.type === "ImportDefaultSpecifier") {
          return `${getNodeName(s)} (default)`;
        }
        if (s.type === "ImportNamespaceSpecifier") {
          return `${getNodeName(s)} (namespace)`;
        }
        // ImportSpecifier
        const importedName = (s.imported as AstNode)?.name ?? getNodeName(s);
        const localName = getNodeName(s);
        return importedName !== localName ? `${localName} as ${importedName}` : localName;
      }).join(", ");
      return {
        name: `from ${sourceValue(source)}`,
        kind: "import",
        line: nodeLine(node),
        column: nodeColumn(node),
        children: imported ? [{ name: imported, kind: "specifiers", line: nodeLine(node), column: 0, children: [] }] : [],
      };
    }

    case "ExportNamedDeclaration": {
      const declaration = node.declaration as AstNode | undefined;
      if (declaration) {
        const inner = extractTopLevelSymbol(declaration, depth);
        if (inner) {
          inner.name = `export ${inner.name}`;
          return inner;
        }
      }
      // re-exports
      const specifiers = node.specifiers as AstNode[] | undefined;
      if (specifiers && specifiers.length > 0) {
        const names = specifiers.map((s) => {
          const exported = (s.exported as AstNode)?.name ?? "";
          const local = (s.local as AstNode)?.name ?? "";
          return local !== exported ? `${local} as ${exported}` : exported;
        }).join(", ");
        return { name: `export { ${names} }`, kind: "re-export", line: nodeLine(node), column: nodeColumn(node), children: [] };
      }
      return null;
    }

    case "ExportDefaultDeclaration": {
      const decl = node.declaration as AstNode;
      const innerName = getNodeName(decl) || "default";
      return { name: `export default ${innerName}`, kind: "export-default", line: nodeLine(node), column: nodeColumn(node), children: [] };
    }

    case "ExportAllDeclaration": {
      const source = node.source as AstNode;
      return { name: `export * from ${sourceValue(source)}`, kind: "export-all", line: nodeLine(node), column: nodeColumn(node), children: [] };
    }

    case "FunctionDeclaration":
    case "FunctionExpression":
      return { name: getNodeName(node), kind: "function", line: nodeLine(node), column: nodeColumn(node), children: [] };

    case "ArrowFunctionExpression":
      return { name: getNodeName(node), kind: "arrow-function", line: nodeLine(node), column: nodeColumn(node), children: [] };

    case "ClassDeclaration":
    case "ClassExpression":
      return { name: getNodeName(node), kind: "class", line: nodeLine(node), column: nodeColumn(node), children: depth > 0 ? extractChildren(node, depth) : [] };

    case "VariableDeclaration": {
      const declarations = node.declarations as AstNode[];
      const names = declarations.map((d) => getNodeName(d)).filter(Boolean).join(", ");
      return { name: names, kind: node.kind as string ?? "variable", line: nodeLine(node), column: nodeColumn(node), children: [] };
    }

    case "TSInterfaceDeclaration":
      return { name: getNodeName(node), kind: "interface", line: nodeLine(node), column: nodeColumn(node), children: [] };

    case "TSTypeAliasDeclaration":
      return { name: getNodeName(node), kind: "type-alias", line: nodeLine(node), column: nodeColumn(node), children: [] };

    case "TSEnumDeclaration":
      return { name: getNodeName(node), kind: "enum", line: nodeLine(node), column: nodeColumn(node), children: [] };

    case "TSModuleDeclaration":
      return { name: getNodeName(node), kind: "module", line: nodeLine(node), column: nodeColumn(node), children: [] };

    default:
      if (type.endsWith("Statement")) {
        return { name: type.replace(/Statement$/, "").toLowerCase(), kind: "statement", line: nodeLine(node), column: nodeColumn(node), children: [] };
      }
      return null;
  }
}

function extractChildren(node: AstNode, depth: number): AstSymbol[] {
  if (depth <= 0) return [];

  const children: AstSymbol[] = [];
  const raw = node.body as AstNode | AstNode[] | undefined;
  if (!raw) return children;

  // ClassDeclaration.body is ClassBody; ClassBody.body is the member array
  const items: AstNode[] = Array.isArray(raw)
    ? raw
    : raw.type === "ClassBody"
      ? (raw.body as AstNode[] ?? [])
      : (raw as { body?: AstNode[] })?.body ?? [];

  for (const child of items) {
    if (!child || !child.type) continue;
    const sym: AstSymbol = {
      name: getNodeName(child) || child.type,
      kind: child.type,
      line: nodeLine(child),
      column: nodeColumn(child),
      children: [],
    };
    if (depth > 1) {
      sym.children = extractChildren(child, depth - 1);
    }
    children.push(sym);
  }

  return children;
}

function sourceValue(node: AstNode): string {
  if (node.type === "StringLiteral") return String(node.value ?? "");
  return String(node.value ?? "");
}

function formatAstSymbol(sym: AstSymbol, indent = 0): string {
  const prefix = "  ".repeat(indent);
  const kindTag = sym.kind.startsWith("export-") ? sym.kind.replace("export-", "") : sym.kind;
  const lineStr = sym.line > 0 ? ` (line ${sym.line})` : "";
  let result = `${prefix}${sym.name} (${kindTag}${lineStr})`;

  for (const child of sym.children) {
    result += "\n" + formatAstSymbol(child, indent + 1);
  }

  return result;
}

/** 格式化 AST 概览输出 */
function formatAstOutline(symbols: AstSymbol[], filePath: string): string {
  const exports = symbols.filter((s) => s.kind === "export" || s.name.startsWith("export "));
  const imports = symbols.filter((s) => s.kind === "import");
  const internal = symbols.filter((s) => s.kind !== "import" && !s.name.startsWith("export ") && s.kind !== "export" && s.kind !== "re-export" && s.kind !== "export-all");

  const parts: string[] = [`AST outline for ${filePath}:\n`];

  if (exports.length > 0) {
    parts.push("┌─ exports");
    for (const exp of exports) {
      parts.push(formatAstSymbol(exp, 1));
    }
  }

  if (imports.length > 0) {
    parts.push("├─ imports");
    for (const imp of imports) {
      parts.push(formatAstSymbol(imp, 1));
    }
  }

  if (internal.length > 0) {
    parts.push("├─ internal");
    for (const sym of internal) {
      parts.push(formatAstSymbol(sym, 1));
    }
  }

  parts.push(`└─ total: ${exports.length} exported symbols, ${internal.length} internal symbols, ${imports.length} import sources`);

  return parts.join("\n");
}

/* ═══════════════════════════════════════════════════════════════════
   ② analyze_dependencies — 依赖分析
   ═══════════════════════════════════════════════════════════════════ */

interface ImportInfo {
  source: string;
  specifiers: string[];
  isExternal: boolean;
  line: number;
}

interface DependencyResult {
  file: string;
  imports: ImportInfo[];
  exports: string[];
  externalPackages: string[];
}

/** 从 AST 提取导入信息 */
function extractImports(ast: AstNode): ImportInfo[] {
  const program = ast.program as AstNode;
  const imports: ImportInfo[] = [];

  for (const stmt of (program.body as AstNode[])) {
    if (stmt.type === "ImportDeclaration") {
      const source = sourceValue(stmt.source as AstNode);
      const specifiers = (stmt.specifiers as AstNode[]).map((s) => {
        if (s.type === "ImportDefaultSpecifier") return `default as ${getNodeName(s)}`;
        if (s.type === "ImportNamespaceSpecifier") return `* as ${getNodeName(s)}`;
        const local = getNodeName(s);
        const imported = (s.imported as AstNode)?.name ?? local;
        return imported !== local ? `${imported} as ${local}` : imported;
      });
      const isExternal = !source.startsWith(".") && !source.startsWith("/");
      imports.push({ source, specifiers, isExternal, line: nodeLine(stmt) });
    }

    // dynamic import() — crude detection
    if (stmt.type === "ExpressionStatement") {
      const expr = stmt.expression as AstNode;
      if (expr.type === "CallExpression" && (expr.callee as AstNode)?.type === "Import") {
        const arg = (expr.arguments as AstNode[])?.[0];
        if (arg?.type === "StringLiteral") {
          const src = String(arg.value ?? "");
          imports.push({
            source: src,
            specifiers: ["*"],
            isExternal: !src.startsWith(".") && !src.startsWith("/"),
            line: nodeLine(stmt),
          });
        }
      }
    }

    // require() calls
    if (stmt.type === "VariableDeclaration" || stmt.type === "ExpressionStatement") {
      const walkTargets: AstNode[] = [];
      if (stmt.type === "VariableDeclaration") {
        walkTargets.push(...(stmt.declarations as AstNode[] ?? []));
      } else {
        walkTargets.push(stmt.expression as AstNode);
      }

      for (const target of walkTargets) {
        if (!target || typeof target !== "object") continue;
        walkAst(target, {
          enter(node) {
            if (node.type === "CallExpression" &&
                (node.callee as AstNode)?.type === "Identifier" &&
                (node.callee as Record<string, unknown>).name === "require") {
              const arg = (node.arguments as AstNode[])?.[0];
              if (arg?.type === "StringLiteral") {
                const src = String(arg.value ?? "");
                // deduplicate
                if (!imports.some((i) => i.source === src)) {
                  imports.push({
                    source: src,
                    specifiers: ["*"],
                    isExternal: !src.startsWith(".") && !src.startsWith("/"),
                    line: nodeLine(node),
                  });
                }
              }
            }
          },
        });
      }
    }
  }

  return imports;
}

/** 从 AST 提取导出名称 */
function extractExports(ast: AstNode): string[] {
  const program = ast.program as AstNode;
  const exports: string[] = [];

  for (const stmt of (program.body as AstNode[])) {
    if (stmt.type === "ExportNamedDeclaration") {
      const decl = stmt.declaration as AstNode | undefined;
      if (decl) {
        const name = getNodeName(decl);
        if (name && name !== "anonymous") exports.push(name);
      }
      const specifiers = stmt.specifiers as AstNode[] | undefined;
      if (specifiers) {
        for (const s of specifiers) {
          const name = String((s.exported as Record<string, unknown>)?.name ?? "");
          if (name) exports.push(name);
        }
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const decl = stmt.declaration as AstNode;
      const name = getNodeName(decl);
      exports.push(name !== "anonymous" ? `default (${name})` : "default");
    } else if (stmt.type === "ExportAllDeclaration") {
      const source = sourceValue(stmt.source as AstNode);
      exports.push(`* from ${source}`);
    }
  }

  return exports;
}

/** 分析单个文件的依赖 */
function analyzeSingleFile(filePath: string): DependencyResult {
  const { ast } = parseToAst(filePath);
  const imports = extractImports(ast);
  const exports = extractExports(ast);
  const externalPackages = imports
    .filter((i) => i.isExternal)
    .map((i) => i.source)
    .filter((v, i, a) => a.indexOf(v) === i);

  return { file: filePath, imports, exports, externalPackages };
}

/** 格式化依赖结果 */
function formatDependencyResult(result: DependencyResult, depth: number): string {
  const parts: string[] = [
    `Dependencies for ${result.file} (depth=${depth}):\n`,
  ];

  if (result.imports.length > 0) {
    parts.push("imports:");
    for (const imp of result.imports) {
      const extTag = imp.isExternal ? " [external]" : "";
      const specs = imp.specifiers.length > 0 ? ` — ${imp.specifiers.join(", ")}` : "";
      parts.push(`  ${imp.source}${extTag}${specs} (line ${imp.line})`);
    }
  } else {
    parts.push("imports: (none)");
  }

  if (result.exports.length > 0) {
    parts.push(`\nexports: ${result.exports.join(", ")}`);
  }

  if (result.externalPackages.length > 0) {
    parts.push(`\nexternal packages: ${result.externalPackages.join(", ")}`);
  }

  return parts.join("\n");
}

/** 递归分析 transitive 依赖 */
function analyzeTransitive(filePath: string, depth: number, visited: Set<string>, currentDepth: number): string[] {
  if (currentDepth > depth || visited.has(filePath)) return [];
  visited.add(filePath);

  const lines: string[] = [];
  const indent = "  ".repeat(currentDepth);

  try {
    const result = analyzeSingleFile(filePath);
    lines.push(`${indent}${path.basename(filePath)}${currentDepth === 0 ? ` (${filePath})` : ""}`);

    for (const imp of result.imports) {
      if (!imp.isExternal) {
        lines.push(`${indent}  → ${imp.source}`);
        // Resolve relative import
        const dir = path.dirname(filePath);
        const resolved = resolveImportPath(dir, imp.source);
        if (resolved) {
          const sub = analyzeTransitive(resolved, depth, visited, currentDepth + 1);
          lines.push(...sub);
        }
      }
    }
  } catch {
    lines.push(`${indent}${path.basename(filePath)} (error reading file)`);
  }

  return lines;
}

/** 解析模块导入路径 */
function resolveImportPath(baseDir: string, importPath: string): string | null {
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cts", ".json"];

  // Try exact path first
  const exact = path.resolve(baseDir, importPath);
  if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;

  // Try with extensions
  for (const ext of exts) {
    const withExt = exact + ext;
    if (fs.existsSync(withExt)) return withExt;
  }

  // Try as directory with index file
  for (const ext of exts) {
    const indexFile = path.join(exact, `index${ext}`);
    if (fs.existsSync(indexFile)) return indexFile;
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════
   ③ analyze_complexity — 圈复杂度分析
   ═══════════════════════════════════════════════════════════════════ */

interface FunctionComplexity {
  name: string;
  line: number;
  complexity: number;
}

/** 计算函数体的圈复杂度 */
function calculateFunctionComplexity(node: AstNode, name: string, line: number): FunctionComplexity {
  let complexity = 1; // 基准：线性路径

  walkAst(node, {
    enter(child) {
      switch (child.type) {
        case "IfStatement":
        case "ConditionalExpression":  // ternary ?:
          complexity += 1;
          break;
        case "SwitchCase":
          // 每个 case（不含 default）加 1
          if (!child.test || child.test === null) break;
          complexity += 1;
          break;
        case "LogicalExpression":
          // && 和 || 增加分支路径
          if (child.operator === "&&" || child.operator === "||") {
            complexity += 1;
          }
          break;
        case "ForStatement":
        case "ForInStatement":
        case "ForOfStatement":
        case "WhileStatement":
        case "DoWhileStatement":
          complexity += 1;
          break;
        case "CatchClause":
          complexity += 1;
          break;
        case "BinaryExpression":
          // 只对 ?? (nullish coalescing) 计
          if (child.operator === "??") complexity += 1;
          break;
      }
    },
  });

  return { name, line, complexity };
}

/** 分析文件所有函数的复杂度 */
function analyzeFileComplexity(filePath: string): FunctionComplexity[] {
  const { ast } = parseToAst(filePath);
  const results: FunctionComplexity[] = [];
  const program = ast.program as AstNode;

  for (const stmt of (program.body as AstNode[])) {
    // 顶层函数声明 / 导出
    if (stmt.type === "FunctionDeclaration") {
      results.push(calculateFunctionComplexity(stmt, getNodeName(stmt), nodeLine(stmt)));
    }

    // export function / const arrow
    if (stmt.type === "ExportNamedDeclaration") {
      const decl = stmt.declaration as AstNode | undefined;
      if (!decl) continue;

      if (decl.type === "FunctionDeclaration") {
        results.push(calculateFunctionComplexity(decl, getNodeName(decl), nodeLine(decl)));
      } else if (decl.type === "VariableDeclaration") {
        extractArrowFunctions(decl, results, true);
      }
    }

    // const fn = () => {…}
    if (stmt.type === "VariableDeclaration") {
      extractArrowFunctions(stmt, results, false);
    }

    // class methods
    if (stmt.type === "ClassDeclaration") {
      const classBody = stmt.body as AstNode;
      if (classBody?.type === "ClassBody") {
        for (const member of (classBody.body as AstNode[])) {
          if (member.type === "ClassMethod" || member.type === "ClassPrivateMethod") {
            results.push(calculateFunctionComplexity(member, getNodeName(member), nodeLine(member)));
          }
        }
      }
    }
  }

  return results;
}

/** 从 VariableDeclaration 中提取箭头函数/函数表达式 */
function extractArrowFunctions(decl: AstNode, results: FunctionComplexity[], exported: boolean): void {
  const declarations = decl.declarations as AstNode[] ?? [];
  for (const d of declarations) {
    const init = d.init as AstNode | undefined;
    if (!init) continue;

    const name = exported ? `export ${getNodeName(d)}` : getNodeName(d);

    if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
      results.push(calculateFunctionComplexity(init, name, nodeLine(decl)));
    }
  }
}

/** 格式化复杂度结果 */
function formatComplexityResults(results: FunctionComplexity[], threshold: number): string {
  const filtered = results.filter((r) => r.complexity >= threshold);
  if (filtered.length === 0) {
    return threshold > 0
      ? `No functions with complexity >= ${threshold} found`
      : "(no functions found)";
  }

  const lines: string[] = [];
  const maxNameLen = Math.max(...filtered.map((r) => r.name.length), 4);

  lines.push("Cyclomatic complexity (McCabe):\n");
  lines.push(`  ${"Function".padEnd(maxNameLen + 2)}Complexity  Rating`);
  lines.push(`  ${"─".repeat(maxNameLen + 2)}──────────  ──────`);

  for (const r of filtered.sort((a, b) => b.complexity - a.complexity)) {
    const rating = r.complexity <= 10 ? "🟢 simple" :
                   r.complexity <= 20 ? "🟡 moderate" :
                   r.complexity <= 40 ? "🟠 complex" : "🔴 dangerous";
    lines.push(`  ${r.name.padEnd(maxNameLen + 2)}${String(r.complexity).padEnd(10)}${rating}`);
  }

  const avg = filtered.reduce((s, r) => s + r.complexity, 0) / filtered.length;
  const max = Math.max(...filtered.map((r) => r.complexity));
  lines.push(`\n  Average: ${avg.toFixed(1)}  Max: ${max}  Functions analyzed: ${filtered.length}`);

  return lines.join("\n");
}

/* ═══════════════════════════════════════════════════════════════════
   ④ find_patterns — 代码模式搜索
   ═══════════════════════════════════════════════════════════════════ */

interface PatternMatch {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

/** 所有支持的模式列表 */
const SUPPORTED_PATTERNS = [
  "try-catch",
  "promise-all",
  "console-log",
  "any-type",
  "todo-comment",
  "unused-parameter",
] as const;

type PatternName = typeof SUPPORTED_PATTERNS[number];

/** 通用模式搜索入口 */
function searchForPattern(pattern: string, searchPath: string): PatternMatch[] {
  const normalizedPattern = pattern.toLowerCase().replace(/[\s_-]/g, "-");

  // 验证模式名
  if (!(SUPPORTED_PATTERNS as readonly string[]).includes(normalizedPattern)) {
    throw new Error(
      `Unknown pattern '${pattern}'. Supported: ${SUPPORTED_PATTERNS.join(", ")}`,
    );
  }

  let filePaths: string[];
  try {
    filePaths = collectSourceFiles(searchPath);
  } catch {
    return [];
  }
  const matches: PatternMatch[] = [];

  for (const fp of filePaths) {
    try {
      const fileMatches = searchPatternInFile(fp, normalizedPattern as PatternName);
      matches.push(...fileMatches);
    } catch {
      // skip unparseable files
    }
  }

  return matches.sort((a, b) => a.line - b.line);
}

/** 收集目录下的源码文件 */
function collectSourceFiles(dirPath: string): string[] {
  const files: string[] = [];
  const stat = fs.statSync(dirPath);
  if (stat.isFile()) return [dirPath];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    // Skip node_modules, .git, dist, build
    if (entry.name === "node_modules" || entry.name === ".git" ||
        entry.name === "dist" || entry.name === "build" ||
        entry.name === "target" || entry.name === "coverage" ||
        entry.name === ".reasonix") {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

/** 在单文件中搜索模式 */
function searchPatternInFile(filePath: string, pattern: PatternName): PatternMatch[] {
  switch (pattern) {
    case "try-catch":
      return searchTryCatch(filePath);
    case "promise-all":
      return searchPromiseAll(filePath);
    case "console-log":
      return searchConsoleLog(filePath);
    case "any-type":
      return searchAnyType(filePath);
    case "todo-comment":
      return searchTodoComment(filePath);
    case "unused-parameter":
      return searchUnusedParameter(filePath);
    default:
      return [];
  }
}

function searchTryCatch(filePath: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Match try { and catch ( patterns
      if (/^\s*try\s*\{/.test(lines[i]) || /^\s*try\s*$/.test(lines[i])) {
        // find the matching catch
        let j = i + 1;
        let braceCount = 1;
        while (j < lines.length && braceCount > 0) {
          braceCount += (lines[j].match(/\{/g)?.length ?? 0);
          braceCount -= (lines[j].match(/\}/g)?.length ?? 0);
          j++;
        }
        const catchLine = lines.slice(j, j + 3).find((l) => /catch\s*\(/.test(l));
        if (catchLine) {
          matches.push({
            file: filePath,
            line: i + 1,
            column: 1,
            snippet: lines[i].trim(),
          });
        }
      }
    }
  } catch { /* skip */ }
  return matches;
}

function searchPromiseAll(filePath: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/\bPromise\.all\s*\(/);
      if (match) {
        matches.push({
          file: filePath,
          line: i + 1,
          column: (match.index ?? 0) + 1,
          snippet: lines[i].trim(),
        });
      }
    }
  } catch { /* skip */ }
  return matches;
}

function searchConsoleLog(filePath: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match console.log / .warn / .error / .info — skip commented lines
      const stripped = line.replace(/\/\/.*$/, "").trim();
      if (!stripped) continue;
      const match = stripped.match(/\bconsole\.(log|warn|error|info|debug)\s*\(/);
      if (match) {
        matches.push({
          file: filePath,
          line: i + 1,
          column: (line.indexOf(match[0]) >= 0 ? line.indexOf(match[0]) : 0) + 1,
          snippet: line.trim(),
        });
      }
    }
  } catch { /* skip */ }
  return matches;
}

function searchAnyType(filePath: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.replace(/\/\/.*$/, "").trim();
      if (!stripped || stripped.startsWith("/*") || stripped.startsWith("*")) continue;
      // Match `: any` or `as any` or `<any>`, but not `: any` in comments
      const anyMatches = stripped.match(/(?::\s*any\s*[,;)\]}={]|:\s*any$|as\s+any\b|<\s*any\s*>)/);
      if (anyMatches) {
        matches.push({
          file: filePath,
          line: i + 1,
          column: (line.indexOf("any") >= 0 ? line.indexOf("any") : 0) + 1,
          snippet: line.trim(),
        });
      }
    }
  } catch { /* skip */ }
  return matches;
}

function searchTodoComment(filePath: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match TODO, FIXME, HACK, XXX in comments
      const match = line.match(/(\/\/|#|<!--|\/\*).*\b(TODO|FIXME|HACK|XXX|WORKAROUND|HARDCODED)\b/i);
      if (match) {
        matches.push({
          file: filePath,
          line: i + 1,
          column: (match.index ?? 0) + 1,
          snippet: line.trim(),
        });
      }
    }
  } catch { /* skip */ }
  return matches;
}

function searchUnusedParameter(filePath: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.replace(/\/\/.*$/, "").trim();

      // Match function parameters starting with _ (convention: unused)
      // e.g. function foo(_arg: string) or (_unused) => { }
      const match = stripped.match(/_\w+\s*(?::\s*\w+)?\s*[,)]/);
      if (match && (stripped.includes("function") || stripped.includes("=>") || stripped.includes("("))) {
        matches.push({
          file: filePath,
          line: i + 1,
          column: (line.indexOf("_") >= 0 ? line.indexOf("_") : 0) + 1,
          snippet: line.trim(),
        });
      }
    }
  } catch { /* skip */ }
  return matches;
}

/** 格式化模式搜索结果 */
function formatPatternMatches(pattern: string, matches: PatternMatch[], path: string): string {
  if (matches.length === 0) {
    return `Pattern '${pattern}': no matches in ${path}`;
  }

  const parts: string[] = [
    `Pattern '${pattern}': ${matches.length} match(es) in ${path}`,
    "",
  ];

  for (const m of matches.slice(0, 100)) {
    parts.push(`  ${m.file}:${m.line}:${m.column}  ${m.snippet}`);
  }

  if (matches.length > 100) {
    parts.push(`  ... and ${matches.length - 100} more matches`);
  }

  return parts.join("\n");
}

/* ═══════════════════════════════════════════════════════════════════
   ⑤ scan_security — 安全扫描
   ═══════════════════════════════════════════════════════════════════ */

interface SecurityIssue {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
  snippet: string;
}

const SEVERITY_ORDER: Record<string, number> = { info: 1, warning: 2, error: 3 };

/** 安全扫描主函数 */
function runSecurityScan(searchPath: string, minSeverity: string): SecurityIssue[] {
  const minLevel = SEVERITY_ORDER[minSeverity] ?? 1;
  const filePaths = collectSourceFiles(searchPath);
  const issues: SecurityIssue[] = [];

  for (const fp of filePaths) {
    try {
      const fileIssues = scanFileSecurity(fp);
      issues.push(...fileIssues.filter((i) => (SEVERITY_ORDER[i.severity] ?? 0) >= minLevel));
    } catch {
      // skip unreadable files
    }
  }

  return issues.sort((a, b) => a.line - b.line);
}

/** 扫描单个文件的安全问题 */
function scanFileSecurity(filePath: string): SecurityIssue[] {
  const issues: SecurityIssue[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.replace(/\/\/.*$/, "").trim();
    if (!stripped) continue;

    // 1. Hardcoded secrets
    checkSecretPatterns(filePath, i, line, stripped, issues);

    // 2. SQL injection (string concatenation with SQL keywords)
    checkSqlInjection(filePath, i, line, stripped, issues);

    // 3. Command injection (exec/spawn with variable interpolation)
    checkCommandInjection(filePath, i, line, stripped, issues);

    // 4. eval usage
    checkEvalUsage(filePath, i, line, stripped, issues);

    // 5. Path traversal
    checkPathTraversal(filePath, i, line, stripped, issues);

    // 6. Any type (info level)
    checkAnyType(filePath, i, line, stripped, issues);
  }

  return issues;
}

const SECRET_PATTERNS = [
  // password, passwd, pwd, token as var name
  /(?:_?password|_?passwd|_?pwd|_?token|_?secret)\s*[:=]\s*['"][^'"]+['"]/i,
  // *_KEY, *_SECRET, API_KEY, API_SECRET, etc.
  /\b\w*[-_]?(?:key|secret|token)\w*\s*[:=]\s*['"][^'"]+['"]/i,
  // sk-... style API keys (OpenAI format)
  /\b['"](?:sk-|pk-)[a-zA-Z0-9]{10,}['"]/,
  // connection strings
  /(?:connection[-_]?string|connstr)\s*[:=]\s*['"][^'"]+['"]/i,
  // Generic: assignment of a long string literal to a short-named variable
  /\b\w{2,30}\s*[:=]\s*['"][A-Za-z0-9_\-\.]{16,}['"]/,
];

function checkSecretPatterns(
  filePath: string, lineIdx: number, _rawLine: string, stripped: string, issues: SecurityIssue[],
): void {
  for (const pat of SECRET_PATTERNS) {
    const match = stripped.match(pat);
    if (match) {
      issues.push({
        file: filePath,
        line: lineIdx + 1,
        column: (match.index ?? 0) + 1,
        severity: "error",
        rule: "hardcoded-secret",
        message: `Possible hardcoded secret: '${match[0].slice(0, 60)}'`,
        snippet: stripped.slice(0, 80),
      });
    }
  }
}

function checkSqlInjection(
  filePath: string, lineIdx: number, _rawLine: string, stripped: string, issues: SecurityIssue[],
): void {
  // Detect string concatenation with SQL-like keywords
  // Pattern A: "SELECT ..." + variable
  // Pattern B: variable + "..." followed by SQL keyword
  // Pattern C: query/execute/run with string concatenation
  const sqlPatterns = [
    /\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b[^;]*\+\s*['"`]/i,
    /['"`]\s*\+\s*['"`].*\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i,
    /\b(?:query|execute|run)\s*\(\s*['"`].*\+/i,
    /\b(?:query|execute|run)\s*\([^)]*\+/i,
  ];

  for (const pat of sqlPatterns) {
    const match = stripped.match(pat);
    if (match) {
      issues.push({
        file: filePath,
        line: lineIdx + 1,
        column: (match.index ?? 0) + 1,
        severity: "error",
        rule: "sql-injection",
        message: `Possible SQL injection via string concatenation`,
        snippet: stripped.slice(0, 80),
      });
    }
  }
}

function checkCommandInjection(
  filePath: string, lineIdx: number, _rawLine: string, stripped: string, issues: SecurityIssue[],
): void {
  const execPatterns = [
    /\b(?:exec|spawn|execSync|execFile)\s*\(\s*(?:`[^`]*\$\{|'[^']*'\s*\+)/,
    /\b(?:exec|spawn|execSync|execFile)\s*\(\s*(?:"[^"]*"\s*\+)/,
  ];

  for (const pat of execPatterns) {
    const match = stripped.match(pat);
    if (match) {
      issues.push({
        file: filePath,
        line: lineIdx + 1,
        column: (match.index ?? 0) + 1,
        severity: "error",
        rule: "command-injection",
        message: `Possible command injection via string interpolation in exec/spawn`,
        snippet: stripped.slice(0, 80),
      });
    }
  }
}

function checkEvalUsage(
  filePath: string, lineIdx: number, _rawLine: string, stripped: string, issues: SecurityIssue[],
): void {
  const evalPatterns = [
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /setTimeout\s*\(\s*['"`]/,
    /setInterval\s*\(\s*['"`]/,
  ];

  for (const pat of evalPatterns) {
    const match = stripped.match(pat);
    if (match) {
      issues.push({
        file: filePath,
        line: lineIdx + 1,
        column: (match.index ?? 0) + 1,
        severity: "warning",
        rule: "eval-usage",
        message: `Use of eval-like construct: '${match[0]}' — risk of code injection`,
        snippet: stripped.slice(0, 80),
      });
    }
  }
}

function checkPathTraversal(
  filePath: string, lineIdx: number, _rawLine: string, stripped: string, issues: SecurityIssue[],
): void {
  if (/\bpath\.(join|resolve)\s*\(/.test(stripped) &&
      /\b(userInput|userPath|user_path|fileName|req\.params|req\.query|\.body\b)/i.test(stripped)) {
    issues.push({
      file: filePath,
      line: lineIdx + 1,
      column: 1,
      severity: "warning",
      rule: "path-traversal",
      message: `path.join/resolve with possible user input — risk of path traversal`,
      snippet: stripped.slice(0, 80),
    });
  }
}

function checkAnyType(
  filePath: string, lineIdx: number, _rawLine: string, stripped: string, issues: SecurityIssue[],
): void {
  const anyMatch = stripped.match(/(?::\s*any\s*[,;)\]}=]|:\s*any$|as\s+any\b)/);
  if (anyMatch && !stripped.startsWith("//") && !stripped.startsWith("*")) {
    issues.push({
      file: filePath,
      line: lineIdx + 1,
      column: (lineIdx === 0 ? 0 : 0) + 1,
      severity: "info",
      rule: "any-type",
      message: `Use of 'any' type — weakens type safety`,
      snippet: stripped.slice(0, 80),
    });
  }
}

/** 格式化安全扫描结果 */
function formatSecurityIssues(issues: SecurityIssue[], minSeverity: string): string {
  if (issues.length === 0) {
    return "Security scan: no issues found";
  }

  const severityLabel: Record<string, string> = {
    error: "🔴 ERROR",
    warning: "🟡 WARNING",
    info: "ℹ️ INFO",
  };

  const parts: string[] = [
    `Security scan: ${issues.length} issue(s) found (min severity: ${minSeverity})\n`,
  ];

  for (const issue of issues) {
    const label = severityLabel[issue.severity] ?? issue.severity;
    parts.push(
      `${label}  ${issue.rule}  ${issue.file}:${issue.line}:${issue.column}`,
      `       ${issue.message}`,
      `       ${issue.snippet}`,
      "",
    );
  }

  const bySeverity = {
    error: issues.filter((i) => i.severity === "error").length,
    warning: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };

  parts.push(
    `Summary: ${bySeverity.error} errors, ${bySeverity.warning} warnings, ${bySeverity.info} info`,
  );

  return parts.join("\n");
}

/* ═══════════════════════════════════════════════════════════════════
   工具工厂函数
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 创建代码分析工具的 CatalogEntry 数组。
 *
 * @param projectRoot - 项目根目录（用于文件路径解析）
 * @returns CatalogEntry[]
 */
export function createCodeAnalysisTools(projectRoot?: string): CatalogEntry[] {
  const root = projectRoot ?? process.cwd();
  const tools: CatalogEntry[] = [];

  /* ─── ① parse_ast ───────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "parse_ast",
      description:
        "Parse a file and return its AST outline — top-level symbols, exports, imports. " +
        "file: file path to analyze. " +
        "depth: how deep to go (1 = top-level only, 2 = class methods + nested functions, default 1). " +
        "Returns a tree of { name, kind, location, children } for the whole file. " +
        "Use when you need a structural overview of a file, not its full text.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "File path to analyze" },
          depth: { type: "number", description: "How deep to go (default 1)" },
        },
        required: ["file"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const filePath = String(args.file ?? "").trim();
      const depth = Math.max(1, Math.min(5, Number(args.depth) || 1));

      if (!filePath) return "parse_ast: file path is required";

      try {
        const symbols = parseAstOutline(filePath, depth);
        return formatAstOutline(symbols, filePath);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("no such file") || msg.includes("ENOENT")) {
          return `parse_ast: file not found — ${filePath}`;
        }
        if (msg.includes("SyntaxError") || msg.includes("parse")) {
          return `parse_ast: syntax error parsing file — ${msg}`;
        }
        return `parse_ast: error — ${msg}`;
      }
    };

    tools.push({ definition, handler: handler as unknown as (args: Record<string, unknown>) => string, asyncHandler: handler });
  }

  /* ─── ② analyze_dependencies ─────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "analyze_dependencies",
      description:
        "Analyze import/require dependencies of a file. " +
        "file: file path to analyze. " +
        "depth: how deep to follow imports (0 = direct only, 1+ = transitive, default 0). " +
        "Returns imports (what this file depends on), exports (what this file provides), " +
        "and external packages. Use to understand code relationships before refactoring.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "File path to analyze" },
          depth: { type: "number", description: "How deep to follow imports (default 0)" },
        },
        required: ["file"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const filePath = String(args.file ?? "").trim();
      const depth = Math.max(0, Math.min(5, Number(args.depth) || 0));

      if (!filePath) return "analyze_dependencies: file path is required";

      try {
        if (depth === 0) {
          const result = analyzeSingleFile(filePath);
          return formatDependencyResult(result, depth);
        } else {
          const visited = new Set<string>();
          const treeLines = analyzeTransitive(filePath, depth, visited, 0);
          return [
            `Transitive dependency tree for ${filePath} (depth=${depth}):`,
            "",
            ...treeLines,
          ].join("\n");
        }
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("no such file") || msg.includes("ENOENT")) {
          return `analyze_dependencies: file not found — ${filePath}`;
        }
        return `analyze_dependencies: error — ${msg}`;
      }
    };

    tools.push({ definition, handler: handler as unknown as (args: Record<string, unknown>) => string, asyncHandler: handler });
  }

  /* ─── ③ analyze_complexity ───────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "analyze_complexity",
      description:
        "Calculate cyclomatic complexity for functions in a file. " +
        "file: file path to analyze. " +
        "threshold: only show functions above this complexity (default 0 = all). " +
        "Returns function-by-function scores: complexity(1-10=simple, 11-20=moderate, " +
        "21-40=complex, 40+=dangerous). Use to identify refactoring targets.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "File path to analyze" },
          threshold: { type: "number", description: "Minimum complexity threshold (default 0)" },
        },
        required: ["file"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const filePath = String(args.file ?? "").trim();
      const threshold = Math.max(0, Number(args.threshold) || 0);

      if (!filePath) return "analyze_complexity: file path is required";

      try {
        const results = analyzeFileComplexity(filePath);
        return formatComplexityResults(results, threshold);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("no such file") || msg.includes("ENOENT")) {
          return `analyze_complexity: file not found — ${filePath}`;
        }
        return `analyze_complexity: error — ${msg}`;
      }
    };

    tools.push({ definition, handler: handler as unknown as (args: Record<string, unknown>) => string, asyncHandler: handler });
  }

  /* ─── ④ find_patterns ────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "find_patterns",
      description:
        "Find code patterns by structural template. " +
        "pattern: one of 'try-catch', 'promise-all', 'console-log', 'any-type', " +
        "'todo-comment', 'unused-parameter'. " +
        "path: file or directory to search (default: project root). " +
        "Returns file:line for each match.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Pattern name to search for" },
          path: { type: "string", description: "File or directory (default: project root)" },
        },
        required: ["pattern"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const pattern = String(args.pattern ?? "").trim();
      const searchPath = String(args.path ?? root).trim() || root;

      if (!pattern) {
        return `find_patterns: pattern is required. Supported: ${SUPPORTED_PATTERNS.join(", ")}`;
      }

      try {
        const matches = searchForPattern(pattern, searchPath);
        return formatPatternMatches(pattern, matches, searchPath);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("Unknown pattern")) return msg;
        return `find_patterns: error — ${msg}`;
      }
    };

    tools.push({ definition, handler: handler as unknown as (args: Record<string, unknown>) => string, asyncHandler: handler });
  }

  /* ─── ⑤ scan_security ────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "scan_security",
      description:
        "Scan code for security vulnerabilities. " +
        "path: file or directory to scan (default: project root). " +
        "severity: minimum severity — 'error', 'warning', or 'info' (default: 'warning'). " +
        "Checks: hardcoded secrets, SQL injection, command injection, eval usage, " +
        "path traversal. Returns issues with severity level and file:line.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory to scan" },
          severity: {
            type: "string",
            enum: ["error", "warning", "info"],
            description: "Minimum severity (default: 'warning')",
          },
        },
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const searchPath = String(args.path ?? root).trim() || root;
      const severity = String(args.severity ?? "warning").trim() || "warning";

      if (!["error", "warning", "info"].includes(severity)) {
        return `scan_security: invalid severity '${severity}'. Use 'error', 'warning', or 'info'`;
      }

      try {
        const issues = runSecurityScan(searchPath, severity);
        return formatSecurityIssues(issues, severity);
      } catch (e) {
        return `scan_security: error — ${(e as Error).message}`;
      }
    };

    tools.push({ definition, handler: handler as unknown as (args: Record<string, unknown>) => string, asyncHandler: handler });
  }

  return tools;
}
