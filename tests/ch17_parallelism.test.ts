/**
 * 第 17 章测试 — 并行执行与共享状态
 *
 * 覆盖三种扇出模式和 Scratchpad 状态共享：
 *   1. 独立扇出 — 互不相关的任务并行执行
 *   2. 依赖扇出 — 一个 sub-agent 的输出作为另一个的输入
 *   3. 竞争扇出 — 多方法解决同一问题，取最佳结果
 *   4. Scratchpad 状态共享 — 按 key 读写，避免碰撞
 *   5. key 碰撞预防 — <agent_id>/<key> 前缀约定
 *   6. 失败隔离 — 一个 sub-agent 失败不影响其他
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Scratchpad } from "../src/harness/tools/scratchpad.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SCRATCH_ROOT = path.join(PROJECT_ROOT, ".test-scratchpad-ch17");

/* ─── 测试前后清理 ─────────────────────────────────────────────────── */

beforeEach(() => {
  // 确保 scratchpad 根目录干净
  if (fs.existsSync(SCRATCH_ROOT)) {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (fs.existsSync(SCRATCH_ROOT)) {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  }
});

/* ─── 独立扇出（Independent Fan-out）─────────────────────────────── */

describe("独立扇出（Independent Fan-out）", () => {
  it("多个不相关的子任务可并行执行并聚合结果", async () => {
    // 模拟三个独立任务：搜索、分析、检查
    const taskA = Promise.resolve().then(() => "Found 3 related issues");
    const taskB = Promise.resolve().then(() => "Documentation at docs/");
    const taskC = Promise.resolve().then(() => "All tests pass");

    const results = await Promise.all([taskA, taskB, taskC]);
    expect(results).toHaveLength(3);

    const summary = results.join("\n");
    expect(summary).toContain("Found 3 related issues");
    expect(summary).toContain("Documentation at docs/");
    expect(summary).toContain("All tests pass");
  });

  it("最慢的任务决定总耗时（wall-clock = max, not sum）", async () => {
    const start = Date.now();

    const fast = Promise.resolve().then(() => "fast result");
    // slow 用延时模拟
    const slow = new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow result"), 30);
    });

    const results = await Promise.all([fast, slow]);
    const elapsed = Date.now() - start;

    expect(results).toContain("fast result");
    expect(results).toContain("slow result");
    // 总耗时大约等于最慢的任务（30ms），而不是 fast+slow 之和
    expect(elapsed).toBeLessThan(100);
  });

  it("独立任务不会互相干扰结果", async () => {
    const taskA = Promise.resolve().then(() => ({ id: "A", data: [1, 2, 3] }));
    const taskB = Promise.resolve().then(() => ({ id: "B", data: [4, 5, 6] }));

    const [rA, rB] = await Promise.all([taskA, taskB]);
    expect(rA.data).toEqual([1, 2, 3]);
    expect(rB.data).toEqual([4, 5, 6]);
  });
});

/* ─── 依赖扇出（Dependent Fan-out）────────────────────────────────── */

describe("依赖扇出（Dependent Fan-out）", () => {
  it("一个 sub-agent 的输出通过 scratchpad 传给另一个", () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);

    // Sub-agent A：分析代码 → 写入 scratchpad
    const analysis = "Found potential null ref in src/harness/agent.ts:204";
    scratchpad.write("agent-A-analysis", analysis);

    // Sub-agent B：基于 A 的分析结果做出修复
    const priorAnalysis = scratchpad.read("agent-A-analysis");
    const fixPlan = `Reviewing: ${priorAnalysis}. Suggested fix: add null check.`;
    scratchpad.write("agent-B-fix-plan", fixPlan);

    const finalPlan = scratchpad.read("agent-B-fix-plan");
    expect(finalPlan).toContain("add null check");
    expect(finalPlan).toContain("agent.ts:204");
  });

  it("链式依赖：A → B → C 逐步传递", () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);

    scratchpad.write("step-A", "raw data: response time = 320ms");
    const stepA = scratchpad.read("step-A");
    const stepB = `parsed: ${stepA.replace("raw data: ", "")}`;
    scratchpad.write("step-B", stepB);
    const stepC = `report: ${scratchpad.read("step-B")} → needs optimization`;
    scratchpad.write("step-C", stepC);

    expect(scratchpad.read("step-C")).toContain("needs optimization");
    expect(scratchpad.read("step-C")).toContain("320ms");
  });

  it("中间结果不可用时，下游应报错", () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);
    scratchpad.write("step-A", "some data");
    // step-B 不存在

    expect(() => scratchpad.read("step-B")).toThrow("not found");
  });
});

/* ─── 竞争扇出（Competitive Fan-out）─────────────────────────────────── */

describe("竞争扇出（Competitive Fan-out）", () => {
  it("多种方法分别解决同一问题，取最佳结果", async () => {
    // 三种方式找同一个 bug
    const grepSearch = Promise.resolve().then(() => ({
      method: "grep",
      result: "Found 2 matches in agent.ts",
      score: 60,
    }));
    const astAnalysis = Promise.resolve().then(() => ({
      method: "AST",
      result: "Found 1 pattern match in agent.ts:204",
      score: 85,
    }));
    const runtimeTrace = Promise.resolve().then(() => ({
      method: "trace",
      result: "Confirmed null reference at runtime",
      score: 95,
    }));

    const allResults = await Promise.all([grepSearch, astAnalysis, runtimeTrace]);
    // 选最高分
    const best = allResults.reduce((a, b) => (a.score > b.score ? a : b));

    expect(best.method).toBe("trace");
    expect(best.score).toBe(95);
  });

  it("所有方法的结果都可被父 agent 综合比较", async () => {
    const methodA = { method: "grep", confidence: 0.6 };
    const methodB = { method: "AST", confidence: 0.85 };
    const methodC = { method: "trace", confidence: 0.95 };

    const all = [methodA, methodB, methodC];
    const sorted = [...all].sort((a, b) => b.confidence - a.confidence);

    expect(sorted[0].method).toBe("trace");
    expect(sorted[1].method).toBe("AST");
  });
});

/* ─── Scratchpad 状态共享（第 9 章 + 第 17 章集成）────────────────── */

describe("Scratchpad 状态共享", () => {
  it("多个 sub-agent 通过 scratchpad 写入各自结果", () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);

    // 模拟多个子 agent 同时写入不同 key
    scratchpad.write("agent-A-search-results", "Issue #42: memory leak");
    scratchpad.write("agent-B-doc-summary", "Docs say use WeakRef");
    scratchpad.write("agent-C-test-results", "3/5 tests pass");

    const keys = scratchpad.list();
    expect(keys).toContain("agent-A-search-results");
    expect(keys).toContain("agent-B-doc-summary");
    expect(keys).toContain("agent-C-test-results");
    expect(keys).toHaveLength(3);
  });

  it("父 agent 按需读取 scratchpad 结果", () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);
    scratchpad.write("agent-A-search-results", "Found 3 issues");
    scratchpad.write("agent-B-doc-summary", "Docs at docs/");

    // 父 agent 只读取需要的 key
    const searchResult = scratchpad.read("agent-A-search-results");
    expect(searchResult).toBe("Found 3 issues");

    // 不读取 agent-B 的结果 — 节省 tokens
    const keys = scratchpad.list();
    expect(keys).toHaveLength(2);
  });

  it("写入可覆盖已有 key", () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);
    scratchpad.write("shared-result", "initial");
    scratchpad.write("shared-result", "updated");

    expect(scratchpad.read("shared-result")).toBe("updated");
  });
});

/* ─── Key 碰撞预防 ──────────────────────────────────────────────────── */

describe("Key 碰撞预防", () => {
  it("使用 <agent_id>/<key> 前缀约定避免同名 key 冲突", () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);
    // 两个 sub-agent 写入相同含义但不同来源的数据
    scratchpad.write("searcher-results", "search results from GitHub");
    scratchpad.write("analyzer-results", "analysis of code structure");

    // 不会互相覆盖
    expect(scratchpad.read("searcher-results")).toContain("search");
    expect(scratchpad.read("analyzer-results")).toContain("analysis");
  });

  it("无前缀时可能被覆盖（概念验证）", () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);
    scratchpad.write("results", "first agent's results");
    scratchpad.write("results", "second agent overwrites");

    // 没有前缀，后写入覆盖前者
    expect(scratchpad.read("results")).toBe("second agent overwrites");
    expect(scratchpad.list()).toHaveLength(1);
  });
});

/* ─── 失败隔离 ────────────────────────────────────────────────────── */

describe("失败隔离", () => {
  it("一个并行任务失败不会阻止其他任务完成", async () => {
    const results: string[] = [];

    const good1 = Promise.resolve().then(() => results.push("task-A done"));
    const bad = Promise.reject(new Error("task-B failed"));
    const good2 = Promise.resolve().then(() => results.push("task-C done"));

    // 用 Promise.allSettled 避免一个失败中断全部
    const settled = await Promise.allSettled([good1, bad, good2]);

    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1].status).toBe("rejected");
    expect(settled[2].status).toBe("fulfilled");
    expect(results).toContain("task-A done");
    expect(results).toContain("task-C done");
  });

  it("一个失败的任务不会影响 scratchpad 中其他任务的结果", async () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);

    // 即使一个任务失败，已写入 scratchpad 的数据仍在
    scratchpad.write("agent-A-partial", "partial result from A");
    // agent-B 失败
    try {
      throw new Error("agent-B crashed");
    } catch {
      // 隔离失败
    }
    scratchpad.write("agent-C-data", "complete result from C");

    expect(scratchpad.read("agent-A-partial")).toBe("partial result from A");
    expect(scratchpad.read("agent-C-data")).toBe("complete result from C");
  });
});

/* ─── 集成：完整并行工作流 ──────────────────────────────────────────── */

describe("集成：完整并行工作流", () => {
  it("扇出 → scratchpad 写入 → 聚合 → 产出", async () => {
    const scratchpad = new Scratchpad(SCRATCH_ROOT);

    // 扇出: 三个子任务并行执行
    const [rA, rB, rC] = await Promise.all([
      Promise.resolve().then(() => ({ id: "A", data: "Bug: memory leak" })),
      Promise.resolve().then(() => ({ id: "B", data: "Location: src/cache.ts" })),
      Promise.resolve().then(() => ({ id: "C", data: "Fix: add TTL" })),
    ]);

    // 写入 scratchpad
    scratchpad.write("searcher-bug", rA.data);
    scratchpad.write("searcher-location", rB.data);
    scratchpad.write("analyzer-fix", rC.data);

    // 聚合: 父 agent 读取并综合
    const bug = scratchpad.read("searcher-bug");
    const location = scratchpad.read("searcher-location");
    const fix = scratchpad.read("analyzer-fix");

    const report = [bug, `At: ${location}`, `Fix: ${fix}`].join("\n");
    expect(report).toContain("memory leak");
    expect(report).toContain("src/cache.ts");
    expect(report).toContain("add TTL");
  });
});
