/**
 * src/config/config.ts — 配置模型（第 28 章）
 *
 * AgentConfig 完整定义。每个字段对应一个代码组件，
 * 从配置文件 / 环境变量 / CLI 参数 映射而来。
 */

/* ─── Provider 配置 ──────────────────────────────────────────────── */

/** Provider 类型：Anthropic / OpenAI / 本地模型 / 测试 Mock */
export type ProviderType = "anthropic" | "openai" | "local" | "mock";

/** Provider 连接配置 */
export interface ProviderConfig {
  type: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
}

/* ─── 上下文窗口配置 ─────────────────────────────────────────────── */

/** 上下文窗口配置 */
export type CompressionThreshold = "green" | "yellow" | "red";

/** 上下文管理配置 */
export interface ContextConfig {
  maxTokens: number;
  compressionThreshold: CompressionThreshold;
  autoCompact: boolean;
}

/* ─── 工具配置 ───────────────────────────────────────────────────── */

/** 工具启用配置 */
export interface ToolsConfig {
  enabled: string[];         // "all" 或具体工具名列表
  toolsPerTurn: number;
  pinnedTools: string[];
}

/* ─── 权限配置 ───────────────────────────────────────────────────── */

/** 权限安全配置 */
export interface PermissionsConfig {
  fileWrite: boolean;
  fileDelete: boolean;
  terminal: boolean;
  gitWrite: boolean;
  askOnWrite: boolean;
  pathAllowlist: string[];
}

/* ─── 成本控制配置 ───────────────────────────────────────────────── */

/** 成本控制配置 */
export interface CostConfig {
  enabled: boolean;
  maxTokens: number;
  maxCost: number;          // USD
  alertAt: number;          // 达到多少百分比时告警
}

/* ─── 可观测性配置 ───────────────────────────────────────────────── */

/** 可观测性（OpenTelemetry + 日志）配置 */
export interface ObservabilityConfig {
  enabled: boolean;
  otelEndpoint?: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

/* ─── Agent 总配置 ───────────────────────────────────────────────── */

/**
 * Agent 总配置——汇聚所有子模块配置。
 * 支持从 YAML 配置文件、环境变量、CLI 参数三种来源合并。
 */
export interface AgentConfig {
  // 模型
  model: string;
  temperature: number;
  maxIterations: number;

  // Provider
  provider: ProviderConfig;

  // 上下文
  context: ContextConfig;

  // 工具
  tools: ToolsConfig;

  // 权限
  permissions: PermissionsConfig;

  // 成本
  cost: CostConfig;

  // 可观测性
  observability: ObservabilityConfig;
}

/* ─── 内置默认值 ─────────────────────────────────────────────────── */

export const DEFAULT_CONFIG: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  temperature: 0.7,
  maxIterations: 25,

  provider: {
    type: "mock",
    apiKey: undefined,
    baseUrl: undefined,
    modelName: "claude-sonnet-4-20250514",
  },

  context: {
    maxTokens: 100_000,
    compressionThreshold: "yellow",
    autoCompact: true,
  },

  tools: {
    enabled: ["all"],
    toolsPerTurn: 8,
    pinnedTools: [],
  },

  permissions: {
    fileWrite: true,
    fileDelete: false,
    terminal: true,
    gitWrite: true,
    askOnWrite: true,
    pathAllowlist: [],
  },

  cost: {
    enabled: false,
    maxTokens: 500_000,
    maxCost: 10.0,
    alertAt: 80,
  },

  observability: {
    enabled: false,
    otelEndpoint: undefined,
    logLevel: "info",
  },
};

/* ─── ConfigError ────────────────────────────────────────────────── */

/** ConfigError — 配置校验失败时抛出的异常 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/* ─── 配置验证 ───────────────────────────────────────────────────── */

/**
 * 校验配置是否合法。
 * 检查范围：迭代次数、temperature、token 数、Provider 类型、成本参数、工具数、日志级别。
 * @throws ConfigError — 发现任意错误时抛出，消息中列出所有问题
 */
export function validateConfig(config: AgentConfig): void {
  const errors: string[] = [];

  if (config.maxIterations < 1 || config.maxIterations > 100) {
    errors.push("maxIterations must be 1-100");
  }
  if (config.temperature < 0 || config.temperature > 2) {
    errors.push("temperature must be 0-2");
  }
  if (config.context.maxTokens < 1000) {
    errors.push("context.maxTokens must be ≥ 1000");
  }
  if (!["anthropic", "openai", "local", "mock"].includes(config.provider.type)) {
    errors.push(`unknown provider type: ${config.provider.type}`);
  }
  if (config.cost.enabled && config.cost.maxCost <= 0) {
    errors.push("cost.maxCost must be > 0 when cost control is enabled");
  }
  if (config.cost.enabled && (config.cost.alertAt < 1 || config.cost.alertAt > 100)) {
    errors.push("cost.alertAt must be 1-100");
  }
  if (config.tools.toolsPerTurn < 1 || config.tools.toolsPerTurn > 100) {
    errors.push("tools.toolsPerTurn must be 1-100");
  }
  if (!["debug", "info", "warn", "error"].includes(config.observability.logLevel)) {
    errors.push(`unknown log level: ${config.observability.logLevel}`);
  }

  if (errors.length > 0) {
    throw new ConfigError(errors.join("\n"));
  }
}
