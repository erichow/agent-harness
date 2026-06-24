/**
 * 第 30 章示例 — UI 交互工具
 *
 * 展示 UIProvider + 6 个 UI 工具的工作方式。
 * 使用 MockUIProvider 模拟用户交互，无需人工参与。
 *
 * 运行：npx tsx examples/ch30_ui_interaction.ts
 */

import {
  createUITools,
  NoopUIProvider,
  type UIProvider,
} from "../src/harness/tools/ui.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

/* ════════════════════════════════════════════════════════════════════
   MockUIProvider — 模拟用户交互（无需人工参与）
   ════════════════════════════════════════════════════════════════════ */

class MockUIProvider implements UIProvider {
  readonly confirmed: boolean;
  readonly choiceIndex: number;
  readonly inputText: string;
  readonly selectedFiles: string[];

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
  readonly diffCalls: Array<{
    file: string;
    diff: string;
    summary?: string;
  }> = [];
  readonly selectFileCalls: Array<{ prompt: string; glob?: string }> = [];

  constructor(opts?: {
    confirmed?: boolean;
    choiceIndex?: number;
    inputText?: string;
    selectedFiles?: string[];
  }) {
    this.confirmed = opts?.confirmed ?? true;
    this.choiceIndex = opts?.choiceIndex ?? 0;
    this.inputText = opts?.inputText ?? "user input";
    this.selectedFiles = opts?.selectedFiles ?? [];
  }

  async confirm(message: string, details?: string): Promise<boolean> {
    this.confirmCalls.push({ message, details });
    return this.confirmed;
  }

  async choice(
    question: string,
    options: Array<{ id: string; title: string }>,
  ): Promise<{ id: string; title: string }> {
    this.choiceCalls.push({ question, options });
    const idx = Math.min(this.choiceIndex, options.length - 1);
    return options[idx];
  }

  async input(message: string, defaultValue?: string): Promise<string> {
    this.inputCalls.push({ message, defaultValue });
    return this.inputText;
  }

  showProgress(message: string, current: number, max: number): void {
    this.progressCalls.push({ message, current, max });
  }

  showDiff(file: string, diff: string, summary?: string): void {
    this.diffCalls.push({ file, diff, summary });
  }

  async selectFile(prompt: string, glob?: string): Promise<string[]> {
    this.selectFileCalls.push({ prompt, glob });
    return this.selectedFiles;
  }
}

/* ════════════════════════════════════════════════════════════════════
   正文
   ════════════════════════════════════════════════════════════════════ */

console.log("═".repeat(60));
console.log("第30章 · UI 交互工具 — 示例");
console.log("═".repeat(60));

/* ─── 创建 MockUIProvider ──────────────────────────────────────── */

const mockUI = new MockUIProvider({
  confirmed: true,
  choiceIndex: 0,
  inputText: "这是一个用户输入示例",
  selectedFiles: ["src/main.ts", "src/utils.ts"],
});

const uiTools = createUITools(mockUI);
const registry = new ToolRegistry();

// 注册 UI 工具
for (const entry of uiTools) {
  registry.aregister(entry.definition, entry.asyncHandler!);
}

/* ─── 1. confirm_action ──────────────────────────────────────────── */

console.log("\n📋 1. confirm_action — 确认对话框：");

async function demoConfirm() {
  // 确认 - 同意
  const result1 = await registry.executeAsync("confirm_action", {
    message: "确认删除该文件？",
    details: "文件路径: /tmp/test.txt (12KB)",
  }, "call-confirm-1");
  console.log(`   同意删除: ${result1.content}`);

  // 确认 - 拒绝
  const denyUI = new MockUIProvider({ confirmed: false });
  const denyTools = createUITools(denyUI);
  const denyReg = new ToolRegistry();
  for (const entry of denyTools) {
    denyReg.aregister(entry.definition, entry.asyncHandler!);
  }

  const result2 = await denyReg.executeAsync("confirm_action", {
    message: "确认推送代码到生产环境？",
  }, "call-confirm-2");
  console.log(`   拒绝推送: ${result2.content}`);

  console.log(`   confirm_action 调用记录: ${mockUI.confirmCalls.length} 次`);
}

await demoConfirm();

/* ─── 2. ask_choice ──────────────────────────────────────────────── */

console.log("\n📋 2. ask_choice — 选项选择：");

async function demoChoice() {
  const result = await registry.executeAsync("ask_choice", {
    question: "如何修复这个 lint 错误？",
    options: [
      { id: "A", title: "重命名变量" },
      { id: "B", title: "添加类型注解" },
      { id: "C", title: "忽略该规则" },
    ],
  }, "call-choice-1");
  console.log(`   选择结果: ${result.content}`);

  const choiceLog = mockUI.choiceCalls[0];
  console.log(`   问题: "${choiceLog.question}"`);
  console.log(`   选项数: ${choiceLog.options.length}`);
}

await demoChoice();

/* ─── 3. ask_input ──────────────────────────────────────────────── */

console.log("\n📋 3. ask_input — 文本输入：");

async function demoInput() {
  // 有默认值
  const result1 = await registry.executeAsync("ask_input", {
    message: "请输入 commit 消息",
    defaultValue: "fix: 修复类型错误",
  }, "call-input-1");
  console.log(`   输入结果: "${result1.content}"`);

  // 无默认值
  const inputUI2 = new MockUIProvider({ inputText: "自定义输入" });
  const inputTools2 = createUITools(inputUI2);
  const inputReg2 = new ToolRegistry();
  for (const entry of inputTools2) {
    inputReg2.aregister(entry.definition, entry.asyncHandler!);
  }
  const result2 = await inputReg2.executeAsync("ask_input", {
    message: "请描述你遇到的问题",
  }, "call-input-2");
  console.log(`   自定义输入: "${result2.content}"`);
}

await demoInput();

/* ─── 4. show_progress ───────────────────────────────────────────── */

console.log("\n📋 4. show_progress — 进度显示：");

async function demoProgress() {
  // 单次进度更新
  const result1 = await registry.executeAsync("show_progress", {
    message: "分析代码文件",
    current: 1,
    max: 5,
  }, "call-progress-1");
  console.log(`   进度状态: ${result1.content}`);

  // 模拟多步进度
  for (let i = 0; i < 5; i++) {
    await registry.executeAsync("show_progress", {
      message: "正在搜索文件...",
      current: i + 1,
      max: 5,
    }, `call-progress-${i + 2}`);
  }
  console.log(`   总进度调用次数: ${mockUI.progressCalls.length}`);
  console.log(`   最近消息: "${mockUI.progressCalls[0].message}"`);
}

await demoProgress();

/* ─── 5. show_diff ───────────────────────────────────────────────── */

console.log("\n📋 5. show_diff — Diff 预览：");

async function demoDiff() {
  const sampleDiff = `--- a/src/main.ts
+++ b/src/main.ts
@@ -10,7 +10,7 @@
 function greet(name: string) {
-  return "Hello, " + name;
+  return "Hi, " + name;
 }`;

  const result = await registry.executeAsync("show_diff", {
    file: "src/main.ts",
    diff: sampleDiff,
    summary: "更新问候语",
  }, "call-diff-1");
  console.log(`   Diff 结果: ${result.content}`);

  const diffLog = mockUI.diffCalls[0];
  console.log(`   文件: "${diffLog.file}"`);
  console.log(`   摘要: "${diffLog.summary}"`);
  console.log(`   Diff 长度: ${diffLog.diff.length} 字符`);
}

await demoDiff();

/* ─── 6. select_file ─────────────────────────────────────────────── */

console.log("\n📋 6. select_file — 文件选择：");

async function demoSelectFile() {
  const result = await registry.executeAsync("select_file", {
    prompt: "选择要重构的文件",
    glob: "src/**/*.ts",
  }, "call-select-1");
  console.log(`   文件选择结果: ${result.content}`);

  // 无匹配
  const emptyUI = new MockUIProvider({ selectedFiles: [] });
  const emptyTools = createUITools(emptyUI);
  const emptyReg = new ToolRegistry();
  for (const entry of emptyTools) {
    emptyReg.aregister(entry.definition, entry.asyncHandler!);
  }
  const result2 = await emptyReg.executeAsync("select_file", {
    prompt: "选择要删除的文件",
  }, "call-select-2");
  console.log(`   未选文件: ${result2.content}`);
}

await demoSelectFile();

/* ─── 7. NoopUIProvider — 无交互环境 ────────────────────────────── */

console.log("\n📋 7. NoopUIProvider — 无交互环境兜底：");

async function demoNoop() {
  const noopTools = createUITools(); // 默认 NoopUIProvider
  const noopReg = new ToolRegistry();
  for (const entry of noopTools) {
    noopReg.aregister(entry.definition, entry.asyncHandler!);
  }

  // confirm 默认拒绝（安全保守）
  const confirmResult = await noopReg.executeAsync("confirm_action", {
    message: "删除重要文件？",
  }, "call-noop-confirm");
  console.log(`   Noop confirm（安全拒绝）: ${confirmResult.content}`);

  // choice 返回错误（无交互环境无法抉择）
  const choiceResult = await noopReg.executeAsync("ask_choice", {
    question: "选择方案",
    options: [{ id: "A", title: "方案A" }],
  }, "call-noop-choice");
  console.log(`   Noop choice: ❌ ${choiceResult.content.slice(0, 50)}...`);

  // input 返回错误（无交互环境无法输入）
  const inputResult = await noopReg.executeAsync("ask_input", {
    message: "输入内容",
  }, "call-noop-input");
  console.log(`   Noop input: ❌ ${inputResult.content.slice(0, 50)}...`);

  // progress / diff 静默丢弃（不抛错）
  const progressResult = await noopReg.executeAsync("show_progress", {
    message: "执行中...",
    current: 1,
    max: 10,
  }, "call-noop-progress");
  console.log(`   Noop progress: ${progressResult.content}`);

  const diffResult = await noopReg.executeAsync("show_diff", {
    file: "test.ts",
    diff: "--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-test\n+test2",
  }, "call-noop-diff");
  console.log(`   Noop diff: ${diffResult.content}`);

  // selectFile 返回错误（无交互环境无法选文件）
  const selectResult = await noopReg.executeAsync("select_file", {
    prompt: "选文件",
  }, "call-noop-select");
  console.log(`   Noop select_file: ❌ ${selectResult.content.slice(0, 50)}...`);

  console.log("\n   ✅ NoopUIProvider 安全兜底工作正常");
}

await demoNoop();

/* ─── 8. UIProvider 自定义 ──────────────────────────────────────── */

console.log("\n📋 8. 自定义 UIProvider — 验证用户交互追踪：");

async function demoCustomUI() {
  const customUI = new MockUIProvider({
    confirmed: true,
    choiceIndex: 1,
    inputText: "自定义输入文本",
    selectedFiles: ["a.ts", "b.ts", "c.ts"],
  });

  const customTools = createUITools(customUI);
  const customReg = new ToolRegistry();
  for (const entry of customTools) {
    customReg.aregister(entry.definition, entry.asyncHandler!);
  }

  // 模拟一个完整的工作流
  // 1. 选择文件
  const selectResult = await customReg.executeAsync("select_file", {
    prompt: "选择要修改的文件",
    glob: "src/**/*.ts",
  }, "call-cus-select");
  console.log(`   ① 选文件: ${selectResult.content}`);

  // 2. 确认修改
  const confirmResult = await customReg.executeAsync("confirm_action", {
    message: "确认修改 3 个文件？",
    details: "修改类型：添加类型注解",
  }, "call-cus-confirm");
  console.log(`   ② 确认: ${confirmResult.content}`);

  // 3. 进度跟踪
  for (const [i, file] of ["a.ts", "b.ts", "c.ts"].entries()) {
    await customReg.executeAsync("show_progress", {
      message: `正在处理 ${file}`,
      current: i + 1,
      max: 3,
    }, `call-cus-prog-${i}`);
  }
  console.log(`   ③ 进度: 3/3 完成`);

  // 4. 显示 diff
  await customReg.executeAsync("show_diff", {
    file: "a.ts",
    diff: "--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-test\n+test",
    summary: "a.ts 改动",
  }, "call-cus-diff");
  console.log(`   ④ Diff 已显示`);

  // 5. 提问
  const choiceResult = await customReg.executeAsync("ask_choice", {
    question: "是否继续？",
    options: [
      { id: "yes", title: "继续处理" },
      { id: "no", title: "停止推入" },
      { id: "review", title: "审查后再决定" },
    ],
  }, "call-cus-choice");
  console.log(`   ⑤ 选择: ${choiceResult.content}`);

  console.log("\n   ✅ 完整工作流演示完成");
}

await demoCustomUI();

/* ─── 汇总 ───────────────────────────────────────────────────────── */

console.log("\n" + "═".repeat(60));
console.log("✅ 第30章 UI 交互工具示例完成！");
console.log("═".repeat(60));
