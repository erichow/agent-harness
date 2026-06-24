/**
 * ToolRegistry — 工具注册中心（第 6 章：安全工具执行）
 *
 * 第 6 章新增三大安全机制：
 *   1. JSON Schema 校验 — dispatch 前检查参数 shape，结构化错误回传（Reflexion 效应）
 *   2. 未知工具建议 — difflib.get_close_matches 风格，说出 "Did you mean ...?"
 *   3. 循环检测 — 连续 N 次相同 (工具名 + 参数) 调用 → 注入结构化提示叫模型换策略
 *
 * 三个机制都插在 execute() 这一个拦截点，无需改工具本身。
 */
import { toolResultBlock } from "../messages.js";
import type { ToolResultBlock } from "../messages.js";
import { validate } from "./validation.js";
import type { ValidationError } from "./validation.js";

/* ─── 工具定义 ───────────────────────────────────────────────────── */

/**
 * 一个工具的完整声明。
 * name 和 inputSchema 就是原来 toolSchemas 数组里的一项。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 工具执行函数 */
export type ToolHandler = (args: Record<string, unknown>) => string;

/** 异步工具执行函数 */
export type AsyncToolHandler = (args: Record<string, unknown>) => Promise<string>;

/* ─── 常量 ───────────────────────────────────────────────────────── */

/** 连续相同调用多少次触发循环检测 */
const MAX_REPEAT_CALLS = 3;

/* ─── Registry ────────────────────────────────────────────────────── */

export class ToolRegistry {
  private definitions: Map<string, ToolDefinition> = new Map();
  private handlers: Map<string, ToolHandler> = new Map();
  private asyncHandlers: Map<string, AsyncToolHandler> = new Map();
  /** 可选的权限管理器（第 14 章） */
  permissionManager?: import("../permissions/manager.js").PermissionManager;

  /**
   * 调用历史，格式为 `${toolName}|${JSON.stringify(sorted args)}`。
   * 仅用于循环检测，保留最近 100 条。
   */
  private callHistory: string[] = [];

  /**
   * 注册一个工具。
   *
   * ```ts
   * registry.register({
   *   name: "calc",
   *   description: "Evaluate an arithmetic expression",
   *   inputSchema: {
   *     type: "object",
   *     properties: { expression: { type: "string" } },
   *     required: ["expression"],
   *   },
   * }, (args) => String(eval(String(args.expression))));
   * ```
   */
  register(def: ToolDefinition, handler: ToolHandler): void {
    if (this.definitions.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.definitions.set(def.name, def);
    this.handlers.set(def.name, handler);
  }

  /**
   * 注册一个异步工具。
   * async handler 在 executeAsync() 中被调用。
   */
  aregister(def: ToolDefinition, handler: AsyncToolHandler): void {
    if (this.definitions.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.definitions.set(def.name, def);
    this.asyncHandlers.set(def.name, handler);
  }

  /** 获取工具定义 */
  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /** 是否已注册 */
  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /** 获取所有工具 schema（给 provider 用） */
  getSchemas(): Record<string, unknown>[] {
    return Array.from(this.definitions.values()).map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.inputSchema,
    }));
  }

  /** 列出所有已注册工具名 */
  list(): string[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * 执行一个工具（第 6 章升级版）。
   *
   * 4 道闸门：
   *   1. name 存在?            → 否 → _unknownTool（含 Did you mean?）
   *   2. args ⊃ schema?        → 否 → _validationFailure（结构化错误回传）
   *   3. 去重器?                → 是 → _loopDetected（连续 N 次相同调用）
   *   4. execute               → 异常 → error result（try/catch 兜底）
   */
  execute(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ): ToolResultBlock {
    // 闸门 1：工具是否存在
    if (!this.definitions.has(name)) {
      return this._unknownTool(name, toolCallId);
    }

    const tool = this.definitions.get(name)!;

    // 闸门 2：JSON Schema 校验
    const errors = validate(args, tool.inputSchema);
    if (errors.length > 0) {
      return this._validationFailure(name, errors, toolCallId);
    }

    // 闸门 3：循环检测
    this._recordCall(name, args);
    const loopResult = this._checkLoop(name, args, toolCallId);
    if (loopResult !== null) {
      return loopResult;
    }

    // 闸门 4：执行
    try {
      const result = String(this.handlers.get(name)!(args));
      return toolResultBlock(toolCallId, result);
    } catch (e) {
      return toolResultBlock(
        toolCallId,
        `${name} raised ${(e as Error).constructor.name}: ${(e as Error).message}`,
        true,
      );
    }
  }

  /**
   * 异步执行一个工具。
   *
   * 5 道闸门（第 14 章新增权限闸）：
   *   1. name 存在?            → 否 → _unknownTool
   *   2. args ⊃ schema?        → 否 → _validationFailure
   *   3. permission 通过?       → 否 → permission denied
   *   4. 去重器?                → 是 → _loopDetected
   *   5. execute               → 异常 → error result（含 trust label）
   */
  async executeAsync(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ): Promise<ToolResultBlock> {
    // 闸门 1：工具是否存在
    if (!this.definitions.has(name)) {
      return this._unknownTool(name, toolCallId);
    }

    const tool = this.definitions.get(name)!;

    // 闸门 2：JSON Schema 校验
    const errors = validate(args, tool.inputSchema);
    if (errors.length > 0) {
      return this._validationFailure(name, errors, toolCallId);
    }

    // 闸门 2.5：权限检查（第 14 章）
    if (this.permissionManager) {
      const sideEffects = this._inferSideEffects(name);
      const outcome = await this.permissionManager.check(name, args, sideEffects);
      if (outcome.decision === "deny") {
        return toolResultBlock(
          toolCallId,
          `${name}: permission denied — ${outcome.reason}`,
          true,
        );
      }
      // ask 已由 manager 内部升级为 allow/deny
    }

    // 闸门 3：循环检测
    this._recordCall(name, args);
    const loopResult = this._checkLoop(name, args, toolCallId);
    if (loopResult !== null) {
      return loopResult;
    }

    // 闸门 4：执行（async handler 优先）
    try {
      const asyncHandler = this.asyncHandlers.get(name);
      let content: string;
      if (asyncHandler) {
        content = String(await asyncHandler(args));
      } else {
        // 回退到 sync handler
        content = String(this.handlers.get(name)!(args));
      }

      // Trust label 包装（第 14 章）
      const sideEffects = this._inferSideEffects(name);
      const { wrapIfUntrusted } = await import("../permissions/trust.js");
      content = wrapIfUntrusted(name, sideEffects, content);

      return toolResultBlock(toolCallId, content);
    } catch (e) {
      return toolResultBlock(
        toolCallId,
        `${name} raised ${(e as Error).constructor.name}: ${(e as Error).message}`,
        true,
      );
    }
  }

  /* ─── 内部：未知工具建议 ────────────────────────────────────── */

  /**
   * 未知工具时返回带 "Did you mean ...?" 建议的错误消息。
   *
   * 用 Levenshtein 距离找最接近的已注册工具名。
   * cutoff = 0.5 会拒绝完全不相关的名字。
   */
  private _unknownTool(name: string, callId: string): ToolResultBlock {
    const suggestion = this._fuzzyFindClosest(name);
    const suggestionText = suggestion
      ? ` Did you mean '${suggestion}'?`
      : "";
    return toolResultBlock(
      callId,
      `unknown tool: ${name}.${suggestionText} Available: ${JSON.stringify(this.list())}`,
      true,
    );
  }

  /**
   * 用 Levenshtein 距离找最接近的工具名。
   * cutoff = 0.5（归一化距离 >= 0.5 才算接近）。
   */
  private _fuzzyFindClosest(name: string): string | undefined {
    const names = this.list();
    if (names.length === 0) return undefined;

    let best: string | undefined;
    let bestScore = 0;
    for (const candidate of names) {
      const score = this._similarity(name, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return bestScore >= 0.5 ? best : undefined;
  }

  /**
   * 最长公共子序列（LCS）比值的相似度。
   * 匹配 Python difflib.SequenceMatcher.ratio() 的行为。
   * ratio = 2 * LCS.length / (a.length + b.length)
   * 1 = 完全相同，0 = 完全无关。
   *
   * 对 'calculator' vs 'calc' 产生 ~0.571，通过 0.5 cutoff。
   */
  private _similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const lcsLen = this._lcsLength(a, b);
    return (2 * lcsLen) / (a.length + b.length);
  }

  /** LCS 长度（动态规划） */
  private _lcsLength(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[m][n];
  }

  /* ─── 内部：校验失败 ────────────────────────────────────────── */

  /**
   * 校验失败时返回结构化错误消息。
   *
   * 多个错误合并为一条消息——模型从"一条列出三件事"学得比
   * "连续 3 个回合各修一个"快得多。
   */
  private _validationFailure(
    name: string,
    errors: ValidationError[],
    callId: string,
  ): ToolResultBlock {
    const summary = errors.map((e) => e.toString()).join("; ");
    return toolResultBlock(
      callId,
      `${name}: invalid arguments. ${summary}`,
      true,
    );
  }

  /* ─── 内部：推断 side effects ────────────────────────────────── */

  /**
   * 从工具名/描述推断 side effects。
   *
   * 理想情况下每个工具注册时显式声明 side effects；为现有工具
   * 提供合理默认。MCP 工具名含 `mcp__` 前缀默认 network + mutate；
   * 文件工具默认 filesystem。
   */
  private _inferSideEffects(name: string): string[] {
    if (name.startsWith("mcp__")) {
      return ["network", "mutate"];
    }
    if (name.startsWith("read_file") || name === "scratchpad_list" || name === "scratchpad_read") {
      return ["read"];
    }
    if (name === "edit_lines" || name === "scratchpad_write") {
      return ["write"];
    }
    if (name === "search_docs") {
      return ["read"];
    }
    // 第 23 章：git 工具
    if (name.startsWith("git_status") || name.startsWith("git_diff") || name.startsWith("git_log")) {
      return ["read"];
    }
    if (name.startsWith("git_")) {
      return ["write"];
    }
    // 第 24 章：终端工具
    if (name === "which_command" || name === "get_job_output") {
      return ["read"];
    }
    if (name.startsWith("run_command") || name === "stop_job") {
      return ["mutate"];
    }
    // 第 25 章：LSP 工具（全部只读）
    if (name.startsWith("lsp_")) {
      return ["read"];
    }
    return [];
  }

  /* ─── 内部：循环检测 ────────────────────────────────────────── */

  /**
   * 记录一次工具调用到历史。
   * key = `${name}|${JSON.stringify(sorted args)}`
   */
  private _recordCall(name: string, args: Record<string, unknown>): void {
    const key = `${name}|${JSON.stringify(args, Object.keys(args).sort())}`;
    this.callHistory.push(key);
    if (this.callHistory.length > 100) {
      this.callHistory = this.callHistory.slice(-100);
    }
  }

  /**
   * 检查是否检测到工具调用循环。
   *
   * 使用精确匹配——模糊匹配会把"真正的前进"误判为"循环"，
   * 误报比漏报更糟。
   *
   * @returns ToolResultBlock 如果检测到循环，null 否则。
   */
  private _checkLoop(
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): ToolResultBlock | null {
    if (this.callHistory.length < MAX_REPEAT_CALLS) return null;

    const key = `${name}|${JSON.stringify(args, Object.keys(args).sort())}`;
    const recent = this.callHistory.slice(-MAX_REPEAT_CALLS);
    const repeats = recent.filter((k) => k === key).length;

    if (repeats >= MAX_REPEAT_CALLS) {
      return toolResultBlock(
        callId,
        `tool-call loop detected: ${name} called with identical arguments ${MAX_REPEAT_CALLS} times in a row. Try a different approach or different arguments, or stop and return your current best answer.`,
        true,
      );
    }
    return null;
  }
}

/* ─── json_query 工具 ────────────────────────────────────────────── */

/**
 * json_query: 用简单 dot-path 表达式查询 JSON 数据。
 *
 * 第 6 章新增的示例工具，用于压力测试 registry 的校验能力
 * ——schema 有两个必填字符串、形状具体，失败模式（JSON 无效、
 * 路径不存在）validator 和工具会各分一份。
 */
export const jsonQueryDefinition: ToolDefinition = {
  name: "json_query",
  description:
    "Query JSON data with a simple dot-path expression. e.g. 'items.0.name' or 'user.email'",
  inputSchema: {
    type: "object",
    properties: {
      data: {
        type: "string",
        description: "A JSON string (object or array).",
      },
      path: {
        type: "string",
        description:
          "A dot-separated path; e.g. 'items.0.name' or 'user.email'. Array indices are integers.",
      },
    },
    required: ["data", "path"],
  },
};

/**
 * json_query 执行函数。
 *
 * 副作用：无（纯读取）。
 * ajv 只检查 data 是字符串类型，JSON.parse 失败在工具内处理。
 */
export function jsonQueryHandler(
  args: Record<string, unknown>,
): string {
  const data = String(args.data);
  const path = String(args.path);

  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return `json_query: invalid JSON in 'data'`;
  }

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (isNaN(idx) || idx < 0 || idx >= current.length) {
        return `json_query: path not found: index ${part} out of range`;
      }
      current = current[idx];
    } else if (typeof current === "object" && current !== null) {
      const record = current as Record<string, unknown>;
      if (!(part in record)) {
        return `json_query: path not found: key '${part}' does not exist`;
      }
      current = record[part];
    } else {
      return `json_query: cannot index ${typeof current} with '${part}'`;
    }
  }

  return JSON.stringify(current);
}