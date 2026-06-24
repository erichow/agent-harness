/**
 * 第 28 章示例 — 配置系统
 *
 * 展示：
 *   1. 使用默认配置创建 AgentRuntime
 *   2. 从 YAML 配置文件加载
 *   3. 多层覆盖（默认值 → 文件 → CLI 参数）
 *   4. 环境变量覆盖
 *   5. 配置验证
 *
 * 运行：npx tsx examples/ch28_configuration.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/* ─── 导入配置系统 ─────────────────────────────────────────────── */

import {
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigAuto,
  loadFromEnv,
  loadFromYaml,
  loadFromCli,
  discoverConfigFile,
  createAgentFromConfig,
  validateConfig,
  ConfigError,
} from "../src/config/index.js";

import { ToolRegistry } from "../src/harness/tools/registry.js";

/* ─── 1. 默认值展示 ────────────────────────────────────────────── */

console.log("═".repeat(60));
console.log("第28章 · 配置系统 — 示例");
console.log("═".repeat(60));

console.log("\n📋 1. 默认配置：");
console.log(JSON.stringify(DEFAULT_CONFIG, null, 2));

/* ─── 2. 配置验证 ──────────────────────────────────────────────── */

console.log("\n📋 2. 配置验证：");

try {
  validateConfig(DEFAULT_CONFIG);
  console.log("   ✅ 默认配置通过验证");
} catch (e) {
  console.log("   ❌ 验证失败:", (e as Error).message);
}

// 无效配置
try {
  validateConfig({
    ...DEFAULT_CONFIG,
    maxIterations: 999,
  });
} catch (e) {
  console.log("   ✅ 无效配置被拒绝:", (e as ConfigError).message);
}

/* ─── 3. YAML 配置文件 ──────────────────────────────────────────── */

console.log("\n📋 3. 从 YAML 加载：");

const yamlPath = path.join(projectRoot, "examples", "_ch28_config.yaml");
const yamlContent = [
  "# agent-harness.yaml — 示例配置文件",
  "model: claude-opus-4-20250514",
  "temperature: 0.3",
  "maxIterations: 30",
  "",
  "provider:",
  "  type: mock",
  "  modelName: claude-opus-4-20250514",
  "",
  "context:",
  "  maxTokens: 128000",
  "  compressionThreshold: yellow",
  "  autoCompact: true",
  "",
  "tools:",
  "  enabled:",
  "    - json_query",
  "  toolsPerTurn: 6",
  "  pinnedTools:",
  "    - scratchpad_read",
  "",
  "permissions:",
  "  fileWrite: true",
  "  fileDelete: false",
  "  terminal: true",
  "  gitWrite: true",
  "  askOnWrite: true",
  "  pathAllowlist:",
  "    - /home/user/project",
  "",
  "cost:",
  "  enabled: true",
  "  maxTokens: 500000",
  "  maxCost: 10.00",
  "  alertAt: 80",
].join("\n");

fs.writeFileSync(yamlPath, yamlContent, "utf-8");

try {
  const fileConfig = loadFromYaml(yamlPath);
  console.log("   从文件加载的部分配置:");
  console.log(`   model: ${fileConfig.model}`);
  console.log(`   temperature: ${fileConfig.temperature}`);
  console.log(`   provider.type: ${fileConfig.provider?.type}`);
  console.log(`   context.maxTokens: ${fileConfig.context?.maxTokens}`);
} finally {
  fs.unlinkSync(yamlPath);
}

/* ─── 4. 多层覆盖 ──────────────────────────────────────────────── */

console.log("\n📋 4. 多层覆盖：");

const config = loadConfig([
  { model: "gpt-5", temperature: 0.5 } as any,
  { model: "claude-sonnet-4-6" } as any,
]);

console.log(`   最终 model: ${config.model}`);           // claude-sonnet-4-6
console.log(`   最终 temperature: ${config.temperature}`); // 0.5（保留自第一个覆盖）

/* ─── 5. CLI 参数 ──────────────────────────────────────────────── */

console.log("\n📋 5. CLI 参数加载：");

const cliOverrides = loadFromCli({
  "provider-type": "mock",
  "context-max-tokens": "64000",
  "cost-enabled": "true",
  "cost-max-cost": "5.00",
});

console.log(`   provider.type: ${cliOverrides.provider?.type}`);
console.log(`   context.maxTokens: ${cliOverrides.context?.maxTokens}`);
console.log(`   cost.enabled: ${cliOverrides.cost?.enabled}`);

/* ─── 6. 环境变量 ──────────────────────────────────────────────── */

console.log("\n📋 6. 环境变量加载（模拟）：");

process.env["MODEL"] = "env-model";
process.env["TEMPERATURE"] = "0.1";
process.env["CONTEXT_AUTO_COMPACT"] = "false";

const envOverrides = loadFromEnv();
console.log(`   MODEL → ${envOverrides.model}`);
console.log(`   TEMPERATURE → ${envOverrides.temperature}`);

delete process.env["MODEL"];
delete process.env["TEMPERATURE"];
delete process.env["CONTEXT_AUTO_COMPACT"];

/* ─── 7. 配置文件发现 ──────────────────────────────────────────── */

console.log("\n📋 7. 配置文件发现：");
const found = discoverConfigFile();
if (found) {
  console.log(`   找到配置文件: ${found}`);
} else {
  console.log("   未找到配置文件（使用默认值）");
}

/* ─── 8. createAgentFromConfig ─────────────────────────────────── */

console.log("\n📋 8. 从配置创建 AgentRuntime：");

async function demoFactory() {
  const runtime = await createAgentFromConfig(DEFAULT_CONFIG);

  console.log(`   provider: ${runtime.provider.name}`);
  console.log(`   registry tools: ${runtime.registry.list().join(", ")}`);
  console.log(`   catalog entries: ${runtime.catalog.size}`);
  console.log(`   permissionManager: ${runtime.permissionManager !== undefined}`);
  console.log(`   accountant budget: ${runtime.accountant.budget.windowSize}`);
  console.log(`   enforcer: ${runtime.enforcer ? `max $${runtime.enforcer.maxUsd}` : "disabled"}`);

  console.log("\n✅ 配置系统示例完成！");
}

await demoFactory();
