/**
 * 第 30 章测试 — UI 交互工具
 *
 * 覆盖：
 *   1. createUITools 返回 6 个工具
 *   2. confirm_action — 确认/拒绝/缺少必填参数
 *   3. ask_choice — 选择/超限/无选项
 *   4. ask_input — 有/无默认值
 *   5. show_progress — 正常/极简
 *   6. show_diff — 正常/无摘要
 *   7. select_file — 有/无 glob/空结果
 *   8. NoopUIProvider — 默认行为
 *   9. UIProvider 接口验证 — 所有调用被记录
 *   10. ToolRegistry 集成 — 同步/异步注册
 *   11. UIProvider 自定义行为
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createUITools,
  NoopUIProvider,
  type UIProvider,
} from "../src/harness/tools/ui.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

/* ─── MockUIProvider — 可编程的测试 UI 提供者 ──────────────────── */

class MockUIProvider implements UIProvider {
  readonly confirmCalls: Array<{ message: string; details?: string }> = [];
  readonly choiceCalls: Array<{
    question: string;
    options: Array<{ id: string; title: string }>;
  }> = [];
  readonly inputCalls: Array<{ message: string; defaultValue?: string }> = [];
  readonly progressCalls: Array<{
    message: string;
    current: number;
    max: number;
  }> = [];
  readonly diffCalls: Array<{ file: string; diff: string; summary?: string }> = [];
  readonly selectFileCalls: Array<{ prompt: string; glob?: string }> = [];

  private _confirmed: boolean;
  private _choiceIndex: number;
  private _inputText: string;
  private _selectedFiles: string[];

  constructor(opts?: {
    confirmed?: boolean;
    choiceIndex?: number;
    inputText?: string;
    selectedFiles?: string[];
  }) {
    this._confirmed = opts?.confirmed ?? true;
    this._choiceIndex = opts?.choiceIndex ?? 0;
    this._inputText = opts?.inputText ?? "test input";
    this._selectedFiles = opts?.selectedFiles ?? [];
  }

  async confirm(message: string, details?: string): Promise<boolean> {
    this.confirmCalls.push({ message, details });
    return this._confirmed;
  }

  async choice(
    question: string,
    options: Array<{ id: string; title: string }>,
  ): Promise<{ id: string; title: string }> {
    this.choiceCalls.push({ question, options });
    const idx = Math.min(this._choiceIndex, options.length - 1);
    return options[idx];
  }

  async input(message: string, defaultValue?: string): Promise<string> {
    this.inputCalls.push({ message, defaultValue });
    return this._inputText;
  }

  showProgress(message: string, current: number, max: number): void {
    this.progressCalls.push({ message, current, max });
  }

  showDiff(file: string, diff: string, summary?: string): void {
    this.diffCalls.push({ file, diff, summary });
  }

  async selectFile(prompt: string, glob?: string): Promise<string[]> {
    this.selectFileCalls.push({ prompt, glob });
    return this._selectedFiles;
  }
}

/* ─── Helper：用 MockUIProvider 创建已注册工具的 ToolRegistry ──── */

function createMockRegistry(opts?: {
  confirmed?: boolean;
  choiceIndex?: number;
  inputText?: string;
  selectedFiles?: string[];
}): { registry: ToolRegistry; mockUI: MockUIProvider } {
  const mockUI = new MockUIProvider(opts);
  const tools = createUITools(mockUI);
  const registry = new ToolRegistry();
  for (const entry of tools) {
    registry.aregister(entry.definition, entry.asyncHandler!);
  }
  return { registry, mockUI };
}

describe("第30章 · UI 交互工具", () => {
  /* ── 1. createUITools ────────────────────────────────────────── */

  describe("createUITools", () => {
    it("应返回 6 个工具", () => {
      const tools = createUITools();
      expect(tools).toHaveLength(6);
    });

    it("应包含所有 6 个工具名", () => {
      const tools = createUITools();
      const names = tools.map((t) => t.definition.name).sort();
      expect(names).toEqual([
        "ask_choice",
        "ask_input",
        "confirm_action",
        "select_file",
        "show_diff",
        "show_progress",
      ]);
    });

    it("默认使用 NoopUIProvider（confirm 返回 false）", async () => {
      const tools = createUITools();
      const registry = new ToolRegistry();
      for (const entry of tools) {
        registry.aregister(entry.definition, entry.asyncHandler!);
      }
      const result = await registry.executeAsync("confirm_action", {
        message: "test",
      }, "call-1");
      expect(result.content).toBe("[cancelled by user]");
    });
  });

  /* ── 2. confirm_action ───────────────────────────────────────── */

  describe("confirm_action", () => {
    it("用户确认应返回 [confirmed]", async () => {
      const { registry } = createMockRegistry({ confirmed: true });
      const result = await registry.executeAsync("confirm_action", {
        message: "确认删除文件？",
      }, "call-1");
      expect(result.content).toBe("[confirmed]");
    });

    it("用户拒绝应返回 [cancelled by user]", async () => {
      const { registry } = createMockRegistry({ confirmed: false });
      const result = await registry.executeAsync("confirm_action", {
        message: "确认删除文件？",
      }, "call-2");
      expect(result.content).toBe("[cancelled by user]");
    });

    it("应传递 details 参数给 UIProvider", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("confirm_action", {
        message: "确认操作",
        details: "这是一个危险操作",
      }, "call-3");
      expect(mockUI.confirmCalls[0].message).toBe("确认操作");
      expect(mockUI.confirmCalls[0].details).toBe("这是一个危险操作");
    });

    it("details 可选 — 不传时应为 undefined", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("confirm_action", {
        message: "确认操作",
      }, "call-4");
      expect(mockUI.confirmCalls[0].details).toBeUndefined();
    });

    it("缺少 message 时应报校验错误", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("confirm_action", {}, "call-5");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("invalid arguments");
    });
  });

  /* ── 3. ask_choice ───────────────────────────────────────────── */

  describe("ask_choice", () => {
    it("应返回用户选择的选项", async () => {
      const { registry } = createMockRegistry({ choiceIndex: 1 });
      const result = await registry.executeAsync("ask_choice", {
        question: "选择修复方案",
        options: [
          { id: "A", title: "重命名" },
          { id: "B", title: "重构" },
          { id: "C", title: "忽略" },
        ],
      }, "call-1");
      // choiceIndex=1 → 选 B
      expect(result.content).toContain("B");
      expect(result.content).toContain("重构");
    });

    it("选择第一个选项当 choiceIndex=0", async () => {
      const { registry } = createMockRegistry({ choiceIndex: 0 });
      const result = await registry.executeAsync("ask_choice", {
        question: "选择方案",
        options: [
          { id: "alpha", title: "方案 Alpha" },
          { id: "beta", title: "方案 Beta" },
        ],
      }, "call-2");
      expect(result.content).toContain("alpha");
      expect(result.content).toContain("方案 Alpha");
    });

    it("选择最后一个选项当 choiceIndex 超限", async () => {
      const { registry } = createMockRegistry({ choiceIndex: 99 });
      const result = await registry.executeAsync("ask_choice", {
        question: "选择",
        options: [
          { id: "x", title: "X" },
          { id: "y", title: "Y" },
        ],
      }, "call-3");
      expect(result.content).toContain("y");
    });

    it("超过 6 个选项应报错", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("ask_choice", {
        question: "选择",
        options: [
          { id: "1", title: "一" },
          { id: "2", title: "二" },
          { id: "3", title: "三" },
          { id: "4", title: "四" },
          { id: "5", title: "五" },
          { id: "6", title: "六" },
          { id: "7", title: "七" },
        ],
      }, "call-4");
      expect(result.content).toContain("too many options");
    });

    it("空选项应报错", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("ask_choice", {
        question: "选择",
        options: [],
      }, "call-5");
      expect(result.content).toContain("no options provided");
    });

    it("应传递 question 和 options 给 UIProvider", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("ask_choice", {
        question: "如何修复？",
        options: [
          { id: "A", title: "方案 A" },
          { id: "B", title: "方案 B" },
        ],
      }, "call-6");
      expect(mockUI.choiceCalls[0].question).toBe("如何修复？");
      expect(mockUI.choiceCalls[0].options).toHaveLength(2);
      expect(mockUI.choiceCalls[0].options[0].id).toBe("A");
      expect(mockUI.choiceCalls[0].options[1].title).toBe("方案 B");
    });
  });

  /* ── 4. ask_input ────────────────────────────────────────────── */

  describe("ask_input", () => {
    it("应返回用户输入的文本", async () => {
      const { registry } = createMockRegistry({ inputText: "用户自定义输入" });
      const result = await registry.executeAsync("ask_input", {
        message: "请输入 commit 消息",
      }, "call-1");
      expect(result.content).toBe("用户自定义输入");
    });

    it("应传递 defaultValue 给 UIProvider", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("ask_input", {
        message: "请输入名称",
        defaultValue: "default name",
      }, "call-2");
      expect(mockUI.inputCalls[0].defaultValue).toBe("default name");
      expect(mockUI.inputCalls[0].message).toBe("请输入名称");
    });

    it("不传 defaultValue 时 provider 收到 undefined", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("ask_input", {
        message: "请输入",
      }, "call-3");
      expect(mockUI.inputCalls[0].defaultValue).toBeUndefined();
    });

    it("缺少 message 时应报校验错误", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("ask_input", {}, "call-4");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("invalid arguments");
    });
  });

  /* ── 5. show_progress ────────────────────────────────────────── */

  describe("show_progress", () => {
    it("应返回进度状态字符串", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("show_progress", {
        message: "分析文件中...",
        current: 2,
        max: 10,
      }, "call-1");
      expect(result.content).toBe("[progress: 2/10]");
    });

    it("应调用 UIProvider.showProgress", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("show_progress", {
        message: "编译中",
        current: 3,
        max: 5,
      }, "call-2");
      expect(mockUI.progressCalls[0].message).toBe("编译中");
      expect(mockUI.progressCalls[0].current).toBe(3);
      expect(mockUI.progressCalls[0].max).toBe(5);
    });

    it("不传 current/max 时默认 0", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("show_progress", {
        message: "处理中",
      }, "call-3");
      expect(result.content).toBe("[progress: 处理中]");
    });

    it("进度消息只传 message 也正常工作", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("show_progress", {
        message: "thinking...",
        current: 0,
        max: 0,
      }, "call-4");
      expect(result.content).toBe("[progress: thinking...]");
    });
  });

  /* ── 6. show_diff ────────────────────────────────────────────── */

  describe("show_diff", () => {
    const sampleDiff = `--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;`;

    it("应返回 diff 已显示的确认", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("show_diff", {
        file: "src/main.ts",
        diff: sampleDiff,
      }, "call-1");
      expect(result.content).toContain("src/main.ts");
    });

    it("应调用 UIProvider.showDiff", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("show_diff", {
        file: "src/main.ts",
        diff: sampleDiff,
        summary: "修改变量声明",
      }, "call-2");
      expect(mockUI.diffCalls[0].file).toBe("src/main.ts");
      expect(mockUI.diffCalls[0].diff).toBe(sampleDiff);
      expect(mockUI.diffCalls[0].summary).toBe("修改变量声明");
    });

    it("summary 可选", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("show_diff", {
        file: "test.ts",
        diff: sampleDiff,
      }, "call-3");
      expect(mockUI.diffCalls[0].summary).toBeUndefined();
    });

    it("缺少 file 时应报校验错误", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("show_diff", {
        diff: sampleDiff,
      }, "call-4");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("invalid arguments");
    });

    it("缺少 diff 时应报校验错误", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("show_diff", {
        file: "test.ts",
      }, "call-5");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("invalid arguments");
    });
  });

  /* ── 7. select_file ──────────────────────────────────────────── */

  describe("select_file", () => {
    it("应返回选中的文件列表", async () => {
      const { registry } = createMockRegistry({
        selectedFiles: ["src/a.ts", "src/b.ts"],
      });
      const result = await registry.executeAsync("select_file", {
        prompt: "选择要分析的文件",
      }, "call-1");
      expect(result.content).toContain("src/a.ts");
      expect(result.content).toContain("src/b.ts");
    });

    it("应传递 glob 给 UIProvider", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("select_file", {
        prompt: "选择 TypeScript 文件",
        glob: "src/**/*.ts",
      }, "call-2");
      expect(mockUI.selectFileCalls[0].prompt).toBe("选择 TypeScript 文件");
      expect(mockUI.selectFileCalls[0].glob).toBe("src/**/*.ts");
    });

    it("不传 glob 时 provider 收到 undefined", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("select_file", {
        prompt: "选文件",
      }, "call-3");
      expect(mockUI.selectFileCalls[0].glob).toBeUndefined();
    });

    it("无选中文件应返回提示", async () => {
      const { registry } = createMockRegistry({ selectedFiles: [] });
      const result = await registry.executeAsync("select_file", {
        prompt: "选择要删除的文件",
      }, "call-4");
      expect(result.content).toBe("[select_file: no files selected]");
    });

    it("缺少 prompt 时应报校验错误", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("select_file", {}, "call-5");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("invalid arguments");
    });
  });

  /* ── 8. NoopUIProvider ──────────────────────────────────────────── */

  describe("NoopUIProvider", () => {
    it("confirm 应返回 false（安全保守）", async () => {
      const provider = new NoopUIProvider();
      const result = await provider.confirm("删除文件？");
      expect(result).toBe(false);
    });

    it("choice 应拒绝（抛出错误）", async () => {
      const provider = new NoopUIProvider();
      await expect(
        provider.choice("选择", [{ id: "A", title: "A" }]),
      ).rejects.toThrow("No UI provider available");
    });

    it("input 应拒绝（抛出错误）", async () => {
      const provider = new NoopUIProvider();
      await expect(
        provider.input("输入内容"),
      ).rejects.toThrow("No UI provider available");
    });

    it("showProgress 应静默丢弃（不抛错）", () => {
      const provider = new NoopUIProvider();
      expect(() => {
        provider.showProgress("加载中", 1, 10);
      }).not.toThrow();
    });

    it("showDiff 应静默丢弃（不抛错）", () => {
      const provider = new NoopUIProvider();
      expect(() => {
        provider.showDiff("test.ts", "diff content");
      }).not.toThrow();
    });

    it("selectFile 应拒绝（抛出错误）", async () => {
      const provider = new NoopUIProvider();
      await expect(
        provider.selectFile("选择文件"),
      ).rejects.toThrow("No UI provider available");
    });
  });

  /* ── 9. UIProvider 调用记录 ──────────────────────────────────── */

  describe("UIProvider 调用记录", () => {
    it("每次 confirm_action 应记录到 confirmCalls", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("confirm_action", {
        message: "确认 A",
      }, "call-1");
      await registry.executeAsync("confirm_action", {
        message: "确认 B",
      }, "call-2");
      expect(mockUI.confirmCalls).toHaveLength(2);
      expect(mockUI.confirmCalls[0].message).toBe("确认 A");
      expect(mockUI.confirmCalls[1].message).toBe("确认 B");
    });

    it("每次 ask_choice 应记录到 choiceCalls", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("ask_choice", {
        question: "Q1",
        options: [{ id: "a", title: "A" }],
      }, "call-1");
      await registry.executeAsync("ask_choice", {
        question: "Q2",
        options: [{ id: "b", title: "B" }],
      }, "call-2");
      expect(mockUI.choiceCalls).toHaveLength(2);
      expect(mockUI.choiceCalls[0].question).toBe("Q1");
      expect(mockUI.choiceCalls[1].question).toBe("Q2");
    });

    it("每调用一次 show_progress 应记录一次", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("show_progress", {
        message: "step 1",
        current: 1,
        max: 3,
      }, "call-1");
      await registry.executeAsync("show_progress", {
        message: "step 2",
        current: 2,
        max: 3,
      }, "call-2");
      await registry.executeAsync("show_progress", {
        message: "step 3",
        current: 3,
        max: 3,
      }, "call-3");
      expect(mockUI.progressCalls).toHaveLength(3);
    });
  });

  /* ── 10. ToolRegistry 集成 ───────────────────────────────────── */

  describe("ToolRegistry 集成", () => {
    it("所有 UI 工具应可通过 aregister 注册", async () => {
      const mockUI = new MockUIProvider();
      const tools = createUITools(mockUI);
      const registry = new ToolRegistry();

      for (const entry of tools) {
        registry.aregister(entry.definition, entry.asyncHandler!);
      }

      expect(registry.list()).toHaveLength(6);
      expect(registry.has("confirm_action")).toBe(true);
      expect(registry.has("ask_choice")).toBe(true);
      expect(registry.has("ask_input")).toBe(true);
      expect(registry.has("show_progress")).toBe(true);
      expect(registry.has("show_diff")).toBe(true);
      expect(registry.has("select_file")).toBe(true);
    });

    it("通过 executeAsync 应能正确调用所有工具", async () => {
      const { registry } = createMockRegistry({
        confirmed: true,
        choiceIndex: 0,
        inputText: "test",
        selectedFiles: ["f1.ts"],
      });

      const confirm = await registry.executeAsync("confirm_action", {
        message: "test",
      }, "cid-1");
      expect(confirm.isError).toBe(false);

      const choice = await registry.executeAsync("ask_choice", {
        question: "q",
        options: [{ id: "x", title: "X" }],
      }, "cid-2");
      expect(choice.isError).toBe(false);

      const input = await registry.executeAsync("ask_input", {
        message: "m",
      }, "cid-3");
      expect(input.isError).toBe(false);

      const progress = await registry.executeAsync("show_progress", {
        message: "p",
        current: 1,
        max: 5,
      }, "cid-4");
      expect(progress.isError).toBe(false);

      const diff = await registry.executeAsync("show_diff", {
        file: "f.ts",
        diff: "diff",
      }, "cid-5");
      expect(diff.isError).toBe(false);

      const select = await registry.executeAsync("select_file", {
        prompt: "s",
      }, "cid-6");
      expect(select.isError).toBe(false);

      // 全部 6 个成功
      expect(confirm.content).toBe("[confirmed]");
      expect(choice.content).toContain("x");
      expect(input.content).toBe("test");
      expect(progress.content).toBe("[progress: 1/5]");
      expect(diff.content).toContain("[diff shown for f.ts]");
      expect(select.content).toContain("f1.ts");
    });

    it("未知工具名应走 registry 的 unknown tool 路径", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("nonexistent_ui_tool", {
        message: "test",
      }, "call-unknown");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("unknown tool");
    });
  });

  /* ── 11. UIProvider 自定义行为 ───────────────────────────────── */

  describe("UIProvider 自定义行为", () => {
    it("可自定义确认返回值", async () => {
      const provider = new MockUIProvider({ confirmed: false });
      expect(await provider.confirm("test")).toBe(false);

      const provider2 = new MockUIProvider({ confirmed: true });
      expect(await provider2.confirm("test")).toBe(true);
    });

    it("可自定义选择索引", async () => {
      const options = [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Beta" },
        { id: "c", title: "Gamma" },
      ];

      const provider = new MockUIProvider({ choiceIndex: 2 });
      const result = await provider.choice("test", options);
      expect(result.id).toBe("c");
      expect(result.title).toBe("Gamma");
    });

    it("可自定义输入文本", async () => {
      const provider = new MockUIProvider({ inputText: "custom input" });
      expect(await provider.input("test")).toBe("custom input");
    });

    it("可自定义选中文件列表", async () => {
      const provider = new MockUIProvider({
        selectedFiles: ["/path/to/a.ts", "/path/to/b.ts"],
      });
      const files = await provider.selectFile("test");
      expect(files).toEqual(["/path/to/a.ts", "/path/to/b.ts"]);
    });

    it("多个 MockUIProvider 实例互不干扰", async () => {
      const p1 = new MockUIProvider({ inputText: "p1 input" });
      const p2 = new MockUIProvider({ inputText: "p2 input" });

      const r1 = await p1.input("test");
      const r2 = await p2.input("test");

      expect(r1).toBe("p1 input");
      expect(r2).toBe("p2 input");

      // 各自的调用记录独立
      expect(p1.inputCalls).toHaveLength(1);
      expect(p2.inputCalls).toHaveLength(1);
    });
  });

  /* ── 12. 边界情况 ──────────────────────────────────────────────── */

  describe("边界情况", () => {
    it("confirm_action 的 details 支持空字符串", async () => {
      const { registry } = createMockRegistry();
      const result = await registry.executeAsync("confirm_action", {
        message: "确认？",
        details: "",
      }, "call-1");
      expect(result.content).toBe("[confirmed]");
    });

    it("ask_choice 的 options 中缺少 id 或 title 应安全处理", async () => {
      const { registry } = createMockRegistry({ choiceIndex: 0 });
      const result = await registry.executeAsync("ask_choice", {
        question: "选择",
        options: [
          { id: "", title: "未命名选项" },
        ],
      }, "call-2");
      // id 为空但 title 不为空 — 应能正常工作
      expect(result.isError).toBe(false);
      expect(result.content).toContain("未命名选项");
    });

    it("show_progress 的 current/max 为负数也应传递", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("show_progress", {
        message: "未知进度",
        current: -1,
        max: -1,
      }, "call-3");
      expect(mockUI.progressCalls[0].current).toBe(-1);
      expect(mockUI.progressCalls[0].max).toBe(-1);
    });

    it("select_file 的 glob 为空字符串也应传递", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("select_file", {
        prompt: "选文件",
        glob: "",
      }, "call-4");
      expect(mockUI.selectFileCalls[0].glob).toBe("");
    });

    it("show_diff 的 summary 为空字符串也应传递", async () => {
      const { registry, mockUI } = createMockRegistry();
      await registry.executeAsync("show_diff", {
        file: "f.ts",
        diff: "diff",
        summary: "",
      }, "call-5");
      expect(mockUI.diffCalls[0].summary).toBe("");
    });
  });
});
