/**
 * 第 29 章示例 — CLI 应用
 *
 * 展示：
 *   1. parseArgs() — 参数解析（各种 flag 组合）
 *   2. printHelp() / printVersion() — 帮助和版本输出
 *   3. displayEvent() — 流式事件显示
 *   4. displayContextBar() — 上下文状态栏
 *   5. runSingleTurn() — 单轮模式（模拟一次对话）
 *   6. main() — 完整入口（多种退出码场景）
 *
 * 运行：npx tsx examples/ch29_cli_application.ts
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ─── 导入 CLI 模块 ─────────────────────────────────────────────── */

import {
  parseArgs,
  printHelp,
  printVersion,
  displayEvent,
  displayContextBar,
  displayToolResult,
  runSingleTurn,
  main,
} from "../src/cli/main.js";

import {
  createAgentFromConfig,
  DEFAULT_CONFIG,
} from "../src/config/index.js";

import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse } from "../src/harness/providers/base.js";
import {
  textDelta,
  reasoningDelta,
  toolCallStart,
  toolCallDelta,
  completed,
} from "../src/harness/providers/events.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { ToolCatalog } from "../src/harness/tools/selector.js";
import { ContextAccountant, ContextBudget, ContextSnapshot } from "../src/harness/context/accountant.js";
import type { StreamEvent } from "../src/harness/providers/events.js";
import type { ToolResultBlock } from "../src/harness/messages.js";
import { toolResultBlock } from "../src/harness/messages.js";

/* ════════════════════════════════════════════════════════════════════
   正文
   ════════════════════════════════════════════════════════════════════ */

console.log("═".repeat(60));
console.log("第29章 · CLI 应用 — 示例");
console.log("═".repeat(60));

/* ─── 1. parseArgs 展示 ─────────────────────────────────────────── */

console.log("\n📋 1. parseArgs — 参数解析：");

const testCases = [
  ["--help"],
  ["--version"],
  ["-m", "Hello world", "-v"],
  ["-c", "config.yaml", "-p", "mock", "-t", "0.3"],
  ["--no-stream", "问一个问题就走"],
  ["-v", "-m", "你好", "-n"],
  ["--provider", "openai", "--temperature", "0.5", "直接传消息"],
];

for (const argv of testCases) {
  const result = parseArgs(argv);
  const summary = Object.entries(result)
    .filter(([, v]) => {
      if (Array.isArray(v)) return v.length > 0;
      return v !== undefined && v !== false;
    })
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
    .join(", ");
  console.log(`   ${argv.join(" ").padEnd(50)} → ${summary}`);
}

/* ─── 2. printHelp / printVersion ────────────────────────────────── */

console.log("\n📋 2. printHelp()：");
printHelp();

console.log("\n📋 3. printVersion()：");
printVersion();

/* ─── 3. displayEvent 展示 ──────────────────────────────────────── */

console.log("\n📋 4. displayEvent — 流式事件显示（写入 stderr）：");
console.log("   （下面的图标和文本会输出到 stderr）");

// 模拟各种事件
const demoEvents: StreamEvent[] = [
  reasoningDelta("让我思考一下这个问题……"),
  textDelta("Hello"),
  textDelta(", "),
  textDelta("world!"),
  toolCallStart("call-1", "json_query"),
  toolCallDelta("call-1", '{"data": "{"a":1}", "path": "a"}'),
  completed(10, 20, 5),
];

process.stderr.write("   — 非 verbose 模式 —\n");
for (const event of demoEvents) {
  displayEvent(event, false);
}

process.stderr.write("\n   — verbose 模式 —\n");
for (const event of demoEvents) {
  displayEvent(event, true);
}

/* ─── 4. displayToolResult 展示 ─────────────────────────────────── */

console.log("\n📋 5. displayToolResult — 工具结果展示：");

const results: ToolResultBlock[] = [
  toolResultBlock("call-1", "42", false),
  toolResultBlock("call-2", "文件不存在: /tmp/test.txt", true),
  toolResultBlock("call-3", "x".repeat(200), false),
];

for (const r of results) {
  displayToolResult(r);
}

/* ─── 5. displayContextBar 展示 ──────────────────────────────────── */

console.log("\n📋 6. displayContextBar — 上下文状态栏：");

const budget = new ContextBudget(100_000, 4096);

// 绿色（<50%）
const greenSnapshot = new ContextSnapshot(
  { system: 1000, tools: 2000, history: 30000, retrieved: 500, headroom: 4096 },
  budget,
);

// 黄色（50-79%）
const yellowSnapshot = new ContextSnapshot(
  { system: 1000, tools: 2000, history: 65000, retrieved: 500, headroom: 4096 },
  budget,
);

// 红色（≥80%）
const redSnapshot = new ContextSnapshot(
  { system: 1000, tools: 2000, history: 85000, retrieved: 500, headroom: 4096 },
  budget,
);

process.stderr.write("\n");
displayContextBar(greenSnapshot);
displayContextBar(yellowSnapshot);
displayContextBar(redSnapshot);

/* ─── 6. runSingleTurn 展示 ──────────────────────────────────────── */

console.log("\n📋 7. runSingleTurn — 单轮模式（MockProvider）：");

async function demoSingleTurn() {
  // 创建一个 MockProvider 并设置响应
  const mock = new MockProvider([new ProviderResponse("这是一个 mock 回答！")]);

  // 从默认配置创建 runtime，覆盖 provider
  const runtime = await createAgentFromConfig({
    ...DEFAULT_CONFIG,
    provider: { type: "mock", apiKey: undefined, baseUrl: undefined, modelName: "mock-model" },
  });

  // 用我们的 custom mock 替换 provider
  (runtime as any).provider = mock;

  console.log("   用户消息: 你好");
  console.log("   输出:");

  // 捕获 stdout
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const mockWrite = (chunk: string) => { stdoutChunks.push(chunk); return true; };
  const mockErrWrite = (chunk: string) => { stderrChunks.push(chunk); return true; };

  (process.stdout as any).write = mockWrite;
  (process.stderr as any).write = mockErrWrite;

  await runSingleTurn(runtime, "你好", { verbose: true });

  (process.stdout as any).write = originalStdout;
  (process.stderr as any).write = originalStderr;

  // 恢复后输出
  const stdoutText = stdoutChunks.join("");
  console.log(`   文本输出: ${stdoutText.slice(0, 50)}...`);
  console.log(`   stderr 行数: ${stderrChunks.length}`);

  console.log("\n   单轮模式完成 ✅");
}

await demoSingleTurn();

/* ─── 7. main() 各场景 ──────────────────────────────────────────── */

console.log("\n📋 8. main() — 完整入口（模拟命令行调用）：");

async function demoMain() {
  // --help
  console.log("\n   a) --help → exit code");
  const code1 = await main(["--help"]);
  console.log(`      exit code: ${code1}`);

  // --version
  console.log("\n   b) --version → exit code");
  const code2 = await main(["--version"]);
  console.log(`      exit code: ${code2}`);

  // 无效配置（maxIterations 越界）
  console.log("\n   c) 配置错误 → exit code 1");
  const code3 = await main(["-m", "hello"]);
  console.log(`      exit code: ${code3}`);

  // 未知 flag 应被忽略（位置参数作为 message）
  console.log("\n   d) 未知 flag + 位置参数");
  const code4 = await main(["--unknown-flag", "hello world"]);
  console.log(`      exit code: ${code4}`);

  console.log("\n📋 main() 各场景完成 ✅");
}

await demoMain();

console.log("\n" + "═".repeat(60));
console.log("✅ 第29章 CLI 示例完成！");
console.log("═".repeat(60));
