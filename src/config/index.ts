/**
 * src/config/index.ts — 第 28 章：配置系统
 *
 * 导出所有配置相关类型、函数和工厂。
 */

export type {
  AgentConfig,
  ProviderConfig,
  ProviderType,
  ContextConfig,
  CompressionThreshold,
  ToolsConfig,
  PermissionsConfig,
  CostConfig,
  ObservabilityConfig,
} from "./config.js";

export {
  DEFAULT_CONFIG,
  ConfigError,
  validateConfig,
} from "./config.js";

export {
  loadConfig,
  loadConfigAuto,
  loadFromEnv,
  loadFromYaml,
  loadFromCli,
} from "./loader.js";

export type {
  ConfigSource,
  CliArgs,
} from "./loader.js";

export {
  discoverConfigFile,
} from "./discovery.js";

export {
  createAgentFromConfig,
  createProvider,
  registerAllTools,
  createPermissionPolicy,
} from "./factory.js";

export type {
  AgentRuntime,
} from "./factory.js";
