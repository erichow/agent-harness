/**
 * src/config/loader.ts — 配置加载（第 28 章）
 *
 * 多层覆盖加载：
 *   1. 内置默认值 (DEFAULT_CONFIG)
 *   2. 环境变量覆盖
 *   3. 配置文件覆盖 (YAML)
 *   4. CLI 参数覆盖
 *
 * 后覆盖前 —— CLI 参数拥有最高优先级。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type { AgentConfig, ProviderType, CompressionThreshold } from "./config.js";
import { discoverConfigFile } from "./discovery.js";
import { DEFAULT_CONFIG, validateConfig } from "./config.js";

/* ─── 深度合并 ───────────────────────────────────────────────────── */

/**
 * 深度合并两个对象（修改 target）。
 *
 * 与 Object.assign 的差别：
 *   - 嵌套对象递归合并（而非覆盖）
 *   - 数组替换（而非拼接）
 *   - undefined 值跳过（不覆盖 receiver 中的值）
 */
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source as object)) {
    const k = key as keyof T;
    const val = source[k];
    if (val === undefined) continue;

    const existing = result[k];
    if (isPlainObject(existing) && isPlainObject(val)) {
      result[k] = deepMerge(
        existing as Record<string, unknown>,
        val as Record<string, unknown>,
      ) as T[keyof T];
    } else {
      result[k] = val as T[keyof T];
    }
  }
  return result;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/* ─── 环境变量加载 ───────────────────────────────────────────────── */

const ENV_MAP: Record<string, [string[], (v: string) => unknown]> = {
  MODEL: [["model"], (v) => v],
  TEMPERATURE: [["temperature"], (v) => parseFloat(v)],
  MAX_ITERATIONS: [["maxIterations"], (v) => parseInt(v, 10)],
  PROVIDER_TYPE: [["provider", "type"], (v) => v],
  PROVIDER_API_KEY: [["provider", "apiKey"], (v) => v],
  PROVIDER_BASE_URL: [["provider", "baseUrl"], (v) => v],
  PROVIDER_MODEL: [["provider", "modelName"], (v) => v],
  CONTEXT_MAX_TOKENS: [["context", "maxTokens"], (v) => parseInt(v, 10)],
  CONTEXT_COMPRESSION_THRESHOLD: [["context", "compressionThreshold"], (v) => v],
  CONTEXT_AUTO_COMPACT: [["context", "autoCompact"], (v) => v === "true" || v === "1"],
  TOOLS_PER_TURN: [["tools", "toolsPerTurn"], (v) => parseInt(v, 10)],
  PERMISSIONS_FILE_WRITE: [["permissions", "fileWrite"], (v) => v === "true" || v === "1"],
  PERMISSIONS_FILE_DELETE: [["permissions", "fileDelete"], (v) => v === "true" || v === "1"],
  PERMISSIONS_TERMINAL: [["permissions", "terminal"], (v) => v === "true" || v === "1"],
  PERMISSIONS_GIT_WRITE: [["permissions", "gitWrite"], (v) => v === "true" || v === "1"],
  PERMISSIONS_ASK_ON_WRITE: [["permissions", "askOnWrite"], (v) => v === "true" || v === "1"],
  COST_ENABLED: [["cost", "enabled"], (v) => v === "true" || v === "1"],
  COST_MAX_TOKENS: [["cost", "maxTokens"], (v) => parseInt(v, 10)],
  COST_MAX_COST: [["cost", "maxCost"], (v) => parseFloat(v)],
  COST_ALERT_AT: [["cost", "alertAt"], (v) => parseInt(v, 10)],
  OBSERVABILITY_ENABLED: [["observability", "enabled"], (v) => v === "true" || v === "1"],
  OBSERVABILITY_OTEL_ENDPOINT: [["observability", "otelEndpoint"], (v) => v],
  OBSERVABILITY_LOG_LEVEL: [["observability", "logLevel"], (v) => v],
};

/**
 * 从环境变量加载配置覆盖。
 *
 * 环境变量名 = 组件路径的大写下划线连接。
 * 如 CONTEXT_MAX_TOKENS → context.maxTokens
 */
export function loadFromEnv(): Partial<AgentConfig> {
  const overrides: Record<string, unknown> = {};

  for (const [envKey, [pathParts, converter]] of Object.entries(ENV_MAP)) {
    const raw = process.env[envKey];
    if (raw === undefined) continue;

    let current = overrides;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[pathParts[pathParts.length - 1]] = converter(raw);
  }

  return overrides as Partial<AgentConfig>;
}

/* ─── YAML 文件加载 ───────────────────────────────────────────────── */

/**
 * 从 YAML 文件加载配置。
 *
 * @param filePath - YAML 文件路径
 * @returns 部分配置对象
 */
export function loadFromYaml(filePath: string): Partial<AgentConfig> {
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(content) as Record<string, unknown>;

  // "all" 字符串也要支持
  if (parsed.tools && typeof parsed.tools === "object") {
    const tools = parsed.tools as Record<string, unknown>;
    if (tools.enabled === "all") {
      tools.enabled = ["all"];
    }
  }

  return parsed as Partial<AgentConfig>;
}

/* ─── CLI 参数加载 ─────────────────────────────────────────────────- */

export interface CliArgs {
  model?: string;
  temperature?: string;
  maxIterations?: string;
  providerType?: string;
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModelName?: string;
  contextMaxTokens?: string;
  contextAutoCompact?: string;
  toolsEnabled?: string[];
  toolsPerTurn?: string;
  costEnabled?: string;
  costMaxCost?: string;
  config?: string;
  [key: string]: string | string[] | undefined;
}

/**
 * 从 CLI 参数（如 parseArgs / minimist 输出）加载配置覆盖。
 *
 * 支持扁平键名（如 --model, --temperature），
 * 以及用点号分隔的嵌套键（如 --provider.type mock）。
 */
export function loadFromCli(args: Record<string, string | string[] | undefined>): Partial<AgentConfig> {
  const overrides: Record<string, unknown> = {};

  // 扁平键映射：CLI 参数名 → 配置路径
  const CLI_MAP: Record<string, [string[], (v: string) => unknown]> = {
    model: [["model"], (v) => v],
    temperature: [["temperature"], (v) => parseFloat(v)],
    "max-iterations": [["maxIterations"], (v) => parseInt(v, 10)],
    "provider-type": [["provider", "type"], (v) => v],
    "provider-api-key": [["provider", "apiKey"], (v) => v],
    "provider-base-url": [["provider", "baseUrl"], (v) => v],
    "provider-model": [["provider", "modelName"], (v) => v],
    "context-max-tokens": [["context", "maxTokens"], (v) => parseInt(v, 10)],
    "context-auto-compact": [["context", "autoCompact"], (v) => v === "true"],
    "tools-per-turn": [["tools", "toolsPerTurn"], (v) => parseInt(v, 10)],
    "cost-enabled": [["cost", "enabled"], (v) => v === "true"],
    "cost-max-cost": [["cost", "maxCost"], (v) => parseFloat(v)],
  };

  for (const [cliKey, [pathParts, converter]] of Object.entries(CLI_MAP)) {
    const raw = args[cliKey];
    if (raw === undefined || raw === "") continue;
    // 跳过数组值（多值参数）
    if (Array.isArray(raw)) continue;

    let current = overrides;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[pathParts[pathParts.length - 1]] = converter(raw);
  }

  return overrides as Partial<AgentConfig>;
}

/* ─── 配置来源（用于 loadConfig） ────────────────────────────────── */

/**
 * 配置来源。可以是 YAML 文件路径或 Partial<AgentConfig> 覆盖。
 */
export type ConfigSource = string | Partial<AgentConfig>;

/* ─── 主加载函数 ─────────────────────────────────────────────────── */

/**
 * 加载配置（多层覆盖）。
 *
 * 加载顺序（后覆盖前）：
 *   1. 内置默认值 (DEFAULT_CONFIG)
 *   2. 环境变量
 *   3. 配置文件（多个来源，后覆盖前）
 *   4. CLI 参数覆盖
 *
 * @param sources - 额外的配置来源（从后向前覆盖）
 * @returns 最终合并的 AgentConfig
 */
export function loadConfig(sources: ConfigSource[] = []): AgentConfig {
  let config = { ...DEFAULT_CONFIG } as AgentConfig;

  // 2. 环境变量覆盖
  const envOverrides = loadFromEnv();
  if (Object.keys(envOverrides).length > 0) {
    config = deepMerge(config as unknown as Record<string, unknown>, envOverrides as unknown as Record<string, unknown>) as unknown as AgentConfig;
  }

  // 3. 配置文件覆盖（按顺序）
  for (const source of sources) {
    if (typeof source === "string") {
      const fileOverrides = loadFromYaml(source);
      config = deepMerge(config as unknown as Record<string, unknown>, fileOverrides as unknown as Record<string, unknown>) as unknown as AgentConfig;
    } else {
      config = deepMerge(config as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>) as unknown as AgentConfig;
    }
  }

  // 验证
  validateConfig(config);

  return config;
}

/**
 * 简化版 loadConfig：自动发现并加载配置文件，然后合并 env 和 CLI 参数。
 *
 * @param cliArgs - 可选的 CLI 参数
 * @returns 最终配置
 */
export function loadConfigAuto(cliArgs?: CliArgs): AgentConfig {
  // 1. 从默认值开始
  let config = { ...DEFAULT_CONFIG } as AgentConfig;

  // 2. 环境变量
  const envOverrides = loadFromEnv();
  if (Object.keys(envOverrides).length > 0) {
    config = deepMerge(config as unknown as Record<string, unknown>, envOverrides as unknown as Record<string, unknown>) as unknown as AgentConfig;
  }

  // 3. 自动发现配置文件
  const configPath = discoverConfigFile();
  if (configPath) {
    const fileOverrides = loadFromYaml(configPath);
    config = deepMerge(config as unknown as Record<string, unknown>, fileOverrides as unknown as Record<string, unknown>) as unknown as AgentConfig;
  }

  // 4. CLI 参数
  if (cliArgs && Object.keys(cliArgs).length > 0) {
    const cliOverrides = loadFromCli(cliArgs as Record<string, string | string[] | undefined>);
    config = deepMerge(config as unknown as Record<string, unknown>, cliOverrides as unknown as Record<string, unknown>) as unknown as AgentConfig;
  }

  validateConfig(config);
  return config;
}
