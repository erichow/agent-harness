/**
 * ToolRegistry — 工具注册中心（第 4 章）
 *
 * 解决的问题：
 *   之前 tools（执行函数）和 toolSchemas（传给模型的结构描述）是两个独立对象，
 *   手动保持同步是 bug 的温床。而且参数没有校验。
 *
 * 一个 registry 管三件事：
 *   1. 配对注册 — schema 和 handler 在同一个 register() 里，不会错位
 *   2. 预先校验 — 调用前检查必填字段，缺了就 isError=true
 *   3. 统一暴露 — getSchemas() 给 provider，execute() 给 agent 循环
 */
import { toolResultBlock } from "../messages.js";
import type { ToolResultBlock } from "../messages.js";

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

/* ─── 校验结果 ───────────────────────────────────────────────────── */

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/* ─── Registry ────────────────────────────────────────────────────── */

export class ToolRegistry {
  private definitions: Map<string, ToolDefinition> = new Map();
  private handlers: Map<string, ToolHandler> = new Map();

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
   * 执行一个工具。
   *
   * 与直接调 handler 的区别：
   *   - 自动校验参数（必填字段）
   *   - 异常被 try/catch 捕获，不会崩
   *   - 返回 { result, isError }，直接传给 ToolResultBlock
   */
  execute(
    name: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ): ToolResultBlock {
    // 1. 检查工具是否存在
    if (!this.definitions.has(name)) {
      return toolResultBlock(toolCallId, `unknown tool: ${name}`, true);
    }

    // 2. 参数校验
    const validation = this.validate(name, args);
    if (!validation.valid) {
      return toolResultBlock(toolCallId, validation.error!, true);
    }

    // 3. 执行
    try {
      const result = String(this.handlers.get(name)!(args));
      return toolResultBlock(toolCallId, result);
    } catch (e) {
      return toolResultBlock(toolCallId, (e as Error).message, true);
    }
  }

  /* ─── 内部校验 ─── */

  private validate(name: string, args: Record<string, unknown>): ValidationResult {
    const def = this.definitions.get(name)!;
    const inputSchema = def.inputSchema;

    // 检查必填字段（JSON Schema 的 required 数组）
    const required: string[] = (
      (inputSchema.required as string[]) ?? []
    );
    for (const key of required) {
      if (args[key] === undefined || args[key] === null) {
        return { valid: false, error: `missing required field: ${key}` };
      }
    }

    return { valid: true };
  }
}
