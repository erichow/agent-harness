/**
 * 第 32 章测试 — 从 Harness 到产品
 *
 * 验证产品化收束：
 *   1. CH32_COMPLETE — 标记全部 32 章完成
 *   2. CHAPTERS_COMPLETED — 覆盖所有章节
 *   3. 模块导出完整性 — src/index.ts 导出所有章节的组件
 *   4. CLI 入口 — main.ts 可解析参数
 *   5. 全景图验证 — 每个章节对应的核心组件可访问
 *   6. 版本号 — VERSION 一致
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

/* ─── CH32_COMPLETE / CHAPTERS_COMPLETED ──────────────────────────── */

describe("CH32_COMPLETE", () => {
  it("标记为 true，表示全部 32 章完成", async () => {
    const { CH32_COMPLETE } = await import("../src/harness/index.js");
    expect(CH32_COMPLETE).toBe(true);
  });
});

describe("CHAPTERS_COMPLETED", () => {
  it("长度为 32，覆盖第 1 到第 32 章", async () => {
    const { CHAPTERS_COMPLETED } = await import("../src/harness/index.js");
    expect(CHAPTERS_COMPLETED).toHaveLength(32);
    for (let i = 1; i <= 32; i++) {
      expect(CHAPTERS_COMPLETED).toContain(i);
    }
  });

  it("列表有序", async () => {
    const { CHAPTERS_COMPLETED } = await import("../src/harness/index.js");
    for (let i = 0; i < CHAPTERS_COMPLETED.length - 1; i++) {
      expect(CHAPTERS_COMPLETED[i]).toBeLessThan(CHAPTERS_COMPLETED[i + 1]);
    }
  });
});

/* ─── 模块导出完整性 ──────────────────────────────────────────────── */

describe("模块导出完整性", () => {
  it("导出全部 8 个部分的代表组件", async () => {
    const h = await import("../src/harness/index.js");

    // 第一部分：基础 (ch1-3)
    expect(h).toHaveProperty("VERSION");
    expect(h).toHaveProperty("run");
    expect(h).toHaveProperty("arun");
    expect(h).toHaveProperty("Message");
    expect(h).toHaveProperty("Transcript");

    // 第二部分：工具与执行 (ch4-6)
    expect(h).toHaveProperty("ToolRegistry");
    expect(h).toHaveProperty("jsonQueryDefinition");

    // 第三部分：上下文工程 (ch7-11)
    expect(h).toHaveProperty("ContextAccountant");
    expect(h).toHaveProperty("Compactor");
    expect(h).toHaveProperty("Scratchpad");
    expect(h).toHaveProperty("DocumentIndex");
    expect(h).toHaveProperty("fileViewportTool");

    // 第四部分：规模化 (ch12-14)
    expect(h).toHaveProperty("ToolCatalog");
    expect(h).toHaveProperty("MCPClient");
    expect(h).toHaveProperty("PermissionManager");

    // 第五部分：多智能体 (ch15-17)
    expect(h).toHaveProperty("Plan");
    expect(h).toHaveProperty("PlanHolder");

    // 第六部分：生产化 (ch18-22)
    expect(h).toHaveProperty("setupTracing");
    expect(h).toHaveProperty("EvalRunner");
    expect(h).toHaveProperty("BudgetEnforcer");
    expect(h).toHaveProperty("Checkpointer");

    // 第七部分：扩展工具 (ch23-27)
    expect(h).toHaveProperty("createGitTools");
    expect(h).toHaveProperty("createTerminalTools");
    expect(h).toHaveProperty("LSPManager");
    expect(h).toHaveProperty("createCodeAnalysisTools");

    // 第八部分：产品化 (ch28-32)
    expect(h).toHaveProperty("loadConfig");
    expect(h).toHaveProperty("parseArgs");
    expect(h).toHaveProperty("createUITools");
    expect(h).toHaveProperty("ProjectContextManager");
    expect(h).toHaveProperty("CH32_COMPLETE");
  });

  it("Provider 相关导出完整", async () => {
    const h = await import("../src/harness/index.js");
    expect(h).toHaveProperty("ProviderResponse");
    expect(h).toHaveProperty("MockProvider");
    expect(h).toHaveProperty("FallbackProvider");
    expect(h).toHaveProperty("InteractiveProvider");
    expect(h).toHaveProperty("withRetry");
  });

  it("StreamEvent 类型导出完整", async () => {
    const h = await import("../src/harness/index.js");
    expect(h).toHaveProperty("textDelta");
    expect(h).toHaveProperty("reasoningDelta");
    expect(h).toHaveProperty("toolCallStart");
    expect(h).toHaveProperty("toolCallDelta");
    expect(h).toHaveProperty("completed");
  });
});

/* ─── CLI 入口 ────────────────────────────────────────────────────── */

describe("CLI 入口", () => {
  it("parseArgs 解析 --help", async () => {
    const { parseArgs } = await import("../src/cli/args.js");
    const opts = parseArgs(["--help"]);
    expect(opts.help).toBe(true);
  });

  it("parseArgs 解析 --version", async () => {
    const { parseArgs } = await import("../src/cli/args.js");
    const opts = parseArgs(["--version"]);
    expect(opts.version).toBe(true);
  });

  it("parseArgs 解析 -c config.yaml", async () => {
    const { parseArgs } = await import("../src/cli/args.js");
    const opts = parseArgs(["-c", "my-config.yaml"]);
    expect(opts.config).toBe("my-config.yaml");
  });

  it("parseArgs 解析 --message", async () => {
    const { parseArgs } = await import("../src/cli/args.js");
    const opts = parseArgs(["-m", "hello"]);
    expect(opts.message).toBe("hello");
  });

  it("parseArgs 解析 --no-stream", async () => {
    const { parseArgs } = await import("../src/cli/args.js");
    // 默认 noStream 为 false
    const defaultOpts = parseArgs([]);
    expect(defaultOpts.noStream).toBe(false);

    const opts = parseArgs(["--no-stream"]);
    expect(opts.noStream).toBe(true);
  });

  it("parseArgs 解析 verbose", async () => {
    const { parseArgs } = await import("../src/cli/args.js");
    const opts = parseArgs(["-v"]);
    expect(opts.verbose).toBe(true);
  });

  it("printHelp 返回帮助文本", async () => {
    const { printHelp } = await import("../src/cli/args.js");
    const help = printHelp();
    expect(help).toContain("Usage");
    expect(help).toContain("agent-harness");
  });

  it("printVersion 返回版本号", async () => {
    const { printVersion } = await import("../src/cli/args.js");
    const v = printVersion();
    expect(v).toContain("0.1.0");
  });

  it("main.ts 可执行（直接导入不抛错）", async () => {
    // 只验证导入不报错，不执行 main()
    const mod = await import("../src/cli/main.js");
    // main.ts 没有 default 导出
    expect(Object.keys(mod)).not.toContain("default");
  });
});

/* ─── VERSION 一致性 ──────────────────────────────────────────────── */

describe("VERSION 一致性", () => {
  it("package.json 的 version 与 harness 导出一致", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    );
    const { VERSION } = await import("../src/harness/index.js");
    expect(VERSION).toBe(pkg.version);
  });
});

/* ─── docs 总览 ────────────────────────────────────────────────────── */

describe("docs 总览", () => {
  it("32 章文档全部存在", () => {
    const docsDir = path.join(PROJECT_ROOT, "docs");
    const files = fs.readdirSync(docsDir);
    const chDocs = files.filter((f) => /^ch\d{2}/.test(f)).sort();
    expect(chDocs).toHaveLength(32);
    expect(chDocs[0]).toBe("ch01-skeleton.md");
    expect(chDocs[chDocs.length - 1]).toBe("ch32-from-harness-to-product.md");
  });

  it("所有章节文档都有内容", () => {
    const docsDir = path.join(PROJECT_ROOT, "docs");
    const files = fs.readdirSync(docsDir);
    const chDocs = files.filter((f) => /^ch\d{2}/.test(f));
    for (const doc of chDocs) {
      const content = fs.readFileSync(path.join(docsDir, doc), "utf-8");
      expect(content.length).toBeGreaterThan(100);
    }
  });
});

/* ─── bin 入口 ────────────────────────────────────────────────────── */

describe("bin 入口", () => {
  it("package.json 的 bin 指向 main.ts 的编译输出", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"),
    );
    const bin = pkg.bin["agent-harness"];
    // 应该是 "dist/src/cli/main.js"（编译后）
    expect(bin).toBe("./dist/src/cli/main.js");
  });
});
