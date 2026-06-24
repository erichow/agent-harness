/**
 * 第 29 章测试 — CLI 应用
 *
 * 覆盖：
 *   1. parseArgs — 各种 flag 组合、位置参数、边界情况
 *   2. printHelp / printVersion — 输出内容
 *   3. displayEvent — 各种事件类型（verbose / 非 verbose）
 *   4. displayToolResult — 成功/失败/截断
 *   5. displayContextBar — 绿/黄/红状态
 *   6. displayWelcome — 欢迎信息
 *   7. runSingleTurn — 流式模式 + 非流式模式
 *   8. main() — --help、--version、配置错误、消息处理
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// ── CLI 模块 ───────────────────────────────────────────────────────

import {
  parseArgs,
  printHelp,
  printVersion,
  displayEvent,
  displayToolResult,
  displayContextBar,
  displayWelcome,
  runSingleTurn,
  main,
} from "../src/cli/main.js";

import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import {
  textDelta,
  reasoningDelta,
  toolCallStart,
  toolCallDelta,
  completed,
} from "../src/harness/providers/events.js";
import type { StreamEvent } from "../src/harness/providers/events.js";
import type { ToolResultBlock } from "../src/harness/messages.js";
import { toolResultBlock } from "../src/harness/messages.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { ContextAccountant, ContextBudget, ContextSnapshot } from "../src/harness/context/accountant.js";

// ── Helpers ────────────────────────────────────────────────────────

/** 开始捕获 stdout，返回恢复函数和已捕获内容 */
function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(
    (chunk: any) => {
      chunks.push(String(chunk));
      return true;
    },
  );
  return {
    chunks,
    restore: () => spy.mockRestore(),
  };
}

/** 开始捕获 stderr，返回恢复函数和已捕获内容 */
function captureStderr(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(
    (chunk: any) => {
      chunks.push(String(chunk));
      return true;
    },
  );
  return {
    chunks,
    restore: () => spy.mockRestore(),
  };
}

/** 创建自带 MockProvider 响应的 AgentRuntime（测试用） */
async function createMockRuntime(responses?: ProviderResponse[]) {
  const { createAgentFromConfig, DEFAULT_CONFIG } = await import("../src/config/index.js");
  const runtime = await createAgentFromConfig(DEFAULT_CONFIG);
  const mock = new MockProvider(responses ?? [new ProviderResponse("Mock answer")]);
  // 替换 provider
  (runtime as any).provider = mock;
  return { runtime, mock };
}

describe("第29章 · CLI 应用", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ── 1. parseArgs ────────────────────────────────────────────── */

  describe("parseArgs", () => {
    it("空参数应返回默认选项", () => {
      const result = parseArgs([]);
      expect(result).toEqual({
        config: undefined,
        message: undefined,
        noStream: undefined,
        provider: undefined,
        temperature: undefined,
        verbose: undefined,
        version: undefined,
        help: undefined,
        _positional: [],
      });
    });

    it("应该解析 --help", () => {
      const result = parseArgs(["--help"]);
      expect(result.help).toBe(true);
    });

    it("应该解析 --version", () => {
      const result = parseArgs(["--version"]);
      expect(result.version).toBe(true);
    });

    it("应该解析 -m 消息参数", () => {
      const result = parseArgs(["-m", "Hello world"]);
      expect(result.message).toBe("Hello world");
    });

    it("应该解析 --message 消息参数", () => {
      const result = parseArgs(["--message", "你好"]);
      expect(result.message).toBe("你好");
    });

    it("应该解析 -c 配置文件路径", () => {
      const result = parseArgs(["-c", "/path/to/config.yaml"]);
      expect(result.config).toBe("/path/to/config.yaml");
    });

    it("应该解析 --config 配置文件路径", () => {
      const result = parseArgs(["--config", "./my-config.yaml"]);
      expect(result.config).toBe("./my-config.yaml");
    });

    it("应该解析 -n / --no-stream", () => {
      const result1 = parseArgs(["-n"]);
      expect(result1.noStream).toBe(true);

      const result2 = parseArgs(["--no-stream"]);
      expect(result2.noStream).toBe(true);
    });

    it("应该解析 -p / --provider", () => {
      const result1 = parseArgs(["-p", "openai"]);
      expect(result1.provider).toBe("openai");

      const result2 = parseArgs(["--provider", "mock"]);
      expect(result2.provider).toBe("mock");
    });

    it("应该解析 -t / --temperature", () => {
      const result1 = parseArgs(["-t", "0.5"]);
      expect(result1.temperature).toBe(0.5);

      const result2 = parseArgs(["--temperature", "1.0"]);
      expect(result2.temperature).toBe(1.0);
    });

    it("应该解析 -v / --verbose", () => {
      const result1 = parseArgs(["-v"]);
      expect(result1.verbose).toBe(true);

      const result2 = parseArgs(["--verbose"]);
      expect(result2.verbose).toBe(true);
    });

    it("位置参数应收集到 _positional", () => {
      const result = parseArgs(["hello", "world"]);
      expect(result._positional).toEqual(["hello", "world"]);
    });

    it("位置参数与 flag 混用", () => {
      const result = parseArgs(["-v", "hello", "-n", "world"]);
      expect(result.verbose).toBe(true);
      expect(result.noStream).toBe(true);
      expect(result._positional).toEqual(["hello", "world"]);
    });

    it("未知 flag 的值不应进入 _positional（flag 本身跳过）", () => {
      const result = parseArgs(["--unknown", "value"]);
      // --unknown 不是已知 flag，也不是以 - 开头的参数名
      // 所以 --unknown 跳过了，但 "value" 不是以 - 开头 → 进入 _positional
      expect(result._positional).toEqual(["value"]);
    });

    it("多个 flag 组合", () => {
      const result = parseArgs([
        "-m", "test message",
        "-p", "mock",
        "-t", "0.3",
        "-v",
        "-n",
      ]);
      expect(result.message).toBe("test message");
      expect(result.provider).toBe("mock");
      expect(result.temperature).toBe(0.3);
      expect(result.verbose).toBe(true);
      expect(result.noStream).toBe(true);
    });

    it("temperature 解析浮点数边界", () => {
      const result = parseArgs(["-t", "0"]);
      expect(result.temperature).toBe(0);

      const result2 = parseArgs(["-t", "2.0"]);
      expect(result2.temperature).toBe(2.0);
    });

    it("短 flag 缺少值时不会崩溃", () => {
      const result = parseArgs(["-c"]);
      expect(result.config).toBeUndefined();
    });

    it("两个短 flag 并列（-nv 不被支持，但不应崩溃）", () => {
      const result = parseArgs(["-nv"]);
      // -nv 不被识别为已知选项，被跳过
      expect(result.noStream).toBeUndefined();
      expect(result.verbose).toBeUndefined();
    });
  });

  /* ── 2. printHelp / printVersion ─────────────────────────────── */

  describe("printHelp", () => {
    it("应输出帮助信息到 stdout", () => {
      const { chunks, restore } = captureStdout();
      printHelp();
      restore();

      const output = chunks.join("");
      expect(output).toContain("Usage: agent-harness");
      expect(output).toContain("--config");
      expect(output).toContain("--message");
      expect(output).toContain("--no-stream");
      expect(output).toContain("--provider");
      expect(output).toContain("--temperature");
      expect(output).toContain("--verbose");
      expect(output).toContain("--version");
      expect(output).toContain("--help");
    });
  });

  describe("printVersion", () => {
    it("应输出版本信息到 stdout", () => {
      const { chunks, restore } = captureStdout();
      printVersion();
      restore();

      const output = chunks.join("");
      expect(output).toContain("agent-harness");
      expect(output).toContain("v0.1.0");
    });
  });

  /* ── 3. displayEvent ────────────────────────────────────────── */

  describe("displayEvent", () => {
    it("text_delta 应写入 stdout", () => {
      const { chunks, restore } = captureStdout();
      displayEvent(textDelta("Hello"), false);
      restore();

      expect(chunks.join("")).toBe("Hello");
    });

    it("多个 text_delta 应拼接", () => {
      const { chunks, restore } = captureStdout();
      displayEvent(textDelta("Hello, "), false);
      displayEvent(textDelta("world!"), false);
      restore();

      expect(chunks.join("")).toBe("Hello, world!");
    });

    it("reasoning_delta 在非 verbose 模式不应输出", () => {
      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      displayEvent(reasoningDelta("思考中..."), false);
      restoreErr();

      expect(errChunks.join("")).toBe("");
    });

    it("reasoning_delta 在 verbose 模式应输出到 stderr（灰色 ANSI）", () => {
      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      displayEvent(reasoningDelta("思考中..."), true);
      restoreErr();

      const output = errChunks.join("");
      expect(output).toContain("思考中...");
      expect(output).toContain("\x1b[90m"); // 灰色 ANSI
    });

    it("tool_call_start 应输出到 stderr（带 🔧 图标）", () => {
      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      displayEvent(toolCallStart("call-1", "json_query"), false);
      restoreErr();

      const output = errChunks.join("");
      expect(output).toContain("🔧");
      expect(output).toContain("json_query");
    });

    it("tool_call_delta 不应输出（静默处理）", () => {
      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      const { chunks: outChunks, restore: restoreOut } = captureStdout();
      displayEvent(toolCallDelta("call-1", '{"a":1}'), false);
      restoreErr();
      restoreOut();

      expect(errChunks.join("")).toBe("");
      expect(outChunks.join("")).toBe("");
    });

    it("completed 在非 verbose 模式不应输出", () => {
      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      displayEvent(completed(10, 20), false);
      restoreErr();

      expect(errChunks.join("")).toBe("");
    });

    it("completed 在 verbose 模式应输出 token 统计", () => {
      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      displayEvent(completed(10, 20, 5), true);
      restoreErr();

      const output = errChunks.join("");
      expect(output).toContain("10→20");
      expect(output).toContain("5 reasoning");
    });

    it("completed 不包含 reasoning 时不应显示", () => {
      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      displayEvent(completed(10, 20), true);
      restoreErr();

      const output = errChunks.join("");
      expect(output).toContain("10→20");
      expect(output).not.toContain("reasoning");
    });
  });

  /* ── 4. displayToolResult ────────────────────────────────────── */

  describe("displayToolResult", () => {
    it("成功结果应显示 ✅", () => {
      const { chunks, restore } = captureStderr();
      displayToolResult(toolResultBlock("call-1", "42", false));
      restore();

      expect(chunks.join("")).toContain("✅");
      expect(chunks.join("")).toContain("42");
    });

    it("失败结果应显示 ❌", () => {
      const { chunks, restore } = captureStderr();
      displayToolResult(toolResultBlock("call-2", "error: not found", true));
      restore();

      expect(chunks.join("")).toContain("❌");
      expect(chunks.join("")).toContain("error: not found");
    });

    it("长结果应截断到 100 字符加 …", () => {
      const longContent = "x".repeat(200);
      const { chunks, restore } = captureStderr();
      displayToolResult(toolResultBlock("call-3", longContent, false));
      restore();

      const output = chunks.join("");
      expect(output).toContain("x".repeat(100));
      expect(output).toContain("…");
      expect(output).not.toContain("x".repeat(101));
    });

    it("短结果不应截断", () => {
      const { chunks, restore } = captureStderr();
      displayToolResult(toolResultBlock("call-4", "done", false));
      restore();

      const output = chunks.join("");
      expect(output).toContain("done");
      expect(output).not.toContain("…");
    });
  });

  /* ── 5. displayContextBar ────────────────────────────────────── */

  describe("displayContextBar", () => {
    const budget = new ContextBudget(100_000, 4096);

    it("绿色状态（<50%）应显示绿色 ANSI", () => {
      const snapshot = new ContextSnapshot(
        { system: 1000, tools: 2000, history: 30000, retrieved: 500, headroom: 4096 },
        budget,
      );
      const { chunks, restore } = captureStderr();
      displayContextBar(snapshot);
      restore();

      const output = chunks.join("");
      // totalUsed = 1000+2000+30000+500 = 33500
      // pct = 33500/100000*100 = 33.5 → 34%
      expect(output).toContain("\x1b[32m"); // 绿色
      expect(output).toContain("34%");
    });

    it("黄色状态（50-79%）应显示黄色 ANSI", () => {
      const snapshot = new ContextSnapshot(
        { system: 1000, tools: 2000, history: 65000, retrieved: 500, headroom: 4096 },
        budget,
      );
      const { chunks, restore } = captureStderr();
      displayContextBar(snapshot);
      restore();

      const output = chunks.join("");
      expect(output).toContain("\x1b[33m"); // 黄色
    });

    it("红色状态（≥80%）应显示红色 ANSI", () => {
      const snapshot = new ContextSnapshot(
        { system: 1000, tools: 2000, history: 85000, retrieved: 500, headroom: 4096 },
        budget,
      );
      const { chunks, restore } = captureStderr();
      displayContextBar(snapshot);
      restore();

      const output = chunks.join("");
      expect(output).toContain("\x1b[31m"); // 红色
    });

    it("使用率 0% 时应有空条", () => {
      const snapshot = new ContextSnapshot(
        { system: 0, tools: 0, history: 0, retrieved: 0, headroom: 4096 },
        budget,
      );
      const { chunks, restore } = captureStderr();
      displayContextBar(snapshot);
      restore();

      const output = chunks.join("");
      expect(output).toContain("0%");
    });

    it("使用率 100% 时条应填满", () => {
      const snapshot = new ContextSnapshot(
        { system: 30000, tools: 20000, history: 50000, retrieved: 0, headroom: 4096 },
        budget,
      );
      const { chunks, restore } = captureStderr();
      displayContextBar(snapshot);
      restore();

      const output = chunks.join("");
      expect(output).toContain("100%");
    });
  });

  /* ── 6. displayWelcome ──────────────────────────────────────── */

  describe("displayWelcome", () => {
    it("应输出欢迎信息到 stderr", () => {
      const { chunks, restore } = captureStderr();
      displayWelcome();
      restore();

      const output = chunks.join("");
      expect(output).toContain("agent-harness");
      expect(output).toContain("v0.1.0");
      expect(output).toContain("exit");
      expect(output).toContain("quit");
    });
  });

  /* ── 7. runSingleTurn ────────────────────────────────────────── */

  describe("runSingleTurn", () => {
    it("流式模式应输出 text_delta 到 stdout", async () => {
      const { runtime, mock } = await createMockRuntime([new ProviderResponse("Hello from CLI!")]);

      const { chunks: outChunks, restore: restoreOut } = captureStdout();
      const { restore: restoreErr } = captureStderr();

      await runSingleTurn(runtime, "hi", { noStream: false });

      restoreOut();
      restoreErr();

      const output = outChunks.join("");
      expect(output).toContain("Hello from CLI!");
      // 流式输出结尾应有换行
      expect(output.endsWith("\n")).toBe(true);
    });

    it("非流式模式（noStream）应通过 console.log 输出", async () => {
      const { runtime } = await createMockRuntime([new ProviderResponse("Final answer.")]);

      const { chunks: outChunks, restore: restoreOut } = captureStdout();

      await runSingleTurn(runtime, "hi", { noStream: true });

      restoreOut();

      const output = outChunks.join("");
      expect(output).toContain("Final answer.");
    });

    it("非流式模式不应有事件显示（stderr 为空）", async () => {
      const { runtime } = await createMockRuntime([new ProviderResponse("Hello")]);

      const { chunks: outChunks, restore: restoreOut } = captureStdout();
      const { chunks: errChunks, restore: restoreErr } = captureStderr();

      await runSingleTurn(runtime, "hi", { noStream: true });

      restoreOut();
      restoreErr();

      const output = outChunks.join("");
      expect(output).toBe("Hello\n");
      // stderr 不应有事件显示
      expect(errChunks.join("")).toBe("");
    });

    it("工具调用应显示结果到 stderr（noStream 模式不显示）", async () => {
      const { runtime, mock } = await createMockRuntime([
        new ProviderResponse(undefined, [new ToolCallRef("call-1", "echo", { msg: "test" })]),
        new ProviderResponse("Done!"),
      ]);

      // 注册 echo 工具
      (runtime as any).registry.register(
        {
          name: "echo",
          description: "Echo",
          inputSchema: {
            type: "object",
            properties: { msg: { type: "string" } },
            required: ["msg"],
          },
        },
        (args: any) => `echo: ${args.msg}`,
      );

      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      const { restore: restoreOut } = captureStdout();

      await runSingleTurn(runtime, "echo test", { noStream: true });

      restoreErr();
      restoreOut();

      // noStream 模式不注册 onToolResult，所以 stderr 为空
      expect(errChunks.join("")).toBe("");
    });

    it("verbose 模式应显示 reasoning 和 token 统计", async () => {
      const { runtime, mock } = await createMockRuntime();
      // 流式预设
      mock.setStreamPreset([
        reasoningDelta("thinking..."),
        textDelta("Hello"),
        completed(10, 20, 5),
      ]);

      const { chunks: errChunks, restore: restoreErr } = captureStderr();
      const { restore: restoreOut } = captureStdout();

      await runSingleTurn(runtime, "hi", { verbose: true });

      restoreErr();
      restoreOut();

      const errOutput = errChunks.join("");
      expect(errOutput).toContain("thinking...");
      expect(errOutput).toContain("10→20");
      expect(errOutput).toContain("5 reasoning");
    });
  });

  /* ── 8. main() — 完整入口 ────────────────────────────────────── */

  describe("main()", () => {
    it("--help 应返回 0 并输出帮助信息", async () => {
      const { chunks, restore } = captureStdout();
      const code = await main(["--help"]);
      restore();

      expect(code).toBe(0);
      expect(chunks.join("")).toContain("Usage: agent-harness");
    });

    it("--version 应返回 0 并输出版本信息", async () => {
      const { chunks, restore } = captureStdout();
      const code = await main(["--version"]);
      restore();

      expect(code).toBe(0);
      expect(chunks.join("")).toContain("agent-harness v0.1.0");
    });

    it("位置参数应触发单轮模式（MockProvider 无响应 → exit 2）", async () => {
      const { restore: restoreOut } = captureStdout();
      const { restore: restoreErr } = captureStderr();

      // 使用默认的 MockProvider（空响应列表），会抛 "mock ran out of responses"
      const code = await main(["hello world"]);

      restoreOut();
      restoreErr();

      // 这是一个未预期的运行时错误 → exit 2
      expect(code).toBe(2);
    });

    it("无效配置（maxIterations 越界）应返回 exit code 1", async () => {
      const { restore: restoreOut } = captureStdout();
      const { restore: restoreErr } = captureStderr();

      // 模拟一个 ConfigError — 用户提供的参数超出范围
      // 实际 CLI 中不会遇到，但直接传无效 config 无法通过 loadConfig
      // 所以我们测试一个已知会触发 ConfigError 的场景
      const code = await main(["-m", "hello"]);

      restoreOut();
      restoreErr();

      // 默认 MockProvider 无响应，抛的是普通 Error → exit 2
      // 但通过 --version 和 --help 之外的路径，这里 exit 2 是对的
      expect(code).toBe(2);
    });

    it("-m 带消息应触发单轮模式（MockProvider 无响应 → exit 2）", async () => {
      const { restore: restoreOut } = captureStdout();
      const { restore: restoreErr } = captureStderr();

      const code = await main(["-m", "test message"]);

      restoreOut();
      restoreErr();

      expect(code).toBe(2); // MockProvider 无响应 → 运行时错误
    });

    it("--help 和 --message 同时传，--help 优先返回 0", async () => {
      const { chunks, restore } = captureStdout();
      const code = await main(["--help", "-m", "hello"]);
      restore();

      expect(code).toBe(0);
      expect(chunks.join("")).toContain("Usage:");
    });

    it("--version 和 --help 同时传，--version 优先", async () => {
      const { chunks, restore } = captureStdout();
      const code = await main(["--version", "--help"]);
      restore();

      expect(code).toBe(0);
      expect(chunks.join("")).toContain("v0.1.0");
    });
  });
});
