/**
 * ToolRegistry — 工具注册中心
 *
 * 核心职责（第 4 章）：
 *   把工具的「声明（schema）」和「实现（handler）」绑定在一起，
 *   一次注册、统一管理，避免"声明和实现不同步"的问题。
 *
 * 安全增强（第 6 章，插在 execute() 这一个拦截点，无需改工具本身）：
 *   1. JSON Schema 校验 — dispatch 前检查参数 shape，结构化错误回传（Reflexion 效应）
 *   2. 未知工具建议 — difflib.get_close_matches 风格，说出 "Did you mean ...?"
 *   3. 循环检测 — 连续 N 次相同 (工具名 + 参数) 调用 → 注入结构化提示叫模型换策略
 *
 * 权限管控（第 14 章，在 executeAsync 中新增一道闸门）：
 *   - permissionManager.check() 拦截危险操作
 *   - trust label 包装输出结果
 *
 * 设计原则：
 *   - 注册中心是「唯一入口」：所有工具都通过这里注册和执行
 *   - 错误不抛异常，而是返回 ToolResultBlock + isError=true
 *     让模型（而非代码）决定怎么处理错误（Reflexion 模式）
 */
import { toolResultBlock } from "../messages.js";
import type { ToolResultBlock } from "../messages.js";
import { validate } from "./validation.js";
import type { ValidationError } from "./validation.js";

/* ─── 工具定义 ───────────────────────────────────────────────────── */

/**
 * 一个工具的完整声明。
 * name 和 inputSchema 就是原来 toolSchemas 数组里的一项。
 *
 * 这三个字段（name, description, inputSchema）直接对应
 * OpenAI / Anthropic 等 provider 需要的 tool schema 格式，
 * 注册时填一次就够了，不需要在多个文件里分别维护。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * 同步工具执行函数。
 * 入参是调用方传来的实际参数，出参统一返回字符串。
 * 如果工具要返回复杂结构，由工具自己 JSON.stringify。
 */
export type ToolHandler = (args: Record<string, unknown>) => string;

/**
 * 异步工具执行函数。
 * 适用于需要 await 的操作（如文件读写、网络请求）。
 * 通过 aregister() 注册，在 executeAsync() 中被调用。
 */
export type AsyncToolHandler = (args: Record<string, unknown>) => Promise<string>;

/* ─── 常量 ───────────────────────────────────────────────────────── */

/** 连续相同调用多少次触发循环检测 */
const MAX_REPEAT_CALLS = 3;

/* ─── Registry ────────────────────────────────────────────────────── */

export class ToolRegistry {
  /** 工具定义（schema）仓库：name → ToolDefinition */
  private definitions: Map<string, ToolDefinition> = new Map();
  /** 同步工具 handler 仓库：name → ToolHandler */
  private handlers: Map<string, ToolHandler> = new Map();
  /** 异步工具 handler 仓库：name → AsyncToolHandler */
  private asyncHandlers: Map<string, AsyncToolHandler> = new Map();
  /**
   * 可选的权限管理器（第 14 章）。
   * 如果设置了，executeAsync 在执行前会先询问权限。
   */
  permissionManager?: import("../permissions/manager.js").PermissionManager;

  /**
   * 调用历史，格式为 `${toolName}|${JSON.stringify(sorted args)}`。
   * 仅用于循环检测，保留最近 100 条。
   */
  private callHistory: string[] = [];

  /**
   * 注册一个同步工具（第 4 章核心方法）。
   *
   * 一次调用同时绑定声明（schema）和实现（handler），
   * 不会再出现「声明改了但实现没改」的错位问题。
   *
   * 重复注册同名工具会抛异常，防止无意覆盖。
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
   * 与 register() 的唯一区别是 handler 返回 Promise<string>。
   * 同步执行（execute）不会调用异步 handler；异步执行（executeAsync）会优先用 async handler，
   * 若没有注册 async handler 则回退到 sync handler（兼容混用）。
   */
  aregister(def: ToolDefinition, handler: AsyncToolHandler): void {
    if (this.definitions.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.definitions.set(def.name, def);
    this.asyncHandlers.set(def.name, handler);
  }

  /**
   * 根据工具名获取其定义（ToolDefinition）。
   * 主要用于「工具选择器」（第 12 章）在注册中心外读取工具的 schema 信息。
   * @returns ToolDefinition | undefined — 未注册返回 undefined
   */
  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /** 检查指定名称的工具是否已注册 */
  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /**
   * 获取所有工具的工具定义列表，转换成 provider 需要的格式。
   * 每个条目包含 name、description、input_schema（注意下划线命名，
   * 因为 Anthropic/OpenAI API 都用 input_schema 这个字段名）。
   * 最终发给模型，让模型知道有哪些工具可用。
   */
  getSchemas(): Record<string, unknown>[] {
    return Array.from(this.definitions.values()).map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.inputSchema,
    }));
  }

  /** 列出所有已注册的工具名称（用于调试、模糊匹配建议等） */
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
      // 如果工具的操作有潜在副作用（network / mutate），且输出内容
      // 可能不可信（比如来自远端），就给输出打上 "UNTRUSTED" 标签，
      // 提醒用户和下游工具谨慎对待。
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
   * 当模型调用了不存在的工具时，返回友好的错误消息。
   *
   * 做了两件事：
   * 1. 用模糊匹配（Levenshtein 距离）猜一个最接近的已注册工具名
   * 2. 返回格式如 "unknown tool: cal. Did you mean 'calc'? Available: [...]"
   *
   * 这叫 Reflexion 效应——不是简单抛异常，而是给模型可操作的建议，
   * 让模型有机会自己修正（换一个正确的工具名重试）。
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
   * 用 LCS（最长公共子序列）比值找最接近的工具名。
   * 效果类似 Python difflib.get_close_matches。
   *
   * 相似度阈值 0.5（归一化距离 >= 0.5 才算接近）：
   *  - 'calculator' vs 'calc' → ~0.571，通过
   *  - 'calculator' vs 'read_file' → 很低，不通过
   *
   * cutoff 设太低会推荐无关工具，把模型带歪。
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
   * 计算两个字符串的 LCS（最长公共子序列）比值相似度。
   * 公式：ratio = 2 * LCS长度 / (a.length + b.length)
   *
   * 结果范围 0~1：
   *  - 1 = 完全相同
   *  - 0 = 完全无关
   *  - 0.5 = 一半字符匹配
   *
   * 用 LCS 而不是 Levenshtein 编辑距离，是因为 LCS 更接近
   * Python difflib.SequenceMatcher.ratio() 的行为。
   */
  private _similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    const lcsLen = this._lcsLength(a, b);
    return (2 * lcsLen) / (a.length + b.length);
  }

  /**
   * 标准的 LCS（最长公共子序列）动态规划实现。
   * dp[i][j] = a[0..i) 和 b[0..j) 的 LCS 长度。
   * 空间复杂度 O(m×n)，对工具名这种短字符串完全够用。
   */
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
   * 从工具名推断该工具的 side effects（副作用类型）。
   *
   * 用于两个地方：
   *   - 权限管理器（第 14 章）：判断该操作是否需要用户批准
   *   - trust label（第 14 章）：对不可信输出做标记
   *
   * 理想情况下每个工具注册时应显式声明 side effects，但为现有
   * 工具提供合理默认值。通过工具名前缀/名称匹配：
   *
   *   前缀/名称            → side effects
   *   mcp__xxx             → network + mutate（远程调用，有写操作风险）
   *   read_file / lsp_*   → read（纯读取）
   *   edit_lines / git_*  → write / mutate（修改操作）
   *   run_command         → mutate（执行命令，可能产生副作用）
   *
   * 如果推断不出，返回空数组（保守安全策略会让权限管理器弹窗询问）。
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
   * 记录一次工具调用到历史队列。
   * 用于后续的循环检测——如果模型连续 N 次用完全相同的参数
   * 调用同一个工具，说明它可能在原地打转。
   *
   * key 的格式：`${name}|${JSON.stringify(sorted args)}`
   * 参数排序确保 {a:1, b:2} 和 {b:2, a:1} 被视为相同调用。
   *
   * 历史队列最多保留最近 100 条，防止内存泄漏。
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
   * 逻辑：取最近 MAX_REPEAT_CALLS（3）次调用记录，如果和当前
   * 调用完全一致（同名 + 同参数）的次数 >= 3，则判定为循环。
   *
   * 为什么用精确匹配而不是模糊匹配？
   *   模糊匹配会把"真正的前进"误判为"循环"——比如模型连续调
   *   用 edit_file 修不同行，参数不同但函数名相同，这是正常工作。
   *   误报（false positive）比漏报更糟，因为它会打断正确的行为。
   *
   * 触发后的处理方式：
   *   不是硬中断（抛异常），而是用 toolResultBlock 返回一条错误
   *   消息告诉模型"你在打转"，让模型自己换策略。这叫 Reflexion
   *   模式——让模型从反馈中学习修正。
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
 *
 * 使用示例：
 *   json_query({ data: '{"items":[{"name":"foo"}]}', path: 'items.0.name' })
 *   → '"foo"'
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
 * json_query 的执行函数。
 *
 * 步骤：
 * 1. 从 args 中提取 data（JSON 字符串）和 path（dot-path）
 * 2. JSON.parse 解析 data——如果报错返回友好提示
 * 3. 按 . 分割 path，逐级向下遍历对象/数组
 * 4. 返回 JSON.stringify 后的查询结果
 *
 * 注意：
 *  - ajv（校验器）只检查 data 是字符串类型，JSON.parse 的失败由工具自己处理
 *  - 这是纯读取操作，无副作用
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