#!/usr/bin/env node

/**
 * src/cli/main.ts — 第 29 章：CLI 应用
 *
 * 把 harness 变成可运行的命令行工具。
 *
 * 功能：
 *   1. parseArgs() — CLI 参数解析
 *   2. runCLI() — 交互式 REPL（readline 循环）
 *   3. runSingleTurn() — 单轮模式（一条消息后退出）
 *   4. displayEvent() — 流式事件显示
 *   5. displayContextBar() — 上下文状态栏
 *   6. main() — 主入口
 *
 * 运行：npx tsx src/cli/main.ts [options] [message]
 */

import * as readline from "node:readline";
import type { StreamEvent } from "../harness/providers/events.js";
import type { ContextSnapshot } from "../harness/context/accountant.js";
import type { ToolResultBlock } from "../harness/messages.js";
import { arun } from "../harness/agent.js";
import { createAgentFromConfig, loadConfig, loadFromEnv, loadFromCli, loadFromYaml, discoverConfigFile } from "../config/index.js";
import type { AgentRuntime } from "../config/factory.js";

/* ─── CLI Options ───────────────────────────────────────────────── */

export interface CLIOptions {
  /** 配置文件路径 */
  config?: string;
  /** 单轮模式消息 */
  message?: string;
  /** 禁用流式输出 */
  noStream?: boolean;
  /** 覆盖 provider */
  provider?: string;
  /** 覆盖 temperature */
  temperature?: number;
  /** 详细日志 */
  verbose?: boolean;
  /** 显示版本 */
  version?: boolean;
  /** 显示帮助 */
  help?: boolean;
  /** 位置参数 */
  _positional: string[];
}

/* ─── ANSI 颜色常量 ──────────────────────────────────────────────── */

const ANSI_DIM = "\x1b[90m";
const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";

/* ════════════════════════════════════════════════════════════════════
   ① parseArgs — CLI 参数解析
   ════════════════════════════════════════════════════════════════════ */

/**
 * 解析 CLI 命令行参数。
 *
 * 支持：
 *   - 短选项：-c, -m, -n, -p, -t, -v
 *   - 长选项：--config, --message, --no-stream, --provider, --temperature, --verbose, --version, --help
 *   - 位置参数（非 `-` 开头的参数）
 *   - 值选项的后续参数（--config <path>）
 *
 * @param argv - 参数数组（不含 node 和脚本路径）
 * @returns 结构化选项
 */
export function parseArgs(argv: string[]): CLIOptions {
  const options: CLIOptions = { _positional: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "-c":
      case "--config":
        options.config = argv[++i];
        break;
      case "-m":
      case "--message":
        options.message = argv[++i];
        break;
      case "-n":
      case "--no-stream":
        options.noStream = true;
        break;
      case "-p":
      case "--provider":
        options.provider = argv[++i];
        break;
      case "-t":
      case "--temperature":
        options.temperature = parseFloat(argv[++i]);
        break;
      case "-v":
      case "--verbose":
        options.verbose = true;
        break;
      case "--version":
        options.version = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          options._positional.push(arg);
        }
        break;
    }
  }

  return options;
}

/* ════════════════════════════════════════════════════════════════════
   ② Help / Version
   ════════════════════════════════════════════════════════════════════ */

/**
 * 打印帮助信息。
 */
export function printHelp(): void {
  process.stdout.write(`Usage: agent-harness [options] [message]

Options:
  -c, --config <path>     Config file path
  -m, --message <text>    单轮模式：跑一次后退出
  -n, --no-stream         不流式输出（一次性显示）
  -p, --provider <name>   覆盖 provider
  -t, --temperature <n>   覆盖 temperature
  -v, --verbose           详细日志
  --version               显示版本
  --help                  显示帮助\n`);
}

/**
 * 打印版本信息。
 */
export function printVersion(): void {
  process.stdout.write("agent-harness v0.1.0\n");
}

/* ════════════════════════════════════════════════════════════════════
   ③ Display 函数 — 给用户看的反馈
   ════════════════════════════════════════════════════════════════════ */

/**
 * 显示流式事件。
 *
 * 不同事件类型的输出目标：
 *   - text_delta → stdout（agent 输出的文本）
 *   - reasoning_delta → stderr（思考过程，灰色，仅 verbose 模式）
 *   - tool_call_start → stderr（🔧 工具名）
 *   - tool_call_delta → 静默（由 accumulate 合并）
 *   - completed → stderr（token 统计，仅 verbose 模式）
 *
 * 状态信息写在 stderr，确保 stdout 只有 agent 输出，方便管道重定向。
 *
 * @param event   - 流式事件
 * @param verbose - 是否显示详细日志
 */
export function displayEvent(event: StreamEvent, verbose = false): void {
  switch (event.kind) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "reasoning_delta":
      if (verbose) {
        process.stderr.write(`${ANSI_DIM}${event.text}${ANSI_RESET}`);
      }
      break;
    case "tool_call_start":
      process.stderr.write(`\n🔧 ${event.name}...\n`);
      break;
    case "tool_call_delta":
      // 参数片段静默处理——accumulate 会合并
      break;
    case "completed":
      if (verbose) {
        process.stderr.write(
          `${ANSI_DIM}✓ ${event.inputTokens}→${event.outputTokens} tokens${event.reasoningTokens ? ` (${event.reasoningTokens} reasoning)` : ""}${ANSI_RESET}\n`,
        );
      }
      break;
  }
}

/**
 * 显示工具执行结果。
 *
 * @param result - 工具结果块
 */
export function displayToolResult(result: ToolResultBlock): void {
  const status = result.isError ? "❌" : "✅";
  const preview = result.content.slice(0, 100);
  const suffix = result.content.length > 100 ? "…" : "";
  process.stderr.write(`  ${status} ${preview}${suffix}\n`);
}

/**
 * 显示上下文状态栏。
 *
 * 在 stderr 上渲染一个彩色进度条，反映上下文窗口使用率。
 *
 * 颜色：
 *   - 绿色 (<50%)   — 空间充足
 *   - 黄色 (50-79%) — 接近阈值
 *   - 红色 (≥80%)   — 需要压缩
 *
 * @param snapshot - 上下文快照
 */
export function displayContextBar(snapshot: ContextSnapshot): void {
  const pct = Math.round((snapshot.totalUsed / snapshot.budget.windowSize) * 100);
  const barLen = 10;
  const filled = Math.min(Math.floor(pct / 10), barLen);
  const empty = barLen - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const color = pct < 50 ? ANSI_GREEN : pct < 80 ? ANSI_YELLOW : ANSI_RED;
  process.stderr.write(`${color}${bar} ${pct}%${ANSI_RESET}\n`);
}

/**
 * 显示欢迎信息（仅交互模式）。
 */
export function displayWelcome(): void {
  const border = "═".repeat(50);
  process.stderr.write(`\n${border}\n`);
  process.stderr.write(`  agent-harness v0.1.0 — 交互式 AI Agent\n`);
  process.stderr.write(`  Type "exit" or "quit" to exit.\n`);
  process.stderr.write(`${border}\n\n`);
}

/* ════════════════════════════════════════════════════════════════════
   ④ runSingleTurn — 单轮模式
   ════════════════════════════════════════════════════════════════════ */

/**
 * 单轮模式：处理一条消息后退出。
 *
 * 支持两种输出模式：
 *   - 流式输出（默认）：逐字显示 text_delta，最后补换行
 *   - 一次性输出（--no-stream）：arun 返回后 `console.log`
 *
 * @param runtime - Agent 运行时
 * @param message - 用户消息
 * @param options - 可选配置
 */
export async function runSingleTurn(
  runtime: AgentRuntime,
  message: string,
  options?: { noStream?: boolean; verbose?: boolean },
): Promise<void> {
  const text = await arun(
    runtime.provider,
    runtime.catalog,
    message,
    undefined, // transcript
    undefined, // system
    options?.noStream
      ? undefined
      : (event) => displayEvent(event, options?.verbose),
    undefined, // onToolCall
    options?.noStream ? undefined : (result) => displayToolResult(result),
    options?.noStream
      ? undefined
      : (snapshot) => displayContextBar(snapshot),
    runtime.accountant,
    runtime.compactor,
  );

  if (options?.noStream) {
    // 非流式模式：一次性输出完整文本
    process.stdout.write(text + "\n");
  } else {
    // 流式模式已经逐个输出了 text_delta，最后补一个换行
    process.stdout.write("\n");
  }
}

/* ════════════════════════════════════════════════════════════════════
   ⑤ runCLI — 主循环（交互式 REPL / 单轮）
   ════════════════════════════════════════════════════════════════════ */

/**
 * CLI 主循环。
 *
 * - 如果指定了 message → 单轮模式（runSingleTurn）
 * - 否则 → 交互式 REPL（readline 循环）
 *
 * 交互模式支持：
 *   - `>` 提示符，逐行输入
 *   - `exit` / `quit` 退出
 *   - 流式事件实时显示
 *   - 错误处理（不会崩溃）
 *
 * @param runtime - Agent 运行时
 * @param args    - CLI 选项
 */
export async function runCLI(
  runtime: AgentRuntime,
  args: CLIOptions,
): Promise<void> {
  if (args.message) {
    return await runSingleTurn(runtime, args.message, {
      noStream: args.noStream,
      verbose: args.verbose,
    });
  }

  displayWelcome();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }
    if (input === "exit" || input === "quit") {
      break;
    }

    try {
      await arun(
        runtime.provider,
        runtime.catalog,
        input,
        undefined,
        undefined,
        (event) => displayEvent(event, args.verbose),
        undefined,
        (result) => displayToolResult(result),
        (snapshot) => displayContextBar(snapshot),
        runtime.accountant,
        runtime.compactor,
      );

      process.stdout.write("\n");
    } catch (err) {
      process.stderr.write(
        `\n${ANSI_RED}Error:${ANSI_RESET} ${(err as Error).message}\n`,
      );
    }

    rl.prompt();
  }

  rl.close();
  process.stderr.write("bye!\n");
}

/* ════════════════════════════════════════════════════════════════════
   ⑥ main — 主入口
   ════════════════════════════════════════════════════════════════════ */

/**
 * 主入口函数。
 *
 * 流程：
 *   1. 解析 CLI 参数
 *   2. --help / --version 立即返回
 *   3. 位置参数 → message
 *   4. 加载配置（文件 → CLI 覆盖）
 *   5. 创建 AgentRuntime
 *   6. 运行 CLI 循环
 *
 * 退出码约定：
 *   0 — 正常退出
 *   1 — 用户错误（配置错误等）
 *   2 — 系统错误（未预期异常）
 *
 * @param argv - 参数数组（默认 process.argv.slice(2)）
 * @returns 退出码
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  // --version / --help 立即返回
  if (args.version) {
    printVersion();
    return 0;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  // 位置参数等同于 --message（单轮模式）
  if (!args.message && args._positional.length > 0) {
    args.message = args._positional.join(" ");
  }

  try {
    // 构建配置来源列表（后覆盖前）
    const sources: Array<Record<string, unknown>> = [];

    // 1. 指定配置文件（最高优先级文件）
    if (args.config) {
      const fileConfig = loadFromYaml(args.config);
      sources.push(fileConfig as Record<string, unknown>);
    }

    // 2. 自动发现配置文件
    const discovered = discoverConfigFile();
    if (discovered && !args.config) {
      try {
        const fileConfig = loadFromYaml(discovered);
        sources.push(fileConfig as Record<string, unknown>);
      } catch {
        // 静默忽略无效的自动发现配置
      }
    }

    // 3. CLI 参数覆盖（最高优先级）
    const cliArgs: Record<string, string> = {};
    if (args.provider) cliArgs["provider-type"] = args.provider;
    if (args.temperature !== undefined) cliArgs.temperature = String(args.temperature);
    if (Object.keys(cliArgs).length > 0) {
      sources.push(loadFromCli(cliArgs) as Record<string, unknown>);
    }

    // 合并配置
    const config = loadConfig(sources as any);

    // 从配置构建 runtime
    const runtime = await createAgentFromConfig(config);

    // 执行 CLI
    await runCLI(runtime, args);

    return 0;
  } catch (err) {
    const msg = (err as Error).message;
    if (err instanceof Error && (err.name === "ConfigError")) {
      console.error("Error:", msg);
      return 1;
    }
    console.error("Fatal:", msg);
    if (args.verbose) {
      console.error((err as Error).stack);
    }
    return 2;
  }
}

// 直接执行时运行
const isMainModule =
  process.argv[1]?.endsWith("main.ts") ||
  process.argv[1]?.endsWith("main.js");

if (isMainModule) {
  main().catch((err: Error) => {
    console.error("Fatal:", err.message);
    process.exit(2);
  });
}
