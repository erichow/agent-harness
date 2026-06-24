/**
 * UI 交互工具（第 30 章）
 *
 * 6 个工具让 agent 与用户进行结构化交互：
 *   - confirm_action — Y/n 确认对话框
 *   - ask_choice — 方向键多选一（最多 6 项）
 *   - ask_input — 自由文本输入
 *   - show_progress — 进度条显示
 *   - show_diff — diff 预览
 *   - select_file — 文件选择器（带 glob 过滤）
 *
 * 设计原则：
 *   1. 通过 UIProvider 接口解耦 — CLI、TUI、测试均可注入
 *   2. 所有工具都是异步的（await 用户输入）
 *   3. 返回结构化文本结果给 agent，而非原始数据
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogEntry } from "./selector.js";
import type { ToolDefinition } from "./registry.js";

/* ─── UIProvider — 用户交互接口 ────────────────────────────────── */

/**
 * UI 交互提供者。
 *
 * 框架不直接操作 stdin/stdout — 而是通过 UIProvider 接口
 * 请求交互。CLI 模式下用 readline 实现；测试中用 mock 注入。
 */
export interface UIProvider {
  /** 确认对话框 */
  confirm(message: string, details?: string): Promise<boolean>;
  /** 多选一（max 6） */
  choice(question: string, options: Array<{ id: string; title: string }>): Promise<{ id: string; title: string }>;
  /** 自由文本输入 */
  input(message: string, defaultValue?: string): Promise<string>;
  /** 显示进度 */
  showProgress(message: string, current: number, max: number): void;
  /** 显示 diff */
  showDiff(file: string, diff: string, summary?: string): void;
  /** 文件选择 */
  selectFile(prompt: string, glob?: string): Promise<string[]>;
}

/* ─── NoopUIProvider — 兜底实现（用于无交互环境） ──────────────── */

/**
 * 无操作 UI 提供者。
 *
 * 当没有 UI 层接入时使用：
 *   - confirm → false（拒绝所有写操作，安全保守）
 *   - choice → 抛出错误（无法替用户决策）
 *   - input → 抛出错误（无法替用户输入）
 *   - showProgress / showDiff → 静默丢弃
 *   - selectFile → 抛出错误（无法替用户选择）
 *
 * 这确保 agent 在无交互环境中不会"卡住"等待用户输入。
 */
export class NoopUIProvider implements UIProvider {
  confirm(_message: string, _details?: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  choice(_question: string, _options: Array<{ id: string; title: string }>): Promise<{ id: string; title: string }> {
    return Promise.reject(new Error("No UI provider available — cannot present choices"));
  }

  input(_message: string, _defaultValue?: string): Promise<string> {
    return Promise.reject(new Error("No UI provider available — cannot accept input"));
  }

  showProgress(_message: string, _current: number, _max: number): void {
    // 静默丢弃
  }

  showDiff(_file: string, _diff: string, _summary?: string): void {
    // 静默丢弃
  }

  selectFile(_prompt: string, _glob?: string): Promise<string[]> {
    return Promise.reject(new Error("No UI provider available — cannot select files"));
  }
}

/* ─── createUITools ──────────────────────────────────────────────── */

/**
 * 创建 6 个 UI 交互工具的 CatalogEntry 数组。
 *
 * @param ui - UI 提供者（默认 NoopUIProvider 拒绝所有交互）
 * @returns CatalogEntry[]
 */
export function createUITools(ui?: UIProvider): CatalogEntry[] {
  const provider = ui ?? new NoopUIProvider();
  const tools: CatalogEntry[] = [];

  /* ─── confirm_action ─────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "confirm_action",
      description:
        "Ask the user to confirm an action. " +
        "Use before destructive or irreversible operations. " +
        "message: what you're asking confirmation for. " +
        "details: optional additional context. " +
        "Returns '[confirmed]' if the user approved, or '[cancelled by user]' if they declined. " +
        "Side effects: pauses for user input. Only use when you need a human decision.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Confirmation question",
          },
          details: {
            type: "string",
            description: "Additional context for the confirmation",
          },
        },
        required: ["message"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const message = String(args.message);
      const details = args.details !== undefined ? String(args.details) : undefined;
      const confirmed = await provider.confirm(message, details);
      return confirmed ? "[confirmed]" : "[cancelled by user]";
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── ask_choice ──────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "ask_choice",
      description:
        "Present the user with multiple choices. " +
        "Returns the user's selection. " +
        "Use when you need the user to decide between options. " +
        "question: what you're asking. options: array of {id, title}. " +
        "Options are displayed as a numbered list for the user to pick from. " +
        "Maximum 6 options. " +
        "Side effects: pauses for user input.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user",
          },
          options: {
            type: "array",
            description: "Array of options the user can choose from (max 6)",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique identifier for this option" },
                title: { type: "string", description: "Display title for this option" },
              },
              required: ["id", "title"],
            },
          },
        },
        required: ["question", "options"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const question = String(args.question);
      const rawOptions = args.options;

      if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
        return "[ask_choice: no options provided]";
      }

      const options: Array<{ id: string; title: string }> = rawOptions.map((opt: any) => ({
        id: String(opt.id ?? ""),
        title: String(opt.title ?? ""),
      }));

      if (options.length > 6) {
        return `[ask_choice: too many options (${options.length}, max 6)]`;
      }

      const selected = await provider.choice(question, options);
      return `[selected: ${selected.id}] ${selected.title}`;
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── ask_input ──────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "ask_input",
      description:
        "Ask the user for free-form text input. " +
        "Use when you need additional information from the user. " +
        "message: what you're asking for. " +
        "defaultValue: optional default value if the user provides empty input. " +
        "Returns the text the user entered. " +
        "Side effects: pauses for user input.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Prompt message describing what input is needed",
          },
          defaultValue: {
            type: "string",
            description: "Optional default value",
          },
        },
        required: ["message"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const message = String(args.message);
      const defaultValue = args.defaultValue !== undefined ? String(args.defaultValue) : undefined;
      const text = await provider.input(message, defaultValue);
      return text;
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── show_progress ───────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "show_progress",
      description:
        "Display a progress indicator for a long-running task. " +
        "message: what's happening. " +
        "current: current step number. " +
        "max: total steps. " +
        "Call this periodically during long operations to keep the user informed. " +
        "Side effects: displays to the user (no blocking).",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Description of what's happening",
          },
          current: {
            type: "number",
            description: "Current step (0-based or 1-based)",
          },
          max: {
            type: "number",
            description: "Total steps",
          },
        },
        required: ["message"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const message = String(args.message);
      const current = args.current !== undefined ? Number(args.current) : 0;
      const max = args.max !== undefined ? Number(args.max) : 0;

      provider.showProgress(message, current, max);
      return max > 0 ? `[progress: ${current}/${max}]` : `[progress: ${message}]`;
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── show_diff ───────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "show_diff",
      description:
        "Show a diff preview to the user. " +
        "file: the file that was changed. " +
        "diff: the diff content. " +
        "summary: optional one-line summary of the change. " +
        "Use before a commit or push to let the user review changes. " +
        "Side effects: displays to the user (no blocking).",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Path of the changed file",
          },
          diff: {
            type: "string",
            description: "Diff content to display",
          },
          summary: {
            type: "string",
            description: "Optional one-line summary of the change",
          },
        },
        required: ["file", "diff"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const file = String(args.file);
      const diff = String(args.diff);
      const summary = args.summary !== undefined ? String(args.summary) : undefined;

      provider.showDiff(file, diff, summary);
      return `[diff shown for ${file}]`;
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── select_file ─────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "select_file",
      description:
        "Ask the user to select one or more files. " +
        "prompt: description of what files are needed for. " +
        "glob: optional filter pattern (e.g. 'src/**/*.ts' or '*.md'). " +
        "Returns a comma-separated list of selected file paths. " +
        "Use when you need the user to specify which files to work on. " +
        "Side effects: pauses for user input.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What the files are needed for",
          },
          glob: {
            type: "string",
            description: "Optional glob filter pattern for file selection",
          },
        },
        required: ["prompt"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const prompt = String(args.prompt);
      const globPattern = args.glob !== undefined ? String(args.glob) : undefined;

      const selected = await provider.selectFile(prompt, globPattern);
      if (selected.length === 0) {
        return "[select_file: no files selected]";
      }
      return `[selected files: ${selected.join(", ")}]`;
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  return tools;
}
