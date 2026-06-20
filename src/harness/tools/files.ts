/**
 * 文件工具 — Viewport 读取 + 行范围编辑（第 11 章）
 *
 * 基于 ACI (Agent-Computer Interface) 原则设计：
 *   1. Viewport, not dump — 返回 100 行窗口而非整个文件
 *   2. Targeted edit, not rewrite — 行范围替换而非整文件重写
 *   3. Explicit envelope — 每个工具返回带机器可读的外壳
 *   4. Errors as instructions — 错误消息建议下一步
 *
 * 参考：Yang et al. 2024 "SWE-agent: Agent-Computer Interfaces Enable
 * Automated Software Engineering" — 同一模型仅改 ACI，SWE-bench pass@1
 * 从 ~0% 提升到 12.5%。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition, ToolHandler } from "./registry.js";

/* ─── 常量 ───────────────────────────────────────────────────────── */

const VIEWPORT_DEFAULT = 100;
const VIEWPORT_MAX = 500;

/* ─── readFileViewport ───────────────────────────────────────────── */

const viewportDefinition: ToolDefinition = {
  name: "read_file_viewport",
  description:
    "Read a slice of a text file, like `less` or `head -n ... | tail -n ...`. " +
    "path: filesystem path. " +
    "offset: zero-based line number to start reading from. Default 0. " +
    "limit: max lines to return. Default 100, max 500. " +
    "Returns a rendered viewport with line numbers. The last line of the " +
    "output describes what's visible and what's NOT, so you can call this " +
    "tool again with a different offset to keep reading. " +
    "Side effects: reads the filesystem. " +
    "Use this in preference to reading whole files. For files <50 lines, " +
    "the whole file fits in one call.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Filesystem path to the file",
      },
      offset: {
        type: "number",
        description: "Zero-based line number to start from. Default 0.",
        default: 0,
      },
      limit: {
        type: "number",
        description: "Max lines to return. Default 100, max 500.",
        default: VIEWPORT_DEFAULT,
      },
    },
    required: ["path"],
  },
};

const viewportHandler: ToolHandler = (args) => {
  const filePath = String(args.path ?? "");
  const offsetRaw = Number(args.offset ?? 0);
  const limitRaw = Number(args.limit ?? VIEWPORT_DEFAULT);

  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.round(offsetRaw)) : 0;
  const limit = Math.max(1, Math.min(VIEWPORT_MAX,
    Number.isFinite(limitRaw) ? Math.round(limitRaw) : VIEWPORT_DEFAULT));

  if (!filePath) {
    return "read_file_viewport: path cannot be empty";
  }

  // Exist check
  if (!fs.existsSync(filePath)) {
    return `read_file_viewport: file does not exist: ${filePath}`;
  }

  // File check
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return `read_file_viewport: not a regular file: ${filePath}`;
  }

  let text: string;
  try {
    text = fs.readFileSync(filePath, { encoding: "utf-8" });
  } catch (e) {
    return `read_file_viewport: error reading file: ${(e as Error).message}`;
  }

  const lines = text.split(/\r?\n/);
  const total = lines.length;
  const start = Math.max(0, Math.min(offset, total - 1));
  const end = Math.min(total, start + limit);
  const visible = lines.slice(start, end);

  // 行号宽度对齐
  const width = String(total).length;
  const numbered = visible.map(
    (line, i) => `${String(i + start + 1).padStart(width)}  ${line}`,
  );

  // Envelope footer
  const footerParts: string[] = [
    `file: ${filePath}`,
    `lines ${start + 1}-${end} of ${total}`,
  ];
  if (end < total) {
    footerParts.push(`MORE below — call with offset=${end}`);
  }
  if (start > 0) {
    footerParts.push(`MORE above — call with offset=0`);
  }
  if (end >= total) {
    footerParts.push("end of file");
  }

  const body = numbered.join("\n");
  const footer = `\n[${footerParts.join("; ")}]`;

  return body + footer;
};

/* ─── editLines ──────────────────────────────────────────────────── */

const editDefinition: ToolDefinition = {
  name: "edit_lines",
  description:
    "Replace a line range in a file with new content. " +
    "path: filesystem path (file must exist). " +
    "start_line: one-based starting line (inclusive). " +
    "end_line: one-based ending line (inclusive). " +
    "replacement: text to insert in place of the removed lines. Empty " +
    "string deletes the range without replacement. " +
    "Returns a confirmation with the diff summary and lines around " +
    "the edit (for verification). " +
    "Side effects: writes the file. Preserves content outside the range. " +
    "To INSERT new lines at position N without removing: use " +
    "start_line=N, end_line=N-1 and replacement=your_new_content. " +
    "To APPEND: use start_line=last+1, end_line=last.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Filesystem path (file must exist)",
      },
      start_line: {
        type: "number",
        description: "One-based starting line (inclusive)",
      },
      end_line: {
        type: "number",
        description: "One-based ending line (inclusive)",
      },
      replacement: {
        type: "string",
        description: "Text to insert in place of the removed lines. Empty string deletes.",
      },
    },
    required: ["path", "start_line", "end_line", "replacement"],
  },
};

const editHandler: ToolHandler = (args) => {
  const filePath = String(args.path ?? "");
  const startLine = Number(args.start_line);
  const endLine = Number(args.end_line);
  const replacement = String(args.replacement ?? "");

  if (!filePath) {
    return "edit_lines: path cannot be empty";
  }

  if (!fs.existsSync(filePath)) {
    return `edit_lines: file does not exist: ${filePath}`;
  }

  if (!Number.isFinite(startLine) || startLine < 1) {
    return `edit_lines: start_line must be >= 1, got ${args.start_line}`;
  }
  if (!Number.isFinite(endLine) || endLine < 0) {
    return `edit_lines: end_line must be >= 0, got ${args.end_line}`;
  }

  let original: string;
  try {
    original = fs.readFileSync(filePath, { encoding: "utf-8" });
  } catch (e) {
    return `edit_lines: error reading file: ${(e as Error).message}`;
  }

  const lines = original.split(/\r?\n/);
  const total = lines.length;
  const hasFinalNewline = original.endsWith("\n");

  // 边界检查
  if (startLine > total + 1) {
    return `edit_lines: start_line ${startLine} out of range (1..${total + 1})`;
  }
  if (endLine < startLine - 1 || endLine > total) {
    return `edit_lines: end_line ${endLine} out of range (${startLine - 1}..${total})`;
  }

  // 零基切片
  const s = startLine - 1; // 起始行（零基）
  const e = endLine;        // 结尾行（slice exclusive，恰好 work 于删除）

  const replacementLines = replacement === "" ? [] : replacement.split(/\r?\n/);
  const newLines = [
    ...lines.slice(0, s),
    ...replacementLines,
    ...lines.slice(e),
  ];

  // 重建文本（保留原始行尾风格和最终换行
  let newText = newLines.join("\n");
  if (hasFinalNewline && !newText.endsWith("\n")) {
    newText += "\n";
  }

  try {
    fs.writeFileSync(filePath, newText, "utf-8");
  } catch (e) {
    return `edit_lines: error writing file: ${(e as Error).message}`;
  }

  const removed = endLine >= startLine ? endLine - startLine + 1 : 0;
  const added = replacementLines.length;

  // Render context around the edit
  const contextStart = Math.max(0, s - 2);
  const contextEnd = Math.min(newLines.length, s + added + 2);
  const width = String(newLines.length).length;
  const preview = newLines.slice(contextStart, contextEnd).map(
    (line, i) => `${String(contextStart + i + 1).padStart(width)}  ${line}`,
  ).join("\n");

  return (
    `edited ${path.basename(filePath)}: removed ${removed} lines, ` +
    `added ${added} lines at ${startLine}..${endLine}\n` +
    `context:\n${preview}`
  );
};

/* ─── 打包导出 ──────────────────────────────────────────────────── */

export function fileViewportTool(): [ToolDefinition, ToolHandler] {
  return [viewportDefinition, viewportHandler];
}

export function editLinesTool(): [ToolDefinition, ToolHandler] {
  return [editDefinition, editHandler];
}

export { viewportDefinition, editDefinition };
