/**
 * 扩展文件系统工具（第 27 章）
 *
 * 补充第 11 章 ACI 工具的缺口——第 11 章只有读 (readFileViewport) 和
 * 改 (editLines)，缺少创建、删除、浏览、搜索和元信息能力。
 *
 * 新增 6 个工具：
 *   1. create_file         — 创建新文件（路径已存在则报错）
 *   2. delete_file         — 删除文件/目录（递归选项）
 *   3. list_directory      — 浏览目录结构（depth 控制递归层数）
 *   4. glob_files          — 按 glob 模式搜索文件
 *   5. get_file_info       — 文件元信息（大小、mtime、类型、行数）
 *   6. search_in_files     — 文件内容搜索（text/regex，context 上下文）
 *
 * 权限策略：
 *   - 只读（list_directory / glob_files / get_file_info / search_in_files）→ allow
 *   - 写入（create_file / delete_file）→ ask（需用户确认）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogEntry } from "./selector.js";
import type { ToolDefinition } from "./registry.js";

/* ═══════════════════════════════════════════════════════════════════
   辅助函数
   ═══════════════════════════════════════════════════════════════════ */

/** 计算文本文件的行数 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

/** 格式化字节数为人类可读形式 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 收集源码文件路径（递归，跳过 node_modules / .git / dist / build 等） */
function collectTextFiles(dirPath: string): string[] {
  const files: string[] = [];
  try {
    const stat = fs.statSync(dirPath);
    if (stat.isFile()) return [dirPath];
  } catch {
    return [];
  }

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      // 跳过忽略的目录
      if (entry.name.startsWith(".") || entry.name === "node_modules" ||
          entry.name === "dist" || entry.name === "build" || entry.name === "target" ||
          entry.name === "coverage" || entry.name === "reasonix" ||
          entry.name === ".reasonix") {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...collectTextFiles(fullPath));
      } else if (entry.isFile() && isTextFile(entry.name)) {
        files.push(fullPath);
      }
    }
  } catch {
    // 无权限访问，跳过
  }

  return files;
}

/** 判断文件名是否属于文本/源码文件 */
function isTextFile(name: string): boolean {
  const textExts = [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
    ".json", ".md", ".mdx", ".yaml", ".yml", ".toml",
    ".html", ".css", ".scss", ".less",
    ".py", ".rb", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp",
    ".txt", ".csv", ".xml", ".svg",
    ".sh", ".bash", ".zsh", ".env", ".gitignore",
    ".sql", ".graphql", ".proto",
  ];
  const ext = path.extname(name).toLowerCase();
  return textExts.includes(ext);
}

/* ═══════════════════════════════════════════════════════════════════
   ① create_file — 创建新文件
   ═══════════════════════════════════════════════════════════════════ */

const createFileDefinition: ToolDefinition = {
  name: "create_file",
  description:
    "Create a new file with the given content. " +
    "path: relative or absolute path. content: file content. " +
    "If the path already exists, returns an error — use edit_lines to modify existing files. " +
    "Side effects: writes to the filesystem. " +
    "Parent directories are created automatically.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to create" },
      content: { type: "string", description: "File content" },
    },
    required: ["path", "content"],
  },
};

const createFileHandler = async (args: Record<string, unknown>): Promise<string> => {
  const filePath = String(args.path ?? "").trim();
  const content = String(args.content ?? "");

  if (!filePath) {
    return "create_file: path cannot be empty";
  }

  if (fs.existsSync(filePath)) {
    return `create_file: file already exists: ${filePath}. Use edit_lines to modify existing files.`;
  }

  try {
    // 确保父目录存在
    const parentDir = path.dirname(filePath);
    if (parentDir && parentDir !== ".") {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, "utf-8");

    const lines = countLines(content);
    const size = Buffer.byteLength(content, "utf-8");
    return `[created: ${filePath} (${lines} lines, ${formatBytes(size)})]`;
  } catch (e) {
    return `create_file: error creating file — ${(e as Error).message}`;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   ② delete_file — 删除文件/目录
   ═══════════════════════════════════════════════════════════════════ */

const deleteFileDefinition: ToolDefinition = {
  name: "delete_file",
  description:
    "Delete a file or empty directory. " +
    "path: file or directory path. recursive: whether to delete non-empty directories (default false). " +
    "Use with caution — deletion is irreversible. " +
    "Side effects: modifies the filesystem.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path" },
      recursive: { type: "boolean", description: "Delete non-empty directories (default false)" },
    },
    required: ["path"],
  },
};

const deleteFileHandler = async (args: Record<string, unknown>): Promise<string> => {
  const filePath = String(args.path ?? "").trim();
  const recursive = Boolean(args.recursive);

  if (!filePath) {
    return "delete_file: path cannot be empty";
  }

  if (!fs.existsSync(filePath)) {
    return `delete_file: path does not exist: ${filePath}`;
  }

  try {
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      if (!recursive) {
        // 检查目录是否为空
        const entries = fs.readdirSync(filePath);
        if (entries.length > 0) {
          return `delete_file: directory not empty: ${filePath}. Use recursive=true to delete non-empty directories.`;
        }
        // 空目录 — 用 rmdirSync
        fs.rmdirSync(filePath);
      } else {
        fs.rmSync(filePath, { recursive: true, force: true });
      }
      return `[deleted directory: ${filePath}]`;
    } else {
      fs.unlinkSync(filePath);
      const size = formatBytes(stat.size);
      return `[deleted: ${filePath} (${size})]`;
    }
  } catch (e) {
    return `delete_file: error deleting ${filePath} — ${(e as Error).message}`;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   ③ list_directory — 浏览目录结构
   ═══════════════════════════════════════════════════════════════════ */

const listDirectoryDefinition: ToolDefinition = {
  name: "list_directory",
  description:
    "List files and subdirectories in a directory. " +
    "Returns name, type (file/dir), size, and modification time for each entry. " +
    "depth: recursion depth (default 1, max 3). " +
    "Use to understand project structure or find relevant files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default: current directory)" },
      depth: { type: "number", description: "Recursion depth (default 1, max 3)" },
    },
  },
};

interface DirEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: Date;
}

function listDirRecursive(dirPath: string, depth: number, currentDepth: number): DirEntry[] {
  const entries: DirEntry[] = [];

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);

      try {
        if (item.isDirectory()) {
          const entry: DirEntry = {
            name: item.name,
            type: "dir",
            size: 0,
            mtime: fs.statSync(fullPath).mtime,
          };
          entries.push(entry);

          if (currentDepth < depth && !item.name.startsWith(".") &&
              item.name !== "node_modules") {
            const children = listDirRecursive(fullPath, depth, currentDepth + 1);
            for (const child of children) {
              child.name = `${item.name}/${child.name}`;
              entries.push(child);
            }
          }
        } else if (item.isFile()) {
          try {
            const stat = fs.statSync(fullPath);
            entries.push({
              name: item.name,
              type: "file",
              size: stat.size,
              mtime: stat.mtime,
            });
          } catch {
            entries.push({ name: item.name, type: "file", size: 0, mtime: new Date(0) });
          }
        }
      } catch {
        // 无权限，跳过此条目
      }
    }
  } catch {
    // 读取目录出错
  }

  return entries;
}

function formatDirectoryTree(dirPath: string, entries: DirEntry[], depth: number): string {
  const parts: string[] = [`Directory listing for: ${dirPath} (depth=${depth})\n`];

  if (entries.length === 0) {
    parts.push("(empty directory)");
    return parts.join("\n");
  }

  // 排序：目录在前，然后按字母序
  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // 列宽计算
  const maxNameLen = Math.min(Math.max(...sorted.map((e) => e.name.length), 4), 60);
  const formatted = sorted.map((e) => {
    const typeTag = e.type === "dir" ? "📁 " : "📄 ";
    const sizeStr = e.type === "dir" ? "       " : `${formatBytes(e.size).padStart(7)}`;
    const dateStr = e.mtime.toISOString().slice(0, 10);
    return `  ${typeTag}${e.name.padEnd(maxNameLen + 2)}${sizeStr}  ${dateStr}`;
  });

  parts.push(formatted.join("\n"));

  const fileCount = sorted.filter((e) => e.type === "file").length;
  const dirCount = sorted.filter((e) => e.type === "dir").length;
  parts.push(`\n${fileCount} files, ${dirCount} directories`);

  return parts.join("\n");
}

const listDirectoryHandler = async (args: Record<string, unknown>): Promise<string> => {
  const dirPath = String(args.path ?? ".").trim() || ".";
  const depthRaw = Number(args.depth ?? 1);
  const depth = Math.max(1, Math.min(3, Number.isFinite(depthRaw) ? Math.round(depthRaw) : 1));

  if (!fs.existsSync(dirPath)) {
    return `list_directory: directory does not exist: ${dirPath}`;
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    return `list_directory: not a directory: ${dirPath}`;
  }

  try {
    const entries = listDirRecursive(dirPath, depth, 1);
    return formatDirectoryTree(dirPath, entries, depth);
  } catch (e) {
    return `list_directory: error reading directory — ${(e as Error).message}`;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   ④ glob_files — Glob 搜索文件
   ═══════════════════════════════════════════════════════════════════ */

const globFilesDefinition: ToolDefinition = {
  name: "glob_files",
  description:
    "Find files matching a glob pattern. " +
    "Pattern: e.g. 'src/**/*.test.ts', '**/*.md', '**/config.*'. " +
    "Returns file paths sorted by modification time (newest first). " +
    "Limit: maximum results to return (default 50, max 200). " +
    "Skips node_modules, .git, dist, build, and target directories.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match" },
      limit: { type: "number", description: "Max results (default 50, max 200)" },
    },
    required: ["pattern"],
  },
};

/**
 * Simple glob matching — supports *, **, ?, and {a,b} patterns.
 * Recursively walks directories, respecting the skip list.
 */
function simpleGlob(
  baseDir: string,
  pattern: string,
  limit: number,
): string[] {
  const results: string[] = [];
  const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target", "coverage", ".reasonix"]);

  function walk(dir: string): void {
    if (results.length >= limit) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relative = path.relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath);
      }

      if (entry.isFile()) {
        if (matchGlob(relative, pattern)) {
          results.push(relative);
        }
      }
    }
  }

  walk(baseDir);
  return results;
}

/** 简易 glob 匹配 — 将 glob 模式转为类正则匹配 */
function matchGlob(filePath: string, pattern: string): boolean {
  // 统一转为 POSIX 分隔符
  const normalizedPath = filePath.replace(/\\/g, "/");
  const normalizedPattern = pattern.replace(/\\/g, "/");

  // 将 glob 模式转为正则字符串
  let regexStr = "";
  let i = 0;
  while (i < normalizedPattern.length) {
    const ch = normalizedPattern[i];

    if (ch === '*') {
      if (i + 1 < normalizedPattern.length && normalizedPattern[i + 1] === '*') {
        // ** — 匹配任意字符，包括路径分隔符
        regexStr += '.*';
        i += 2;
        // 跳过后面的 /
        if (i < normalizedPattern.length && normalizedPattern[i] === '/') {
          i++;
        }
      } else {
        // * — 匹配单个路径段内（不含 /）
        regexStr += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '{') {
      // {a,b} — 多选一分组
      const closeBrace = normalizedPattern.indexOf('}', i);
      if (closeBrace > i) {
        const alternatives = normalizedPattern.slice(i + 1, closeBrace).split(',');
        regexStr += '(' + alternatives.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = closeBrace + 1;
      } else {
        regexStr += '\\{';
        i++;
      }
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  try {
    const re = new RegExp(`^${regexStr}$`);
    return re.test(normalizedPath);
  } catch {
    return false;
  }
}

const globFilesHandler = async (args: Record<string, unknown>): Promise<string> => {
  const pattern = String(args.pattern ?? "").trim();
  const globPath = String(args.path ?? process.cwd()).trim() || process.cwd();
  const limitRaw = Number(args.limit ?? 50);
  const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? Math.round(limitRaw) : 50));

  if (!pattern) {
    return "glob_files: pattern cannot be empty";
  }

  try {
    const results = simpleGlob(globPath, pattern, limit);
    if (results.length === 0) {
      return `(no files matching "${pattern}")`;
    }

  // 按 mtime 排序（最新在前）
    const withMtime = results.map((f) => {
      try {
        const stat = fs.statSync(path.resolve(f));
        return { file: f, mtime: stat.mtimeMs };
      } catch {
        return { file: f, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);

    const lines = withMtime.map((f, i) => {
      const num = String(i + 1).padStart(3);
      return `${num}. ${f.file}`;
    });

    return lines.join("\n") + `\n\n${results.length} file(s) matched`;
  } catch (e) {
    return `glob_files: error — ${(e as Error).message}`;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   ⑤ get_file_info — 文件元信息
   ═══════════════════════════════════════════════════════════════════ */

const getFileInfoDefinition: ToolDefinition = {
  name: "get_file_info",
  description:
    "Get file metadata without reading the full content. " +
    "Returns: size (bytes, human-readable), mtime (ISO date), type (file/dir/symlink), " +
    "and line count for text files. " +
    "Use when you want to check if a file is large before reading it, or verify a file exists.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path" },
    },
    required: ["path"],
  },
};

const getFileInfoHandler = async (args: Record<string, unknown>): Promise<string> => {
  const filePath = String(args.path ?? "").trim();

  if (!filePath) {
    return "get_file_info: path cannot be empty";
  }

  if (!fs.existsSync(filePath)) {
    return `get_file_info: path does not exist: ${filePath}`;
  }

  try {
    const stat = fs.statSync(filePath);
    const typeMap: Record<string, string> = {
      "true:false": "file",
      "false:true": "directory",
      "false:false": "symlink",
    };
    const typeKey = `${stat.isFile()}:${stat.isDirectory()}`;
    const type = typeMap[typeKey] ?? "other";

    const lines: string[] = [
      `  path: ${filePath}`,
      `  size: ${formatBytes(stat.size)} (${stat.size} bytes)`,
      `  type: ${type}`,
      `  modified: ${stat.mtime.toISOString()}`,
      `  created: ${stat.birthtime.toISOString()}`,
      `  permissions: ${stat.mode.toString(8).slice(-3)}`,
    ];

  // 尝试统计文本文件行数
    if (stat.isFile() && stat.size > 0 && stat.size < 10 * 1024 * 1024) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lineCount = countLines(content);
        lines.push(`  lines: ${lineCount}`);
      } catch {
        // 二进制文件，跳过行数统计
      }
    }

    return lines.join("\n");
  } catch (e) {
    return `get_file_info: error reading metadata — ${(e as Error).message}`;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   ⑥ search_in_files — 文件内容搜索
   ═══════════════════════════════════════════════════════════════════ */

const searchInFilesDefinition: ToolDefinition = {
  name: "search_in_files",
  description:
    "Search for text or regex across multiple files. " +
    "Returns file:line matches with surrounding context. " +
    "pattern: text or regex to search for. " +
    "path: directory or file to search in (default: current directory). " +
    "glob: optional file pattern filter (e.g. '*.ts'). " +
    "context: lines of context before and after each match (default 0). " +
    "case_sensitive: whether the search is case-sensitive (default false). " +
    "Use to find where a function is called, where a pattern appears in the codebase. " +
    "Skips binary files, node_modules, .git, dist, and build directories.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Text or regex to search" },
      path: { type: "string", description: "Search root directory or file (default: current directory)" },
      glob: { type: "string", description: "File pattern filter (e.g. '*.ts', '*.md')" },
      context: { type: "number", description: "Lines of surrounding context (default 0, max 20)" },
      case_sensitive: { type: "boolean", description: "Case-sensitive search (default false)" },
    },
    required: ["pattern"],
  },
};

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

const searchInFilesHandler = async (args: Record<string, unknown>): Promise<string> => {
  const pattern = String(args.pattern ?? "").trim();
  const searchPath = String(args.path ?? process.cwd()).trim() || process.cwd();
  const globFilter = String(args.glob ?? "").trim() || undefined;
  const contextRaw = Number(args.context ?? 0);
  const contextLines = Math.max(0, Math.min(20, Number.isFinite(contextRaw) ? Math.round(contextRaw) : 0));
  const caseSensitive = Boolean(args.case_sensitive);

  if (!pattern) {
    return "search_in_files: pattern cannot be empty";
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch {
    // 如果不是合法 regex，当做字面量字符串搜索
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, caseSensitive ? "g" : "gi");
  }

  try {
    if (!fs.existsSync(searchPath)) {
      return "search_in_files: path does not exist";
    }

    const isDir = fs.statSync(searchPath).isDirectory();
    const files = isDir ? collectTextFiles(searchPath) : [searchPath];

    // 按 glob 过滤文件
    let filteredFiles = files;
    if (globFilter) {
      filteredFiles = files.filter((f) => {
        const relPath = path.isAbsolute(globFilter)
          ? f
          : path.relative(searchPath, f);
        return matchGlob(relPath.replace(/\\/g, "/"), globFilter);
      });
    }

    const matches: { file: string; line: number; content: string; lines: string[] }[] = [];

    for (const filePath of filteredFiles) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0; // 每行重置正则
          if (regex.test(lines[i])) {
            // 收集上下文行
            const contextStart = Math.max(0, i - contextLines);
            const contextEnd = Math.min(lines.length, i + contextLines + 1);
            const contextSlice = lines.slice(contextStart, contextEnd);

            matches.push({
              file: filePath,
              line: i + 1,
              content: lines[i].trim(),
              lines: contextSlice,
            });
          }
        }
      } catch {
        // 跳过不可读的文件
      }
    }

    if (matches.length === 0) {
      return `(no matches for "${pattern}" in ${isDir ? searchPath : path.basename(searchPath)})`;
    }

    // 格式化输出
    const parts: string[] = [];;

    if (contextLines > 0) {
      // 带上下文：显示分组块
      for (const m of matches) {
        const relFile = path.relative(process.cwd(), m.file);
        parts.push(`\n${relFile}:${m.line}`);
        const startLine = m.line - contextLines;
        for (let i = 0; i < m.lines.length; i++) {
          const lineNum = startLine + i;
          const prefix = lineNum + 1 === m.line ? ">" : " ";
          parts.push(`  ${prefix} ${String(lineNum + 1).padStart(4)}| ${m.lines[i]}`);
        }
      }
    } else {
      // 紧凑格式：file:line:content
      for (const m of matches) {
        const relFile = path.relative(process.cwd(), m.file);
        parts.push(`${relFile}:${m.line}: ${m.content}`);
      }
    }

    parts.push(`\n${matches.length} match(es) found`);
    return parts.join("\n");
  } catch (e) {
    return `search_in_files: error — ${(e as Error).message}`;
  }
};

/* ═══════════════════════════════════════════════════════════════════
   工厂函数 — 创建所有扩展文件系统工具
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 创建 6 个扩展文件系统工具的 CatalogEntry 数组。
 *
 * @param projectRoot - 项目根目录（用于默认路径解析）
 * @returns CatalogEntry[] — 6 个工具的目录条目
 */
export function createExtendedFilesystemTools(): CatalogEntry[] {
  const tools: CatalogEntry[] = [];

  // ① create_file
  tools.push({
    definition: createFileDefinition,
    handler: createFileHandler as unknown as (args: Record<string, unknown>) => string,
    asyncHandler: createFileHandler,
  });

  // ② delete_file
  tools.push({
    definition: deleteFileDefinition,
    handler: deleteFileHandler as unknown as (args: Record<string, unknown>) => string,
    asyncHandler: deleteFileHandler,
  });

  // ③ list_directory
  tools.push({
    definition: listDirectoryDefinition,
    handler: listDirectoryHandler as unknown as (args: Record<string, unknown>) => string,
    asyncHandler: listDirectoryHandler,
  });

  // ④ glob_files
  tools.push({
    definition: globFilesDefinition,
    handler: globFilesHandler as unknown as (args: Record<string, unknown>) => string,
    asyncHandler: globFilesHandler,
  });

  // ⑤ get_file_info
  tools.push({
    definition: getFileInfoDefinition,
    handler: getFileInfoHandler as unknown as (args: Record<string, unknown>) => string,
    asyncHandler: getFileInfoHandler,
  });

  // ⑥ search_in_files
  tools.push({
    definition: searchInFilesDefinition,
    handler: searchInFilesHandler as unknown as (args: Record<string, unknown>) => string,
    asyncHandler: searchInFilesHandler,
  });

  return tools;
}
