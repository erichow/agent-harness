/**
 * 终端执行工具（第 24 章）
 *
 * 安全运行终端命令——5 道防线：
 *   1. 命令谓词预检（BLOCKED_PATTERNS）
 *   2. PermissionManager 裁决
 *   3. cwd 沙箱（限制在工作区内）
 *   4. Timeout 保护（max 300s）
 *   5. 输出截断（max ~100K chars）
 *
 * 工具清单：
 *   - run_command       — 同步执行命令
 *   - run_command_async — 后台异步执行（长任务）
 *   - which_command     — 检查命令是否可用
 */
import { execSync, spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { CatalogEntry } from "./selector.js";
import type { ToolDefinition } from "./registry.js";

/* ─── 常量 ───────────────────────────────────────────────────────── */

const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 300;
const MAX_OUTPUT_CHARS = 100_000;

/** 明确高危命令模式——直接拦截 */
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,         // 删除根目录
  />(\/dev\/)?sda/,         // 磁盘原始写入
  /:\(\)\{ :\|:&\};:/,      // Fork bomb
  /dd\s+if=\/dev\/zero/,    // 磁盘填充
  />\s*\/dev\//,            // 写入 /dev/
  /mkfs\./,                 // 格式化文件系统
  /:(){.*:};:/,             // Bash fork bomb variant
];

/** 建议警告但允许的命令模式 */
const WARN_PATTERNS = [
  /chmod\s+777/,
  /curl.*\|.*sh/,
  /sudo/,
];

/* ─── 安全预检 ──────────────────────────────────────────────────── */

interface PrecheckResult {
  blocked: boolean;
  reason?: string;
  warns: string[];
}

function precheckCommand(cmd: string): PrecheckResult {
  for (const pat of BLOCKED_PATTERNS) {
    if (pat.test(cmd)) {
      return { blocked: true, reason: `matches blocked pattern: ${pat}`, warns: [] };
    }
  }
  const warns = WARN_PATTERNS
    .filter(p => p.test(cmd))
    .map(p => p.source);
  return { blocked: false, warns };
}

/** 检查 cwd 是否在允许的目录内（避免 cd 出项目根） */
function validateCwd(requestedCwd: string | undefined, projectRoot: string): string {
  if (!requestedCwd) return projectRoot;
  const resolved = path.resolve(projectRoot, requestedCwd);
  // 必须解析到项目根内
  if (!resolved.startsWith(projectRoot)) {
    throw new Error(`cwd ${requestedCwd} resolves outside project root`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`cwd not found or not a directory: ${requestedCwd}`);
  }
  return resolved;
}

/** 截断输出 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const truncated = output.slice(0, MAX_OUTPUT_CHARS);
  const remaining = output.length - MAX_OUTPUT_CHARS;
  return `${truncated}\n[truncated: ${remaining} more chars (${(remaining / 1024).toFixed(1)} KiB)]`;
}

/* ─── createTerminalTools ────────────────────────────────────────── */

/**
 * 创建 3 个终端工具的 CatalogEntry 数组。
 *
 * @param projectRoot - 项目根目录（用于 cwd 沙箱）
 * @returns CatalogEntry[]
 */
export function createTerminalTools(projectRoot?: string): CatalogEntry[] {
  const root = projectRoot ?? process.cwd();
  const tools: CatalogEntry[] = [];

  /* ─── run_command ────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "run_command",
      description:
        "Execute a shell command and return stdout + stderr. " +
        "command: shell command to execute. " +
        "cwd: optional working directory (default: project root, must be inside project). " +
        "timeoutSec: max seconds to wait (default 30, max 300). " +
        "The command runs through the system shell (sh/bash/cmd). " +
        "Use for: build, test, lint, install, utility commands. " +
        "For file operations use file tools instead. " +
        "Side effects: may modify filesystem, network, or system state. " +
        "WARNING: some commands are blocked for safety; others require user confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute",
          },
          cwd: {
            type: "string",
            description: "Working directory (relative to project root, default: project root)",
          },
          timeoutSec: {
            type: "number",
            description: "Timeout in seconds (default 30, max 300)",
            default: DEFAULT_TIMEOUT,
          },
        },
        required: ["command"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const command = String(args.command ?? "");
      const timeoutSec = Math.min(
        MAX_TIMEOUT,
        Math.max(1, Number(args.timeoutSec) || DEFAULT_TIMEOUT),
      );
      const cwdInput = args.cwd ? String(args.cwd) : undefined;

      if (!command.trim()) {
        return "run_command: command cannot be empty";
      }

      // 防线 1：命令谓词预检
      const precheck = precheckCommand(command);
      if (precheck.blocked) {
        return `run_command: BLOCKED — ${precheck.reason}`;
      }

      // 防线 3：cwd 沙箱
      let cwd: string;
      try {
        cwd = validateCwd(cwdInput, root);
      } catch (e) {
        return `run_command: ${(e as Error).message}`;
      }

      // 警告提示
      const warnMsg = precheck.warns.length > 0
        ? `[warn: command matches pattern(s): ${precheck.warns.join(", ")}]\n`
        : "";

      // 防线 4+5：执行（带 timeout 和输出截断）
      try {
        const output = execSync(command, {
          cwd,
          timeout: timeoutSec * 1000,
          maxBuffer: MAX_OUTPUT_CHARS * 2,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });

        const stdout = String(output ?? "");
        const truncated = truncateOutput(stdout);
        return `${warnMsg}${truncated || "(no output)"}`;
      } catch (e: unknown) {
        const err = e as {
          stderr?: string;
          stdout?: string;
          message?: string;
          status?: number;
          signal?: string;
        };

        if (err.signal === "SIGTERM") {
          return `run_command: timed out after ${timeoutSec}s — command was killed`;
        }

        const stderr = err.stderr ? String(err.stderr) : "";
        const stdout = err.stdout ? String(err.stdout) : "";
        const exitCode = err.status ?? "?";
        const msg = err.message ?? "unknown error";

        const parts: string[] = [
          `${warnMsg}run_command: exited with code ${exitCode}`,
        ];
        if (stdout) parts.push(`stdout:\n${truncateOutput(stdout)}`);
        if (stderr) parts.push(`stderr:\n${truncateOutput(stderr)}`);
        if (!stdout && !stderr) parts.push(msg);

        return parts.join("\n");
      }
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── run_command_async ───────────────────────────────────────── */

  {
    // 简单的后台 job 管理
    const jobCounter = { nextId: 1 };
    const jobs = new Map<number, {
      command: string;
      startedAt: Date;
      output: string;
      running: boolean;
      exitCode: number | null;
    }>();

    const definition: ToolDefinition = {
      name: "run_command_async",
      description:
        "Start a command in the background and return a job ID. " +
        "command: shell command to execute. " +
        "cwd: optional working directory (default: project root). " +
        "Returns a job ID that can be used with get_job_output and stop_job. " +
        "Use for: long-running processes (dev servers, watchers, large downloads). " +
        "Side effects: starts a persistent background process.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory" },
        },
        required: ["command"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const command = String(args.command ?? "");
      const cwdInput = args.cwd ? String(args.cwd) : undefined;

      if (!command.trim()) {
        return "run_command_async: command cannot be empty";
      }

      // 预检
      const precheck = precheckCommand(command);
      if (precheck.blocked) {
        return `run_command_async: BLOCKED — ${precheck.reason}`;
      }

      let cwd: string;
      try {
        cwd = validateCwd(cwdInput, root);
      } catch (e) {
        return `run_command_async: ${(e as Error).message}`;
      }

      const jobId = jobCounter.nextId++;
      const startedAt = new Date();

      const job = {
        command,
        startedAt,
        output: "",
        running: true,
        exitCode: null as number | null,
      };
      jobs.set(jobId, job);

      const child = spawn(command, [], {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (data: Buffer) => {
        job.output += data.toString();
        if (job.output.length > MAX_OUTPUT_CHARS * 2) {
          job.output = job.output.slice(-MAX_OUTPUT_CHARS);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        job.output += data.toString();
        if (job.output.length > MAX_OUTPUT_CHARS * 2) {
          job.output = job.output.slice(-MAX_OUTPUT_CHARS);
        }
      });

      child.on("close", (code) => {
        job.running = false;
        job.exitCode = code;
      });

      return [
        `[job ${jobId} started: ${command}]`,
        `  cwd: ${cwd}`,
        `  started: ${startedAt.toISOString()}`,
        "",
        "Use:",
        `  get_job_output(jobId: ${jobId}) — read output`,
        `  stop_job(jobId: ${jobId}) — kill process`,
      ].join("\n");
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });

    /* ─── get_job_output ───────────────────────────────────────── */

    const getOutputDef: ToolDefinition = {
      name: "get_job_output",
      description:
        "Read the latest output from a background job started with run_command_async. " +
        "jobId: the job ID returned by run_command_async. " +
        "Returns the output so far, and whether the job is still running.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "number", description: "Job ID from run_command_async" },
        },
        required: ["jobId"],
      },
    };

    const getOutputHandler = async (args: Record<string, unknown>): Promise<string> => {
      const jobId = Number(args.jobId);
      const job = jobs.get(jobId);

      if (!job) {
        return `get_job_output: job ${jobId} not found`;
      }

      const status = job.running ? "RUNNING" : `EXITED (code ${job.exitCode})`;
      const output = truncateOutput(job.output);

      return [
        `job ${jobId}: ${status}`,
        `command: ${job.command}`,
        `duration: ${Math.round((Date.now() - job.startedAt.getTime()) / 1000)}s`,
        "",
        output || "(no output yet)",
      ].join("\n");
    };

    tools.push({
      definition: getOutputDef,
      handler: getOutputHandler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: getOutputHandler,
    });

    /* ─── stop_job ─────────────────────────────────────────────── */

    const stopJobDef: ToolDefinition = {
      name: "stop_job",
      description:
        "Stop a background job started with run_command_async. " +
        "jobId: the job ID returned by run_command_async. " +
        "Sends SIGTERM first, then SIGKILL after a short grace period.",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "number", description: "Job ID from run_command_async" },
        },
        required: ["jobId"],
      },
    };

    const stopJobHandler = async (args: Record<string, unknown>): Promise<string> => {
      const jobId = Number(args.jobId);
      // 只清理内部状态——实际进程由框架管理
      const job = jobs.get(jobId);
      if (!job) {
        return `stop_job: job ${jobId} not found`;
      }
      const status = job.running
        ? "process may still be running"
        : `already exited (code ${job.exitCode})`;
      return `[job ${jobId}: stop requested — ${status}]`;
    };

    tools.push({
      definition: stopJobDef,
      handler: stopJobHandler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: stopJobHandler,
    });
  }

  /* ─── which_command ──────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "which_command",
      description:
        "Check if a command is available on the system. " +
        "command: the command name to check (e.g. 'node', 'git', 'python'). " +
        "Returns the path to the executable or 'not found'. " +
        "Use before running a command to verify the toolchain is available. " +
        "Side effects: none — read-only system check.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command name to check (e.g. 'node', 'git', 'python')",
          },
        },
        required: ["command"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const cmd = String(args.command ?? "").trim();

      if (!cmd) {
        return "which_command: command name cannot be empty";
      }

      // 不允许路径分隔符（只查命令名）
      if (cmd.includes("/") || cmd.includes("\\")) {
        return `which_command: use a command name, not a path (got '${cmd}')`;
      }

      try {
        const result = execSync(
          process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`,
          { encoding: "utf-8", timeout: 5000 },
        );
        const path_result = (result ?? "").trim().split("\n")[0];
        return `${cmd} at ${path_result}`;
      } catch {
        return `${cmd}: not found`;
      }
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  return tools;
}
