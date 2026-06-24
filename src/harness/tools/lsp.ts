/**
 * LSP 集成工具（第 25 章）
 *
 * 通过 Language Server Protocol（LSP）为 agent 提供编辑器级别的代码智能：
 *   1. lsp_definition     — 跳转到符号定义
 *   2. lsp_references     — 查找所有引用
 *   3. lsp_hover           — 获取悬停文档/签名
 *   4. lsp_completion      — 获取补全建议
 *   5. lsp_signature_help  — 获取函数签名
 *   6. lsp_diagnostic      — 获取文件诊断
 *
 * LSP 是有状态协议——server 在内存中维护项目符号表、AST 缓存、引用索引。
 * LSPManager 保持长连接，所有工具共享同一会话。
 *
 * ## 架构
 *
 * ```
 * Agent 工具        LSPManager          LSP Server (子进程)
 * ─────────         ──────────          ─────────────────
 * lsp_definition ──▶ getDefinition ────▶ textDocument/definition
 * lsp_references ──▶ getReferences ────▶ textDocument/references
 * lsp_hover       ──▶ getHover       ───▶ textDocument/hover
 * lsp_completion  ──▶ getCompletion   ───▶ textDocument/completion
 * lsp_signature   ──▶ getSignature    ───▶ textDocument/signatureHelp
 * lsp_diagnostic  ──▶ getDiagnostics  ───▶ textDocument/diagnostic
 * ```
 */
import * as cp from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { Readable, Writable } from "node:stream";
import type { CatalogEntry } from "./selector.js";
import type { ToolDefinition } from "./registry.js";

/* ═══════════════════════════════════════════════════════════════════
   类型定义
   ═══════════════════════════════════════════════════════════════════ */

/** LSP 位置（1-based line 和 column） */
export interface LspPosition {
  line: number;
  character: number;
}

/** LSP 范围 */
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** LSP 位置结果 */
export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** LSP 悬停结果 */
export interface LspHoverResult {
  contents: string;
  range?: LspRange;
}

/** LSP 补全项 */
export interface LspCompletionItem {
  label: string;
  detail?: string;
  documentation?: string;
  kind?: number;
}

/** LSP 签名信息 */
export interface LspSignatureInfo {
  label: string;
  documentation?: string;
  parameters: { label: string; documentation?: string }[];
  activeParameter?: number;
}

/** LSP 诊断项 */
export interface LspDiagnosticItem {
  range: LspRange;
  severity: number;  // 1=error, 2=warning, 3=info, 4=hint
  message: string;
  source?: string;
  code?: string | number;
}

/** LSP 诊断结果 */
export interface LspDiagnosticResult {
  uri: string;
  diagnostics: LspDiagnosticItem[];
}

/** 语言配置 */
interface LanguageConfig {
  serverCommand: string;
  serverArgs: string[];
  extensions: string[];
}

/* ─── 受支持的语言 ──────────────────────────────────────────────── */

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  typescript: {
    serverCommand: "typescript-language-server",
    serverArgs: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  },
  python: {
    serverCommand: "pyright-langserver",
    serverArgs: ["--stdio"],
    extensions: [".py"],
  },
  go: {
    serverCommand: "gopls",
    serverArgs: [],
    extensions: [".go"],
  },
  rust: {
    serverCommand: "rust-analyzer",
    serverArgs: [],
    extensions: [".rs"],
  },
  markdown: {
    serverCommand: "marksman",
    serverArgs: ["server"],
    extensions: [".md", ".mdx"],
  },
};

/** 从文件路径推断语言 */
function detectLanguage(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  for (const [lang, cfg] of Object.entries(LANGUAGE_CONFIGS)) {
    if (cfg.extensions.includes(ext)) return lang;
  }
  return undefined;
}

/* ═══════════════════════════════════════════════════════════════════
   JSON-RPC 2.0 传输层
   ═══════════════════════════════════════════════════════════════════ */

/** LSP 传输层——处理 Content-Length 帧的解析与发送 */
export class LspTransport {
  private requestId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = "";
  private child?: cp.ChildProcess;
  private _closed = false;

  /** 注入用——可替换为 mock transport */
  stdout?: Readable;
  stdin?: Writable;

  get closed(): boolean { return this._closed; }

  /**
   * 启动 LSP server 子进程。
   * @param command - server 命令
   * @param args - 命令行参数
   */
  spawn(command: string, args: string[]): void {
    if (this.child) throw new Error("LSP transport already spawned");

    this.child = cp.spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    this.stdout = this.child.stdout ?? undefined;
    this.stdin = this.child.stdin ?? undefined;

    if (!this.stdout || !this.stdin) {
      throw new Error(`failed to spawn ${command}: stdio not available`);
    }

    // 收集 stderr（仅调试用）
    this.child.stderr?.on("data", (data: Buffer) => {
      // LSP server 的 stderr 通常只是日志
    });

    // 监听退出
    this.child.on("exit", (code, signal) => {
      this._closed = true;
      // 拒绝所有未完成的请求
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`LSP server exited (code=${code}, signal=${signal})`));
        clearTimeout(pending.timer);
      }
      this.pending.clear();
    });

    // 监听错误
    this.child.on("error", (err) => {
      this._closed = true;
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`LSP server error: ${err.message}`));
        clearTimeout(pending.timer);
      }
      this.pending.clear();
    });

    // 读取响应：Content-Length 帧协议
    this.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString("utf-8");
      this._parseBuffer();
    });
  }

  /** 连接到已有的 stdout/stdin（用于测试 mock） */
  connect(externalStdout: Readable, externalStdin: Writable): void {
    this.stdout = externalStdout;
    this.stdin = externalStdin;

    externalStdout.on("data", (data: Buffer) => {
      this.buffer += data.toString("utf-8");
      this._parseBuffer();
    });
  }

  /** 发送 JSON-RPC 请求，返回响应 */
  async sendRequest(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this._closed) {
      throw new LspError("LSP_SERVER_CRASHED", "LSP server not running");
    }

    const id = this.requestId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError("LSP_TIMEOUT", `LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.stdin!.write(header + body);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new LspError("LSP_WRITE_ERROR", `failed to write to LSP server: ${(err as Error).message}`));
      }
    });
  }

  /** 发送 JSON-RPC 通知（无需响应） */
  sendNotification(method: string, params: unknown): void {
    if (this._closed) return;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;

    try {
      this.stdin!.write(header + body);
    } catch {
      // 通知失败不阻塞
    }
  }

  /** 关闭连接 */
  close(): void {
    this._closed = true;
    this.child?.kill("SIGTERM");
    this.child = undefined;

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("LSP transport closed"));
    }
    this.pending.clear();
  }

  /** 解析 Content-Length 帧缓冲区 */
  private _parseBuffer(): void {
    const headerMatch = /Content-Length: (\d+)\r\n\r\n/.exec(this.buffer);
    if (!headerMatch) return;

    const contentLength = parseInt(headerMatch[1], 10);
    const headerEnd = headerMatch.index + headerMatch[0].length;
    const bodyStart = headerEnd;
    const bodyEnd = bodyStart + contentLength;

    if (this.buffer.length < bodyEnd) return;  // 等待更多数据

    const bodyStr = this.buffer.slice(bodyStart, bodyEnd);
    this.buffer = this.buffer.slice(bodyEnd);

    try {
      const msg = JSON.parse(bodyStr);

      // 处理响应
      if (msg.id !== undefined && msg.id !== null) {
        const pending = this.pending.get(Number(msg.id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(Number(msg.id));

          if (msg.error) {
            pending.reject(new LspError("LSP_ERROR", msg.error.message, msg.error.code));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch {
      // JSON 解析失败，忽略这条消息
    }

    // 继续解析可能的多帧
    this._parseBuffer();
  }
}

/* ─── LSP 错误类型 ──────────────────────────────────────────────── */

export class LspError extends Error {
  constructor(
    public code: string,
    message: string,
    public originalCode?: number,
  ) {
    super(message);
    this.name = "LspError";
  }
}

/** 严重级别名称 */
export const SEVERITY_NAMES: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** 补全项类型名称（LSP 标准） */
export const COMPLETION_KINDS: Record<number, string> = {
  1: "Text", 2: "Method", 3: "Function", 4: "Constructor",
  5: "Field", 6: "Variable", 7: "Class", 8: "Interface",
  9: "Module", 10: "Property", 11: "Unit", 12: "Value",
  13: "Enum", 14: "Keyword", 15: "Snippet", 16: "Color",
  17: "File", 18: "Reference", 19: "Folder", 20: "EnumMember",
  21: "Constant", 22: "Struct", 23: "Event", 24: "Operator",
  25: "TypeParameter",
};

/* ═══════════════════════════════════════════════════════════════════
   LSPManager — LSP 会话管理器
   ═══════════════════════════════════════════════════════════════════ */

/**
 * LSPManager 管理一个语言服务器的生命周期和所有 LSP 请求。
 *
 * 使用方式：
 * ```ts
 * const lsp = new LSPManager(process.cwd());
 * await lsp.initialize("typescript");
 * await lsp.openDocument("src/main.ts", fs.readFileSync("src/main.ts", "utf-8"));
 * const def = await lsp.getDefinition("src/main.ts", 10, 5);
 * await lsp.shutdown();
 * ```
 *
 * Mock 模式（测试）：
 * ```ts
 * const mockTransport = new LspTransport();
 * mockTransport.connect(mockStdout, mockStdin);
 * const lsp = new LSPManager("/project", mockTransport);
 * ```
 */
export class LSPManager {
  private transport: LspTransport;
  private initialized = false;
  private capabilities: Record<string, unknown> = {};
  private rootUri: string;
  private openDocuments = new Set<string>();
  private language?: string;

  constructor(rootDir: string, transport?: LspTransport) {
    this.rootUri = path.resolve(rootDir);
    this.transport = transport ?? new LspTransport();
  }

  get isInitialized(): boolean { return this.initialized; }
  get activeTransport(): LspTransport { return this.transport; }

  /**
   * 初始化 LSP 连接。
   * 发送 initialize 请求 + initialized 通知。
   */
  async initialize(language: string, projectRoot?: string): Promise<void> {
    if (this.initialized) {
      throw new Error("LSP already initialized");
    }

    this.language = language;
    const config = LANGUAGE_CONFIGS[language];

    if (!config) {
      throw new Error(`unsupported language: ${language}. Supported: ${Object.keys(LANGUAGE_CONFIGS).join(", ")}`);
    }

    // 如果 transport 还没 spawn，使用默认配置启动
    if (!this.transport.stdout && !this.transport.closed) {
      this.transport.spawn(config.serverCommand, config.serverArgs);
    }

    const rootUri = projectRoot
      ? `file://${path.resolve(projectRoot)}`
      : `file://${this.rootUri}`;

    const result = await this.transport.sendRequest("initialize", {
      processId: process.pid,
      clientInfo: { name: "agent-harness", version: "0.1.0" },
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          completion: { completionItem: { documentationFormat: ["markdown", "plaintext"] } },
          signatureHelp: {},
          definition: {},
          references: {},
          diagnostic: {},
        },
      },
    }) as Record<string, unknown>;

    this.capabilities = result?.capabilities as Record<string, unknown> ?? {};

    this.transport.sendNotification("initialized", {});
    this.initialized = true;
  }

  /**
   * 打开一个文档并发送 didOpen 通知。
   * 工具不需要手动调用——readFileViewport 和 editLines 会自动调用此方法。
   */
  async openDocument(filePath: string, text?: string): Promise<void> {
    const absPath = path.resolve(this.rootUri, filePath);
    const uri = `file://${absPath}`;

    if (this.openDocuments.has(uri)) return;

    if (text === undefined) {
      text = fs.readFileSync(absPath, "utf-8");
    }

    this.transport.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this._languageId(filePath),
        version: 1,
        text,
      },
    });

    this.openDocuments.add(uri);
  }

  /**
   * 更新文档内容（编辑后调用）。
   * 发送 didChange 通知。
   */
  async changeDocument(filePath: string, text: string, version: number): Promise<void> {
    const absPath = path.resolve(this.rootUri, filePath);
    const uri = `file://${absPath}`;

    this.transport.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** 关闭文档 */
  async closeDocument(filePath: string): Promise<void> {
    const uri = `file://${path.resolve(this.rootUri, filePath)}`;
    this.transport.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
    this.openDocuments.delete(uri);
  }

  /** 优雅关闭 */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    try {
      await this.transport.sendRequest("shutdown", null);
      this.transport.sendNotification("exit", {});
    } finally {
      this.initialized = false;
      this.transport.close();
    }
  }

  /* ─── LSP 功能方法 ──────────────────────────────────────────── */

  /** 跳转到定义 */
  async getDefinition(filePath: string, line: number, column: number): Promise<LspLocation | null> {
    const uri = this._toUri(filePath);
    const result = await this.transport.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },  // LSP 是 0-based
    }) as unknown;

    return this._parseLocation(result);
  }

  /** 查找引用 */
  async getReferences(filePath: string, line: number, column: number): Promise<LspLocation[]> {
    const uri = this._toUri(filePath);
    const result = await this.transport.sendRequest("textDocument/references", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true },
    }) as unknown[];

    if (!Array.isArray(result)) return [];
    return result.map(this._parseLocationItem).filter(Boolean) as LspLocation[];
  }

  /** 获取悬停信息 */
  async getHover(filePath: string, line: number, column: number): Promise<LspHoverResult | null> {
    const uri = this._toUri(filePath);
    const result = await this.transport.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    }) as Record<string, unknown> | null;

    if (!result) return null;

    const contents = this._formatMarkupContent(result.contents);
    const range = result.range ? {
      start: { line: (result.range as Record<string, unknown>).start as number + 1, character: 0 },
      end: { line: (result.range as Record<string, unknown>).end as number + 1, character: 0 },
    } as LspRange : undefined;

    return { contents, range };
  }

  /** 获取补全 */
  async getCompletion(filePath: string, line: number, column: number): Promise<LspCompletionItem[]> {
    const uri = this._toUri(filePath);
    const result = await this.transport.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    }) as unknown;

    if (!result) return [];

    // LSP 可能返回 { isIncomplete, items } 或直接数组
    const items = Array.isArray(result) ? result : (result as Record<string, unknown>).items as unknown[];
    if (!Array.isArray(items)) return [];

    return items.map((item: unknown) => {
      const entry = item as Record<string, unknown>;
      return {
        label: String(entry.label ?? ""),
        detail: entry.detail ? String(entry.detail) : undefined,
        documentation: entry.documentation
          ? this._formatMarkupContent(entry.documentation)
          : undefined,
        kind: entry.kind ? Number(entry.kind) : undefined,
      };
    });
  }

  /** 获取签名帮助 */
  async getSignatureHelp(filePath: string, line: number, column: number): Promise<LspSignatureInfo | null> {
    const uri = this._toUri(filePath);
    const result = await this.transport.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    }) as Record<string, unknown> | null;

    if (!result || !result.signatures) return null;

    const signatures = result.signatures as Record<string, unknown>[];
    if (signatures.length === 0) return null;

    const activeSig = result.activeSignature !== undefined
      ? signatures[Number(result.activeSignature)]
      : signatures[0];

    if (!activeSig) return null;

    return {
      label: String(activeSig.label ?? ""),
      documentation: activeSig.documentation
        ? this._formatMarkupContent(activeSig.documentation)
        : undefined,
      parameters: ((activeSig.parameters as Record<string, unknown>[]) ?? []).map((p) => ({
        label: typeof p.label === "string" ? p.label : JSON.stringify(p.label),
        documentation: p.documentation ? this._formatMarkupContent(p.documentation) : undefined,
      })),
      activeParameter: result.activeParameter !== undefined ? Number(result.activeParameter) : undefined,
    };
  }

  /** 获取文件诊断 */
  async getDiagnostics(filePath: string): Promise<LspDiagnosticItem[]> {
    const uri = this._toUri(filePath);
    const result = await this.transport.sendRequest("textDocument/diagnostic", {
      textDocument: { uri },
    }) as Record<string, unknown> | null;

    if (!result) return [];

    // 可能是 { kind: "full", items: [...] }
    const items = (result.items ?? result.diagnostics ?? []) as Record<string, unknown>[];
    if (!Array.isArray(items)) return [];

    return items.map((d) => ({
      range: {
        start: { line: (d.range as Record<string, unknown>).start as number + 1, character: 0 },
        end: { line: (d.range as Record<string, unknown>).end as number + 1, character: 0 },
      },
      severity: d.severity !== undefined ? Number(d.severity) : 1,
      message: String(d.message ?? ""),
      source: d.source ? String(d.source) : undefined,
      code: d.code !== undefined ? (typeof d.code === "number" ? d.code : String(d.code)) : undefined,
    }));
  }

  /* ─── 内部方法 ──────────────────────────────────────────────── */

  private _toUri(filePath: string): string {
    const absPath = path.resolve(this.rootUri, filePath);
    return `file://${absPath}`;
  }

  private _languageId(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
      ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript",
      ".jsx": "javascriptreact", ".py": "python", ".go": "go",
      ".rs": "rust", ".md": "markdown", ".json": "json",
      ".yaml": "yaml", ".yml": "yaml", ".css": "css",
      ".html": "html", ".mjs": "javascript", ".cjs": "javascript",
    };
    return langMap[ext] ?? ext.slice(1);
  }

  /** 解析 LSP 返回的 Location（可能是单个或数组） */
  private _parseLocation(result: unknown): LspLocation | null {
    if (!result) return null;

    if (Array.isArray(result)) {
      if (result.length === 0) return null;
      return this._parseLocationItem(result[0]);
    }

    return this._parseLocationItem(result);
  }

  private _parseLocationItem(item: unknown): LspLocation | null {
    if (!item || typeof item !== "object") return null;
    const loc = item as Record<string, unknown>;

    if (!loc.uri || !loc.range) return null;
    const range = loc.range as Record<string, unknown>;
    const start = range.start as Record<string, unknown>;
    const end = range.end as Record<string, unknown>;

    return {
      uri: String(loc.uri),
      range: {
        start: { line: Number(start.line) + 1, character: Number(start.character) + 1 },
        end: { line: Number(end.line) + 1, character: Number(end.character) + 1 },
      },
    };
  }

  /** 格式化 LSP MarkupContent（可能是字符串或 { kind, value }） */
  private _formatMarkupContent(content: unknown): string {
    if (!content) return "";

    if (typeof content === "string") return content;

    const obj = content as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.kind === "string" && typeof obj.value === "string") {
      return obj.value;
    }

    return JSON.stringify(content);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   MockLSPManager — 用于测试的 mock server
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 为测试提供一个可预测的 LSPManager。
 * 不启动真实 LSP server，而是返回预设数据。
 */
export class MockLSPManager extends LSPManager {
  private mockDefinitions = new Map<string, LspLocation>();
  private mockReferences = new Map<string, LspLocation[]>();
  private mockHovers = new Map<string, LspHoverResult>();
  private mockCompletions = new Map<string, LspCompletionItem[]>();
  private mockSignatures = new Map<string, LspSignatureInfo>();
  private mockDiagnostics = new Map<string, LspDiagnosticItem[]>();

  constructor(rootDir: string) {
    // 使用哑 transport（不启动真实进程）
    const dummyTransport = new LspTransport();
    super(rootDir, dummyTransport);
  }

  /** Mock 模式：始终报告已初始化 */
  override get isInitialized(): boolean { return true; }

  /** 跳过真实 initialize */
  override async initialize(): Promise<void> {
    // Mock 模式：不连接真实 server
  }

  /* ─── 预设数据注册 ──────────────────────────────────────────── */

  setMockDefinition(key: string, location: LspLocation): void {
    this.mockDefinitions.set(key, location);
  }

  setMockReferences(key: string, locations: LspLocation[]): void {
    this.mockReferences.set(key, locations);
  }

  setMockHover(key: string, hover: LspHoverResult): void {
    this.mockHovers.set(key, hover);
  }

  setMockCompletion(key: string, items: LspCompletionItem[]): void {
    this.mockCompletions.set(key, items);
  }

  setMockSignature(key: string, sig: LspSignatureInfo): void {
    this.mockSignatures.set(key, sig);
  }

  setMockDiagnostics(key: string, diags: LspDiagnosticItem[]): void {
    this.mockDiagnostics.set(key, diags);
  }

  /* ─── 覆盖 LSP 方法 ─────────────────────────────────────────── */

  private _key(file: string, line: number, col: number): string {
    return `${file}:${line}:${col}`;
  }

  override async getDefinition(file: string, line: number, col: number): Promise<LspLocation | null> {
    return this.mockDefinitions.get(this._key(file, line, col)) ?? null;
  }

  override async getReferences(file: string, line: number, col: number): Promise<LspLocation[]> {
    return this.mockReferences.get(this._key(file, line, col)) ?? [];
  }

  override async getHover(file: string, line: number, col: number): Promise<LspHoverResult | null> {
    return this.mockHovers.get(this._key(file, line, col)) ?? null;
  }

  override async getCompletion(file: string, line: number, col: number): Promise<LspCompletionItem[]> {
    return this.mockCompletions.get(this._key(file, line, col)) ?? [];
  }

  override async getSignatureHelp(file: string, line: number, col: number): Promise<LspSignatureInfo | null> {
    return this.mockSignatures.get(this._key(file, line, col)) ?? null;
  }

  override async getDiagnostics(file: string): Promise<LspDiagnosticItem[]> {
    return this.mockDiagnostics.get(file) ?? [];
  }

  override async openDocument(): Promise<void> {
    // no-op in mock mode
  }

  override async changeDocument(): Promise<void> {
    // no-op in mock mode
  }

  override async shutdown(): Promise<void> {
    // no-op in mock mode
  }
}

/* ═══════════════════════════════════════════════════════════════════
   上下文片段格式化
   ═══════════════════════════════════════════════════════════════════ */

/** 从文件读取目标行附近的上下文行 */
function readContextSnippet(filePath: string, line: number, contextLines = 3): string {
  try {
    const absPath = path.resolve(filePath);
    const content = fs.readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, line - 1 - contextLines);
    const end = Math.min(lines.length, line + contextLines);
    const width = String(end).length;

    return lines.slice(start, end).map(
      (l, i) => `${String(start + i + 1).padStart(width)}  ${l}`,
    ).join("\n");
  } catch {
    return "(file not accessible)";
  }
}

/** 从 URI 提取文件路径 */
function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? uri.slice(7) : uri;
}

/* ─── 格式化函数 ──────────────────────────────────────────────── */

/** 格式化位置结果（定义/引用） */
function formatLocation(
  label: string,
  location: LspLocation,
  extraContext?: string,
): string {
  const filePath = uriToPath(location.uri);
  const { line, character } = location.range.start;
  const snippet = readContextSnippet(filePath, line);

  return [
    `${label}: ${filePath}:${line}:${character}`,
    "```",
    snippet,
    "```",
    extraContext ?? "",
  ].filter(Boolean).join("\n");
}

/** 批量格式化位置列表 */
function formatLocations(
  label: string,
  locations: LspLocation[],
): string {
  if (locations.length === 0) {
    return `${label}: (no results)`;
  }

  const parts = locations.map((loc, i) => {
    const filePath = uriToPath(loc.uri);
    const { line, character } = loc.range.start;
    const snippet = readContextSnippet(filePath, line);
    return `[${i + 1}] ${filePath}:${line}:${character}\n\`\`\`\n${snippet}\n\`\`\``;
  });

  return `${label}: ${locations.length} results\n\n${parts.join("\n\n")}`;
}

/* ═══════════════════════════════════════════════════════════════════
   createLSPTools — 创建 6 个 LSP 工具的 CatalogEntry 数组
   ═══════════════════════════════════════════════════════════════════ */

/**
 * 创建 LSP 工具的 CatalogEntry 数组。
 *
 * @param projectRoot - 项目根目录（用于文件路径解析）
 * @param lspManager - 可选的 LSPManager 实例（用于测试注入 mock）
 * @returns CatalogEntry[]
 *
 * 使用方式：
 * ```ts
 * const lsp = new LSPManager(process.cwd());
 * await lsp.initialize("typescript");
 * const tools = createLSPTools(process.cwd(), lsp);
 * ```
 */
export function createLSPTools(
  projectRoot?: string,
  lspManager?: LSPManager,
): CatalogEntry[] {
  const root = projectRoot ?? process.cwd();
  const tools: CatalogEntry[] = [];

  /* ─── 工具构建器 ────────────────────────────────────────────── */

  function makeTool(
    name: string,
    description: string,
    extraProps: Record<string, unknown>,
    required: string[],
    handler: (args: Record<string, unknown>, lsp: LSPManager) => Promise<string>,
  ): CatalogEntry {
    const definition: ToolDefinition = {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "File path (relative to project root or absolute)",
          },
          line: {
            type: "number",
            description: "1-based line number of the symbol",
          },
          column: {
            type: "number",
            description: "1-based column number of the symbol",
          },
          ...extraProps,
        },
        required: ["file", "line", "column", ...required],
      },
    };

    const asyncHandler = async (args: Record<string, unknown>): Promise<string> => {
      if (!lspManager) {
        return `${name}: LSP not initialized. Start an LSP server first.`;
      }

      if (!lspManager.isInitialized) {
        return `${name}: LSP not initialized. Call lsp_initialize first or open a supported file.`;
      }

      const file = String(args.file ?? "");
      const line = Number(args.line);
      const column = Number(args.column);

      if (!file) return `${name}: file path is required`;
      if (!Number.isFinite(line) || line < 1) return `${name}: line must be a positive integer`;
      if (!Number.isFinite(column) || column < 1) return `${name}: column must be a positive integer`;

      try {
        // 自动打开文档（如果尚未打开）
        await lspManager.openDocument(file);
        return await handler(args, lspManager);
      } catch (err) {
        if (err instanceof LspError) {
          return `${name}: ${err.code} — ${err.message}`;
        }
        return `${name}: ${(err as Error).message}`;
      }
    };

    return { definition, asyncHandler, handler: (() => "(async)") as unknown as (args: Record<string, unknown>) => string };
  }

  /* ─── 1. lsp_definition ────────────────────────────────────── */

  tools.push(makeTool(
    "lsp_definition",
    "Go to definition: returns the file path and line/column where the symbol at the given position is defined. " +
    "Use to understand what a function, class, variable, or type refers to. " +
    "file: path to the file. line: 1-based line number. column: 1-based column. " +
    "Returns the definition location plus a 3-line context snippet around it. " +
    "Side effects: reads the file (opens it in LSP if not already open).",
    {},
    [],
    async (args, lsp) => {
      const file = String(args.file);
      const line = Number(args.line);
      const column = Number(args.column);

      const location = await lsp.getDefinition(file, line, column);
      if (!location) {
        return `lsp_definition: no definition found for symbol at ${file}:${line}:${column}`;
      }

      return formatLocation("definition", location);
    },
  ));

  /* ─── 2. lsp_references ─────────────────────────────────────── */

  tools.push(makeTool(
    "lsp_references",
    "Find all references (usages) of the symbol at the given position across the project. " +
    "file: path to the file. line: 1-based line number. column: 1-based column. " +
    "Returns a list of reference locations with context snippets. " +
    "Use to understand where a function is called, a variable is used, or a type is referenced. " +
    "Side effects: reads the file (opens it in LSP if not already open).",
    {},
    [],
    async (args, lsp) => {
      const file = String(args.file);
      const line = Number(args.line);
      const column = Number(args.column);

      const references = await lsp.getReferences(file, line, column);
      return formatLocations("references", references);
    },
  ));

  /* ─── 3. lsp_hover ───────────────────────────────────────────── */

  tools.push(makeTool(
    "lsp_hover",
    "Get hover documentation and type signature for the symbol at the given position. " +
    "file: path to the file. line: 1-based line number. column: 1-based column. " +
    "Returns markdown documentation including type signature, JSDoc, and parameter descriptions. " +
    "Use to quickly understand a symbol without reading its full definition. " +
    "Side effects: reads the file (opens it in LSP if not already open).",
    {},
    [],
    async (args, lsp) => {
      const file = String(args.file);
      const line = Number(args.line);
      const column = Number(args.column);

      const hover = await lsp.getHover(file, line, column);
      if (!hover) {
        return `lsp_hover: no hover information at ${file}:${line}:${column}`;
      }

      const snippet = readContextSnippet(file, line);
      return [
        `hover at ${file}:${line}:${column}`,
        "```",
        snippet,
        "```",
        "---",
        hover.contents,
      ].join("\n");
    },
  ));

  /* ─── 4. lsp_completion ──────────────────────────────────────── */

  tools.push(makeTool(
    "lsp_completion",
    "Get code completion suggestions at the given cursor position. " +
    "file: path to the file. line: 1-based line number. column: 1-based column. " +
    "Returns a list of completion items with label, detail, and kind. " +
    "Use to explore available methods, properties, or symbols at a point in the code. " +
    "Side effects: reads the file (opens it in LSP if not already open).",
    {},
    [],
    async (args, lsp) => {
      const file = String(args.file);
      const line = Number(args.line);
      const column = Number(args.column);

      const completions = await lsp.getCompletion(file, line, column);
      if (completions.length === 0) {
        return `lsp_completion: no completions at ${file}:${line}:${column}`;
      }

      const items = completions.map((item, i) => {
        const kind = item.kind ? COMPLETION_KINDS[item.kind] ?? "Unknown" : "Unknown";
        const detail = item.detail ? ` — ${item.detail}` : "";
        const doc = item.documentation ? `\n   doc: ${item.documentation.slice(0, 120)}` : "";
        return `[${i + 1}] ${item.label} (${kind})${detail}${doc}`;
      }).join("\n");

      return `completions at ${file}:${line}:${column} (${completions.length} items):\n\n${items}`;
    },
  ));

  /* ─── 5. lsp_signature_help ──────────────────────────────────── */

  tools.push(makeTool(
    "lsp_signature_help",
    "Get function/method signature information at the given cursor position. " +
    "file: path to the file. line: 1-based line number. column: 1-based column. " +
    "Returns the function signature, parameter list, and which parameter is active. " +
    "Use when the agent needs to understand how to call a function with correct arguments. " +
    "Side effects: reads the file (opens it in LSP if not already open).",
    {},
    [],
    async (args, lsp) => {
      const file = String(args.file);
      const line = Number(args.line);
      const column = Number(args.column);

      const sig = await lsp.getSignatureHelp(file, line, column);
      if (!sig) {
        return `lsp_signature_help: no signature at ${file}:${line}:${column}`;
      }

      const params = sig.parameters.map((p, i) => {
        const active = i === sig.activeParameter ? " ← active" : "";
        const doc = p.documentation ? ` — ${p.documentation.slice(0, 80)}` : "";
        return `  param ${i + 1}: ${p.label}${doc}${active}`;
      }).join("\n");

      const doc = sig.documentation ? `\ndocumentation:\n${sig.documentation}\n` : "";

      return [
        `signature at ${file}:${line}:${column}`,
        "",
        `signature: ${sig.label}`,
        params,
        doc,
      ].join("\n");
    },
  ));

  /* ─── 6. lsp_diagnostic ──────────────────────────────────────── */

  tools.push(makeTool(
    "lsp_diagnostic",
    "Get all diagnostics (errors, warnings, hints) for a file. " +
    "file: path to the file. " +
    "line: ignored (pass 1). " +
    "column: ignored (pass 1). " +
    "Returns a list of all diagnostics ordered by severity. " +
    "Use after editing a file to check for introduced errors before proceeding. " +
    "Side effects: reads the file (opens it in LSP if not already open).",
    {},
    [],
    async (args, lsp) => {
      const file = String(args.file);

      const diagnostics = await lsp.getDiagnostics(file);
      if (diagnostics.length === 0) {
        return `lsp_diagnostic: no diagnostics for ${file} — file is clean`;
      }

      // 按 severity 排序：error → warning → info → hint
      const sorted = [...diagnostics].sort((a, b) => a.severity - b.severity);

      const parts = sorted.map((d, i) => {
        const sev = SEVERITY_NAMES[d.severity] ?? "unknown";
        const codeStr = d.code !== undefined ? ` [${d.code}]` : "";
        const srcStr = d.source ? ` (${d.source})` : "";
        const loc = `${d.range.start.line}:${d.range.start.character}`;
        return `[${i + 1}] ${sev}${codeStr}${srcStr} at ${loc}: ${d.message}`;
      });

      const errorCount = sorted.filter(d => d.severity === 1).length;
      const warnCount = sorted.filter(d => d.severity === 2).length;
      const infoCount = sorted.filter(d => d.severity === 3).length;

      return [
        `diagnostics for ${file}: ${errorCount} errors, ${warnCount} warnings, ${infoCount} info`,
        "",
        ...parts,
      ].join("\n");
    },
  ));

  return tools;
}
