/**
 * src/config/factory.ts — 从配置创建组件（第 28 章）
 *
 * createAgentFromConfig() 是整个 harness 的最终入口——
 * 给一个配置文件，得到一个跑起来的 agent runtime。
 */
import type { AgentConfig, ProviderConfig, PermissionsConfig, ToolsConfig, CostConfig, ObservabilityConfig } from "./config.js";
import { ToolRegistry } from "../harness/tools/registry.js";
import type { ToolDefinition, ToolHandler, AsyncToolHandler } from "../harness/tools/registry.js";
import { ToolCatalog } from "../harness/tools/selector.js";
import type { CatalogEntry } from "../harness/tools/selector.js";
import { PermissionManager } from "../harness/permissions/manager.js";
import { compose, bySideEffect, pathAllowlist } from "../harness/permissions/policy.js";
import type { Policy } from "../harness/permissions/policy.js";
import type { Decision, PermissionRequest } from "../harness/permissions/model.js";
import { ContextAccountant, ContextBudget } from "../harness/context/accountant.js";
import { Compactor } from "../harness/context/compactor.js";
import { BudgetEnforcer } from "../harness/cost/enforcer.js";
import { MockProvider } from "../harness/providers/mock.js";
import type { Provider } from "../harness/providers/base.js";

/* ─── AgentRuntime ───────────────────────────────────────────────── */

/**
 * AgentRuntime — 从配置创建的所有运行时组件。
 *
 * 这是 createAgentFromConfig 的返回类型。
 * 从外部看，它暴露了 agent 循环需要的一切东西。
 */
export interface AgentRuntime {
  provider: Provider;
  registry: ToolRegistry;
  catalog: ToolCatalog;
  permissionManager: PermissionManager;
  accountant: ContextAccountant;
  compactor: Compactor;
  enforcer?: BudgetEnforcer;
  config: AgentConfig;
}

/* ─── Provider 工厂 ──────────────────────────────────────────────── */

/**
 * 从配置创建 Provider。
 *
 * 当前实现支持：
 *   - "mock": MockProvider（开发/测试）
 *   - 其他类型: 回退到 MockProvider
 *
 * 生产环境下，在此添加 Anthropic / OpenAI / DeepSeek 等 Provider。
 */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "mock":
      return new MockProvider([]);
    default:
      // 生产环境在此扩展：new AnthropicProvider(config) 等
      console.warn(`[config] unknown provider type "${config.type}", falling back to MockProvider`);
      return new MockProvider([]);
  }
}

/* ─── 工具注册 ───────────────────────────────────────────────────── */

/**
 * 注册所有工具到 registry。
 *
 * 支持 "all" 启用全部，或按列表启用特定工具。
 * pinnedTools 作为 catalog 的 mustInclude 参数。
 */
export function registerAllTools(
  registry: ToolRegistry,
  config: ToolsConfig,
): void {
  const isAll = config.enabled.length === 1 && config.enabled[0] === "all";

  // 基础工具总是注册
  _registerIfNeeded(registry, "json_query", {
    name: "json_query",
    description: "Query JSON data with a simple dot-path expression",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string", description: "A JSON string" },
        path: { type: "string", description: "A dot-separated path" },
      },
      required: ["data", "path"],
    },
  }, (args) => {
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
  });

  // 如果配置了特定工具列表，只注册这些
  if (!isAll) {
    for (const toolName of config.enabled) {
      if (!registry.has(toolName)) {
        console.warn(`[config] requested tool "${toolName}" not found in built-in tools`);
      }
    }
  }
}

function _registerIfNeeded(
  registry: ToolRegistry,
  name: string,
  def: ToolDefinition,
  handler: ToolHandler,
): void {
  if (!registry.has(name)) {
    registry.register(def, handler);
  }
}

/* ─── 权限策略工厂 ────────────────────────────────────────────── */

/**
 * 从 PermissionsConfig 创建权限策略。
 */
export function createPermissionPolicy(config: PermissionsConfig): Policy {
  const policies: Policy[] = [];

  // 文件系统路径白名单
  if (config.pathAllowlist.length > 0) {
    policies.push(pathAllowlist(config.pathAllowlist));
  }

  // side effect 策略
  const read: Decision = "allow";
  const write: Decision = config.askOnWrite ? "ask" : "allow";
  const network: Decision = "ask";
  const mutate: Decision = config.terminal ? "ask" : "deny";

  policies.push(bySideEffect(read, write, network, mutate));

  // 文件删除
  if (!config.fileDelete) {
    policies.push((req: PermissionRequest) => ({
      decision: (req.toolName === "delete_file" || req.toolName === "delete_directory")
        ? ("deny" as Decision)
        : ("allow" as Decision),
      reason: req.toolName.startsWith("delete")
        ? "file deletion disabled by config"
        : "not a delete tool",
    }));
  }

  return compose(...policies);
}

/* ─── 主工厂函数 ─────────────────────────────────────────────────── */

/**
 * 从 AgentConfig 创建完整的 AgentRuntime。
 *
 * 这是第 28 章的核心产出——统一配置入口。
 *
 * @param config - 完整配置
 * @returns AgentRuntime（所有运行时组件）
 */
export async function createAgentFromConfig(
  config: AgentConfig,
): Promise<AgentRuntime> {
  // 1. Provider
  const provider = createProvider(config.provider);

  // 2. Tool registry + catalog
  const registry = new ToolRegistry();
  registerAllTools(registry, config.tools);
  const catalog = ToolCatalog.fromRegistry(registry);

  // 3. Permissions
  const permissionManager = new PermissionManager(
    createPermissionPolicy(config.permissions),
  );

  // 4. Context management
  const budget = new ContextBudget(
    config.context.maxTokens,
    4096, // headroom
  );
  const accountant = new ContextAccountant(budget);
  const compactor = new Compactor(accountant, provider);

  // 5. Cost control
  const enforcer = config.cost.enabled
    ? new BudgetEnforcer(config.cost.maxCost)
    : undefined;

  // 6. Observability
  if (config.observability.enabled) {
    const { setupTracing } = await import("../harness/observability/tracing.js");
    setupTracing(
      "agent-harness",
      config.observability.otelEndpoint,
    );
  }

  return {
    provider,
    registry,
    catalog,
    permissionManager,
    accountant,
    compactor,
    enforcer,
    config,
  };
}
