/**
 * 第 1 章测试 — 工程骨架
 *
 * 验证项目基础设施配置正确：
 *   1. package.json — name、version、type、scripts、dependencies
 *   2. tsconfig.json — ESM、strict、target ES2022
 *   3. vitest.config.ts — 测试包含规则
 *   4. 基础导入链 — 核心模块可导入
 *   5. 工具链 — TypeScript 编译、Vitest 可运行
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

/* ─── 辅助函数 ───────────────────────────────────────────────────── */

function readJSON(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf-8"));
}

function readText(rel: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf-8");
}

/* ─── package.json ───────────────────────────────────────────────── */

describe("package.json", () => {
  const pkg = readJSON("package.json");

  it("name 为 agent-harness", () => {
    expect(pkg.name).toBe("agent-harness");
  });

  it("version 已定义", () => {
    expect(pkg.version).toBe("0.1.0");
  });

  it('type 为 "module"（ESM）', () => {
    expect(pkg.type).toBe("module");
  });

  it("bin 指向 CLI 入口", () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin).toEqual({ "agent-harness": "./dist/src/cli/main.js" });
  });

  it("包含必需的 npm scripts", () => {
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.test).toBe("vitest run");
    expect(scripts.build).toBe("tsc");
    expect(scripts.typecheck).toBe("tsc --noEmit");
    expect(scripts.dev).toBe("tsx src/cli/main.ts");
  });

  it("vitest 在 devDependencies 中", () => {
    const deps = pkg.devDependencies as Record<string, string>;
    expect(deps.vitest).toBeDefined();
  });

  it("typescript 在 devDependencies 中", () => {
    const deps = pkg.devDependencies as Record<string, string>;
    expect(deps.typescript).toBeDefined();
  });

  it("node-fs / node:path 等标准库未在 dependencies 中——使用内置模块", () => {
    const deps = pkg.dependencies as Record<string, string> || {};
    // 不应将 Node 内置模块作为外部依赖
    expect(deps["node:fs"]).toBeUndefined();
    expect(deps["node:path"]).toBeUndefined();
  });
});

/* ─── tsconfig.json ──────────────────────────────────────────────── */

describe("tsconfig.json", () => {
  const tsconfig: Record<string, any> = readJSON("tsconfig.json");

  it("已定义 compilerOptions", () => {
    expect(tsconfig.compilerOptions).toBeDefined();
  });

  it("开启 strict 模式", () => {
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it("module 为 ESNext / ESNext 兼容", () => {
    expect(tsconfig.compilerOptions.module).toBe("ESNext");
  });

  it("target 为 ES2022", () => {
    expect(tsconfig.compilerOptions.target).toBe("ES2022");
  });

  it("moduleResolution 为 bundler", () => {
    expect(tsconfig.compilerOptions.moduleResolution).toBe("bundler");
  });

  it("包含 src 和 tests 目录", () => {
    expect(tsconfig.include).toContain("src/**/*.ts");
    expect(tsconfig.include).toContain("tests/**/*.ts");
  });

  it("排除 node_modules 和 dist", () => {
    expect(tsconfig.exclude).toContain("node_modules");
    expect(tsconfig.exclude).toContain("dist");
  });

  it("启用 declaration 和 sourceMap", () => {
    expect(tsconfig.compilerOptions.declaration).toBe(true);
    expect(tsconfig.compilerOptions.sourceMap).toBe(true);
  });
});

/* ─── vitest.config.ts ───────────────────────────────────────────── */

describe("vitest.config.ts", () => {
  it("配置文件存在且可读", () => {
    const config = readText("vitest.config.ts");
    expect(config).toBeTruthy();
    expect(config).toContain("defineConfig");
  });

  it("配置包含 tests/ 目录", () => {
    const config = readText("vitest.config.ts");
    expect(config).toContain("tests/**/*.test.ts");
    expect(config).toContain("tests/test_smoke.ts");
  });
});

/* ─── Node.js 环境 ───────────────────────────────────────────────── */

describe("Node.js 环境", () => {
  it("Node.js 版本 ≥ 20", () => {
    const parts = process.version.slice(1).split(".").map(Number);
    expect(parts[0]).toBeGreaterThanOrEqual(20);
  });

  it("ESM 模式可用（import.meta 存在）", () => {
    expect(import.meta).toBeDefined();
    expect(import.meta.url).toBeDefined();
    expect(import.meta.dirname).toBeDefined();
  });
});

/* ─── 导入链 ─────────────────────────────────────────────────────── */

describe("导入链", () => {
  it("核心模块可导入（harness/index）", async () => {
    const harness = await import("../src/harness/index.js");
    expect(harness.VERSION).toBe("0.1.0");
    expect(typeof harness.run).toBe("function");
    expect(typeof harness.arun).toBe("function");
  });

  it("消息模块可导入", async () => {
    const msg = await import("../src/harness/messages.js");
    expect(typeof msg.Message).toBe("function");
    expect(typeof msg.Transcript).toBe("function");
  });

  it("MockProvider 可导入并实例化", async () => {
    const { MockProvider } = await import("../src/harness/providers/mock.js");
    const { ProviderResponse } = await import("../src/harness/providers/base.js");
    const mock = new MockProvider([new ProviderResponse("hello")]);
    expect(mock.name).toBe("mock");
  });
});

/* ─── 项目结构完整性 ───────────────────────────────────────────────── */

describe("项目结构完整性", () => {
  it("src/harness/ 目录存在", () => {
    const stat = fs.statSync(path.join(PROJECT_ROOT, "src/harness"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("tests/ 目录存在", () => {
    const stat = fs.statSync(path.join(PROJECT_ROOT, "tests"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("README.md 存在", () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, "README.md"))).toBe(true);
  });

  it("src/cli/main.ts 存在（CLI 入口）", () => {
    expect(fs.existsSync(path.join(PROJECT_ROOT, "src/cli/main.ts"))).toBe(true);
  });

  it("docs/ 目录包含全部 32 章文档", () => {
    const docs = fs.readdirSync(path.join(PROJECT_ROOT, "docs"));
    const chDocs = docs.filter((f) => /^ch\d{2}/.test(f));
    expect(chDocs.length).toBe(32);
  });

  it(".gitignore 存在并包含标准规则", () => {
    const gitignore = readText(".gitignore");
    expect(gitignore).toContain("node_modules");
    expect(gitignore).toContain("dist");
  });
});
