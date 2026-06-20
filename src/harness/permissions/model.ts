/**
 * 权限数据模型（第 14 章）
 *
 * 定义权限系统的核心类型：请求、决策、结果。
 */
import type { ToolDefinition } from "../tools/registry.js";

/** 权限决策 */
export type Decision = "allow" | "deny" | "ask";

/**
 * 权限请求——描述一次即将发生的工具调用。
 * 策略函数根据此信息决定是否允许。
 */
export interface PermissionRequest {
  /** 工具名 */
  toolName: string;
  /** 调用参数 */
  args: Record<string, unknown>;
  /** 工具声明的 side effects */
  sideEffects: string[];
}

/**
 * 权限决策结果。
 */
export interface PermissionOutcome {
  /** 决策 */
  decision: Decision;
  /** 决策原因（用于日志和错误消息） */
  reason: string;
  /** 是否缓存到 session 级别（ask→allow 后下次相同调用直接放行） */
  rememberForSession?: boolean;
}

/** 人 in loop 提示函数类型 */
export type HumanPrompt = (req: PermissionRequest) => Promise<Decision>;
