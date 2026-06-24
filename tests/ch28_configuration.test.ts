/**
 * 第 28 章测试 — 配置系统
 *
 * 覆盖：
 *   1. 配置类型和默认值
 *   2. 配置验证（正常、边界、错误）
 *   3. 深度合并
 *   4. 环境变量加载
 *   5. YAML 文件加载
 *   6. CLI 参数加载
 *   7. 多层覆盖（优先级）
 *   8. loadConfig 路径
 *   9. 配置文件发现
 *   10. createAgentFromConfig 工厂
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// ── 配置系统导入 ───────────────────────────────────────────────────

import {
  DEFAULT_CONFIG,
  ConfigError,
  validateConfig,
  loadConfig,
  loadFromEnv,
  loadFromYaml,
  loadFromCli,
  discoverConfigFile,
  createAgentFromConfig,
  createProvider,
  registerAllTools,
  createPermissionPolicy,
} from "../src/config/index.js";

import type { AgentConfig } from "../src/config/index.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ContextAccountant, ContextBudget } from "../src/harness/context/accountant.js";

// ── 辅助 ──────────────────────────────────────────────────────────

/** 创建完整配置的辅助函数 */
function fullConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

describe("第28章 · 配置系统", () => {
  /* ── 1. 默认值 ──────────────────────────────────────────────── */

  describe("默认值", () => {
    it("应该提供完整的默认配置", () => {
      expect(DEFAULT_CONFIG).toBeDefined();
      expect(DEFAULT_CONFIG.model).toBe("claude-sonnet-4-20250514");
      expect(DEFAULT_CONFIG.temperature).toBe(0.7);
      expect(DEFAULT_CONFIG.maxIterations).toBe(25);
      expect(DEFAULT_CONFIG.provider.type).toBe("mock");
      expect(DEFAULT_CONFIG.context.maxTokens).toBe(100_000);
      expect(DEFAULT_CONFIG.tools.enabled).toEqual(["all"]);
      expect(DEFAULT_CONFIG.tools.toolsPerTurn).toBe(8);
      expect(DEFAULT_CONFIG.permissions.fileWrite).toBe(true);
      expect(DEFAULT_CONFIG.cost.enabled).toBe(false);
      expect(DEFAULT_CONFIG.observability.enabled).toBe(false);
    });
  });

  /* ── 2. 验证 ────────────────────────────────────────────────── */

  describe("配置验证", () => {
    it("应该通过有效配置", () => {
      expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
    });

    it("maxIterations 超出范围应报错", () => {
      expect(() => validateConfig(fullConfig({ maxIterations: 0 })))
        .toThrow(ConfigError);
      expect(() => validateConfig(fullConfig({ maxIterations: 101 })))
        .toThrow(ConfigError);
      expect(() => validateConfig(fullConfig({ maxIterations: 1 })))
        .not.toThrow();
      expect(() => validateConfig(fullConfig({ maxIterations: 100 })))
        .not.toThrow();
    });

    it("temperature 超出范围应报错", () => {
      expect(() => validateConfig(fullConfig({ temperature: -0.1 })))
        .toThrow(ConfigError);
      expect(() => validateConfig(fullConfig({ temperature: 2.1 })))
        .toThrow(ConfigError);
      expect(() => validateConfig(fullConfig({ temperature: 0 })))
        .not.toThrow();
      expect(() => validateConfig(fullConfig({ temperature: 2 })))
        .not.toThrow();
    });

    it("context.maxTokens < 1000 应报错", () => {
      expect(() => validateConfig(fullConfig({
        context: { ...DEFAULT_CONFIG.context, maxTokens: 999 },
      }))).toThrow(ConfigError);
    });

    it("未知 provider type 应报错", () => {
      expect(() => validateConfig(fullConfig({
        provider: { ...DEFAULT_CONFIG.provider, type: "unknown" as any },
      }))).toThrow(ConfigError);
    });

    it("cost.enabled 但 maxCost ≤ 0 应报错", () => {
      expect(() => validateConfig(fullConfig({
        cost: { ...DEFAULT_CONFIG.cost, enabled: true, maxCost: 0 },
      }))).toThrow(ConfigError);
    });

    it("cost.alertAt 超出 1-100 范围应报错", () => {
      expect(() => validateConfig(fullConfig({
        cost: { ...DEFAULT_CONFIG.cost, enabled: true, alertAt: 0 },
      }))).toThrow(ConfigError);
      expect(() => validateConfig(fullConfig({
        cost: { ...DEFAULT_CONFIG.cost, enabled: true, alertAt: 101 },
      }))).toThrow(ConfigError);
    });

    it("toolsPerTurn 超出范围应报错", () => {
      expect(() => validateConfig(fullConfig({
        tools: { ...DEFAULT_CONFIG.tools, toolsPerTurn: 0 },
      }))).toThrow(ConfigError);
    });

    it("未知 logLevel 应报错", () => {
      expect(() => validateConfig(fullConfig({
        observability: { ...DEFAULT_CONFIG.observability, logLevel: "trace" as any },
      }))).toThrow(ConfigError);
    });
  });

  /* ── 3. 环境变量加载 ────────────────────────────────────────── */

  describe("环境变量加载", () => {
    const OLD_ENV = { ...process.env };

    beforeEach(() => {
      // 清理测试相关的环境变量
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MODEL") || key.startsWith("TEMPERATURE") ||
            key.startsWith("MAX_ITERATIONS") || key.startsWith("PROVIDER_") ||
            key.startsWith("CONTEXT_") || key.startsWith("TOOLS_") ||
            key.startsWith("PERMISSIONS_") || key.startsWith("COST_") ||
            key.startsWith("OBSERVABILITY_") || key === "AGENT_HARNESS_CONFIG") {
          delete process.env[key];
        }
      }
    });

    afterEach(() => {
      process.env = { ...OLD_ENV };
    });

    it("应该加载字符串值（MODEL）", () => {
      process.env["MODEL"] = "gpt-4o";
      const result = loadFromEnv();
      expect(result.model).toBe("gpt-4o");
    });

    it("应该加载数字值（TEMPERATURE）", () => {
      process.env["TEMPERATURE"] = "0.5";
      const result = loadFromEnv();
      expect(result.temperature).toBe(0.5);
    });

    it("应该加载布尔值（CONTEXT_AUTO_COMPACT）", () => {
      process.env["CONTEXT_AUTO_COMPACT"] = "false";
      const result = loadFromEnv();
      expect(result.context?.autoCompact).toBe(false);
    });

    it("应该加载嵌套配置（PROVIDER_TYPE + PROVIDER_API_KEY）", () => {
      process.env["PROVIDER_TYPE"] = "openai";
      process.env["PROVIDER_API_KEY"] = "sk-test";
      const result = loadFromEnv();
      expect(result.provider?.type).toBe("openai");
      expect(result.provider?.apiKey).toBe("sk-test");
    });

    it("未设置环境变量时不产生覆盖", () => {
      const result = loadFromEnv();
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  /* ── 4. YAML 文件加载 ──────────────────────────────────────── */

  describe("YAML 文件加载", () => {
    const TEST_DIR = path.join(projectRoot, "tests", "__ch28_test_files");

    beforeEach(() => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it("应该加载简单 YAML 配置", () => {
      const yamlPath = path.join(TEST_DIR, "simple.yaml");
      fs.writeFileSync(yamlPath, [
        "model: claude-opus-4-6",
        "temperature: 0.3",
        "maxIterations: 40",
      ].join("\n"));

      const result = loadFromYaml(yamlPath);
      expect(result.model).toBe("claude-opus-4-6");
      expect(result.temperature).toBe(0.3);
      expect(result.maxIterations).toBe(40);
    });

    it("应该加载嵌套 YAML 配置", () => {
      const yamlPath = path.join(TEST_DIR, "nested.yaml");
      fs.writeFileSync(yamlPath, [
        "provider:",
        "  type: openai",
        "  apiKey: sk-test-key",
        "  modelName: gpt-5",
        "context:",
        "  maxTokens: 200000",
        "  compressionThreshold: red",
        "  autoCompact: true",
        "tools:",
        "  enabled:",
        "    - json_query",
        "    - read_file",
        "  toolsPerTurn: 6",
        "  pinnedTools:",
        "    - scratchpad_read",
      ].join("\n"));

      const result = loadFromYaml(yamlPath);
      expect(result.provider?.type).toBe("openai");
      expect(result.provider?.apiKey).toBe("sk-test-key");
      expect(result.context?.maxTokens).toBe(200000);
      expect(result.context?.compressionThreshold).toBe("red");
      expect(result.tools?.enabled).toEqual(["json_query", "read_file"]);
      expect(result.tools?.toolsPerTurn).toBe(6);
    });

    it("应该支持 tools.enabled: all 字符串", () => {
      const yamlPath = path.join(TEST_DIR, "all-tools.yaml");
      fs.writeFileSync(yamlPath, [
        "tools:",
        "  enabled: all",
        "  toolsPerTurn: 10",
      ].join("\n"));

      const result = loadFromYaml(yamlPath);
      expect(result.tools?.enabled).toEqual(["all"]);
    });
  });

  /* ── 5. CLI 参数加载 ────────────────────────────────────────── */

  describe("CLI 参数加载", () => {
    it("应该加载扁平 CLI 参数", () => {
      const result = loadFromCli({
        model: "gpt-5",
        temperature: "0.2",
        "max-iterations": "50",
      });
      expect(result.model).toBe("gpt-5");
      expect(result.temperature).toBe(0.2);
      expect(result.maxIterations).toBe(50);
    });

    it("应该加载嵌套 CLI 参数", () => {
      const result = loadFromCli({
        "provider-type": "openai",
        "provider-api-key": "sk-test",
        "context-max-tokens": "128000",
        "cost-enabled": "true",
        "cost-max-cost": "5.00",
      });
      expect(result.provider?.type).toBe("openai");
      expect(result.provider?.apiKey).toBe("sk-test");
      expect(result.context?.maxTokens).toBe(128000);
      expect(result.cost?.enabled).toBe(true);
      expect(result.cost?.maxCost).toBe(5.0);
    });

    it("空 CLI 参数不产生覆盖", () => {
      const result = loadFromCli({});
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("未定义的参数应被忽略", () => {
      const result = loadFromCli({ unknownParam: "value" });
      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  /* ── 6. 多层覆盖 ────────────────────────────────────────────── */

  describe("多层覆盖（优先级）", () => {
    const TEST_DIR = path.join(projectRoot, "tests", "__ch28_test_files");

    beforeEach(() => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it("配置文件应覆盖默认值", () => {
      const yamlPath = path.join(TEST_DIR, "override-default.yaml");
      fs.writeFileSync(yamlPath, [
        "model: claude-opus-4-6",
        "temperature: 0.2",
      ].join("\n"));

      const config = loadConfig([yamlPath]);
      expect(config.model).toBe("claude-opus-4-6");
      expect(config.temperature).toBe(0.2);
      // 默认值保留
      expect(config.maxIterations).toBe(25);
    });

    it("多个来源应后覆盖前", () => {
      const config = loadConfig([
        { model: "first", temperature: 0.5 } as Partial<AgentConfig>,
        { model: "second" } as Partial<AgentConfig>,
      ]);

      expect(config.model).toBe("second");
      expect(config.temperature).toBe(0.5);
    });

    it("YAML 文件应覆盖环境变量（无 env 时正常使用）", () => {
      // 只给文件，无环境变量干扰
      const yamlPath = path.join(TEST_DIR, "simple-override.yaml");
      fs.writeFileSync(yamlPath, [
        "model: from-file",
        "temperature: 0.9",
      ].join("\n"));

      const config = loadConfig([yamlPath]);
      expect(config.model).toBe("from-file");
      expect(config.temperature).toBe(0.9);
    });
  });

  /* ── 7. loadConfig 完整路径 ──────────────────────────────────── */

  describe("loadConfig 完整路径", () => {
    it("无 sources 时返回默认配置", () => {
      const config = loadConfig([]);
      expect(config.model).toBe(DEFAULT_CONFIG.model);
      expect(config.temperature).toBe(DEFAULT_CONFIG.temperature);
    });

    it("Partial<AgentConfig> 覆盖应生效", () => {
      const config = loadConfig([
        { model: "custom-model", maxIterations: 50 } as Partial<AgentConfig>,
      ]);
      expect(config.model).toBe("custom-model");
      expect(config.maxIterations).toBe(50);
      // 未覆盖的保持默认
      expect(config.temperature).toBe(0.7);
    });

    it("应通过验证（无效配置应抛出）", () => {
      expect(() => loadConfig([
        { maxIterations: 999 } as Partial<AgentConfig>,
      ])).toThrow(ConfigError);
    });
  });

  /* ── 8. 配置文件发现 ────────────────────────────────────────── */

  describe("配置文件发现", () => {
    const OLD_CWD = process.cwd();
    const TEST_DIR = path.join(projectRoot, "tests", "__ch28_discovery");

    beforeEach(() => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
      process.chdir(TEST_DIR);
    });

    afterEach(() => {
      process.chdir(OLD_CWD);
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it("找不到配置文件时返回 null", () => {
      const result = discoverConfigFile();
      expect(result).toBeNull();
    });

    it("应该找到 ./agent-harness.yaml", () => {
      fs.writeFileSync(path.join(TEST_DIR, "agent-harness.yaml"), "model: test\n");
      const result = discoverConfigFile();
      expect(result).toBeTruthy();
      expect(result).toContain("agent-harness.yaml");
    });

    it("应该找到 ./agent-harness.yml", () => {
      fs.writeFileSync(path.join(TEST_DIR, "agent-harness.yml"), "model: test\n");
      const result = discoverConfigFile();
      expect(result).toBeTruthy();
      expect(result).toContain("agent-harness.yml");
    });

    it("应该找到 ./config/agent-harness.yaml", () => {
      fs.mkdirSync(path.join(TEST_DIR, "config"), { recursive: true });
      fs.writeFileSync(path.join(TEST_DIR, "config", "agent-harness.yaml"), "model: test\n");
      const result = discoverConfigFile();
      expect(result).toBeTruthy();
      expect(result).toContain(path.join("config", "agent-harness.yaml"));
    });
  });

  /* ── 9. Factory 工厂 ────────────────────────────────────────── */

  describe("createAgentFromConfig 工厂", () => {
    it("应该创建完整的 AgentRuntime（默认配置）", async () => {
      const runtime = await createAgentFromConfig(DEFAULT_CONFIG);
      expect(runtime).toBeDefined();
      expect(runtime.provider).toBeDefined();
      expect(runtime.provider.name).toBe("mock");
      expect(runtime.registry).toBeDefined();
      expect(runtime.catalog).toBeDefined();
      expect(runtime.permissionManager).toBeDefined();
      expect(runtime.accountant).toBeDefined();
      expect(runtime.compactor).toBeDefined();
      expect(runtime.enforcer).toBeUndefined(); // cost.enabled = false
      expect(runtime.config).toEqual(DEFAULT_CONFIG);
    });

    it("应该创建带成本控制的 AgentRuntime", async () => {
      const config: AgentConfig = {
        ...DEFAULT_CONFIG,
        cost: { ...DEFAULT_CONFIG.cost, enabled: true, maxCost: 5.0 },
      };
      const runtime = await createAgentFromConfig(config);
      expect(runtime.enforcer).toBeDefined();
      expect(runtime.enforcer!.maxUsd).toBe(5.0);
    });

    it("应该创建带权限策略的 AgentRuntime", async () => {
      const config: AgentConfig = {
        ...DEFAULT_CONFIG,
        permissions: {
          ...DEFAULT_CONFIG.permissions,
          fileWrite: false,
          pathAllowlist: ["/tmp/test"],
        },
      };
      const runtime = await createAgentFromConfig(config);
      expect(runtime.permissionManager).toBeDefined();
    });

    it("应该注册 json_query 基础工具", async () => {
      const runtime = await createAgentFromConfig(DEFAULT_CONFIG);
      expect(runtime.registry.has("json_query")).toBe(true);
    });
  });

  /* ── 10. 工厂子函数 ─────────────────────────────────────────── */

  describe("工厂子函数", () => {
    describe("createProvider", () => {
      it('mock 类型应创建 MockProvider', () => {
        const provider = createProvider({ type: "mock", apiKey: undefined });
        expect(provider).toBeInstanceOf(MockProvider);
      });

      it("未知类型应回退到 MockProvider（带警告）", () => {
        const provider = createProvider({ type: "local" as any });
        expect(provider).toBeInstanceOf(MockProvider);
      });
    });

    describe("registerAllTools", () => {
      it('all 模式应注册所有内置工具', () => {
        const registry = new ToolRegistry();
        registerAllTools(registry, {
          enabled: ["all"],
          toolsPerTurn: 8,
          pinnedTools: [],
        });
        expect(registry.has("json_query")).toBe(true);
      });
    });

    describe("createPermissionPolicy", () => {
      it("应该根据配置创建权限策略", () => {
        const policy = createPermissionPolicy(DEFAULT_CONFIG.permissions);
        expect(policy).toBeDefined();

        // 测试策略会返回某个结果
        const result = policy({
          toolName: "read_file",
          args: { path: "/test/file.txt" },
          sideEffects: ["read"],
        });
        expect(result.decision).toBe("allow");
      });
    });
  });
});
