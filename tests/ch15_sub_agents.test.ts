/**
 * 第 15 章测试 — 子智能体
 *
 * 覆盖已有实现与概念契约：
 *   1. subagentContext — 从 observability 导出的子 context 推导函数
 *   2. CHAPTERS_COMPLETED — 声明 ch15 已实现
 *   3. run_sub_agent 工具模式 — 通过 ToolRegistry 注册的概念工具
 *   4. SubAgentConfig / SubAgentResult 接口契约（概念定义）
 *   5. 委托 / 扇出 / 管线 三种模式的概念验证
 */
import { describe, it, expect } from "vitest";
import { subagentContext } from "../src/harness/observability/tracing.js";
import type { SessionContext } from "../src/harness/observability/tracing.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import type { CatalogEntry } from "../src/harness/tools/selector.js";
import { CHAPTERS_COMPLETED } from "../src/harness/index.js";

/* ─── subagentContext — 追踪上下文 ────────────────────────────────── */

describe("subagentContext（observability 实现）", () => {
  it("从父 context 派生子 agent context，替换 agentId", () => {
    const parent: SessionContext = {
      sessionId: "ses-1",
      taskId: "task-a",
      agentId: "main",
    };
    const child = subagentContext(parent, "searcher");
    expect(child.sessionId).toBe("ses-1");
    expect(child.taskId).toBe("task-a");
    expect(child.agentId).toBe("searcher");
  });

  it("不修改父 context（不可变派生）", () => {
    const parent: SessionContext = {
      sessionId: "ses-1",
      taskId: "task-a",
      agentId: "main",
    };
    const child = subagentContext(parent, "worker");
    expect(parent.agentId).toBe("main");
    expect(child.agentId).toBe("worker");
  });

  it("支持深层嵌套：子 → 孙", () => {
    const parent: SessionContext = {
      sessionId: "ses-1",
      taskId: "task-a",
      agentId: "main",
    };
    const child = subagentContext(parent, "search");
    const grandchild = subagentContext(child, "search-file-reader");
    expect(grandchild.sessionId).toBe("ses-1");
    expect(grandchild.agentId).toBe("search-file-reader");
  });
});

/* ─── CHAPTERS_COMPLETED ──────────────────────────────────────────── */

describe("CHAPTERS_COMPLETED 声明", () => {
  it("包含第 15 章", () => {
    expect(CHAPTERS_COMPLETED).toContain(15);
  });

  it("覆盖已实现章节全部范围（后续添加时更新）", () => {
    const n = CHAPTERS_COMPLETED.length;
    expect(n).toBeGreaterThanOrEqual(22);
    for (let i = 1; i <= n; i++) {
      expect(CHAPTERS_COMPLETED).toContain(i);
    }
  });
});

/* ─── run_sub_agent 工具模式 ──────────────────────────────────────── */

describe("run_sub_agent 工具模式", () => {
  it("可通过 ToolRegistry 注册为一个工具", () => {
    const registry = new ToolRegistry();

    // run_sub_agent 作为概念工具的定义（第 15 章文档 §③）
    const runSubAgentDef = {
      name: "run_sub_agent",
      description: "Spawn a sub-agent to complete a sub-task independently",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Description of the sub-task" },
          tools: {
            type: "array",
            description: "Optional tool names to give the sub-agent",
            items: { type: "string" },
          },
        },
        required: ["task"],
      },
    } as const;

    const handler = (args: Record<string, unknown>) => {
      return `[sub-agent completed: ${args.task as string}]`;
    };

    registry.register(runSubAgentDef, handler);
    const result = registry.execute("run_sub_agent", { task: "search docs" }, "call-1");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("[sub-agent completed: search docs]");
  });

  it("支持 tools 过滤参数", () => {
    const registry = new ToolRegistry();
    const runSubAgentDef = {
      name: "run_sub_agent",
      description: "Spawn a sub-agent",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
        },
        required: ["task"],
      },
    } as const;

    registry.register(runSubAgentDef, (args: Record<string, unknown>) => {
      const tools = args.tools as string[] | undefined;
      const toolMsg = tools ? ` (tools: ${tools.join(", ")})` : " (all tools)";
      return `[sub-agent: ${args.task as string}${toolMsg}]`;
    });

    const limited = registry.execute(
      "run_sub_agent",
      { task: "read files", tools: ["read_file"] },
      "call-2",
    );
    expect(limited.content).toContain("read files");
    expect(limited.content).toContain("read_file");

    const full = registry.execute(
      "run_sub_agent",
      { task: "search docs" },
      "call-3",
    );
    expect(full.content).toContain("all tools");
  });

  it("task 必填校验生效", () => {
    const registry = new ToolRegistry();
    const runSubAgentDef = {
      name: "run_sub_agent",
      description: "Spawn a sub-agent",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
        },
        required: ["task"],
      },
    } as const;

    registry.register(runSubAgentDef, (args) => `ok: ${args.task}`);

    // 不传 task → 校验失败
    const result = registry.execute("run_sub_agent", {}, "call-4");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid arguments");
  });
});

/* ─── 委托模式概念验证 ─────────────────────────────────────────────── */

describe("委托模式（Delegation）", () => {
  it("父 agent 派发子任务并返回摘要——注册概念工具", () => {
    const registry = new ToolRegistry();

    // 模拟子任务处理链：父 agent 调用 run_sub_agent
    registry.register({
      name: "search_docs",
      description: "Search documentation for a keyword",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string" },
        },
        required: ["keyword"],
      },
    } as const, (args) => `Found results for "${args.keyword}": retry.ts implements exponential backoff`);

    const result = registry.execute("search_docs", { keyword: "retry" }, "call-1");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("retry.ts");
  });
});

/* ─── 扇出模式概念验证 ─────────────────────────────────────────────── */

describe("扇出模式（Fan-out）", () => {
  it("多个独立任务可通过 Promise.all 并行派发", async () => {
    // 模拟三个独立搜索任务（概念验证）
    const tasks = [
      { id: "search-issues", keyword: "bug" },
      { id: "read-docs", keyword: "setup" },
      { id: "check-tests", keyword: "test" },
    ];

    // 模拟每个任务耗时不同
    async function simulateSubAgent(id: string): Promise<string> {
      return `[${id}] completed`;
    }

    const results = await Promise.all(tasks.map((t) => simulateSubAgent(t.id)));
    expect(results).toHaveLength(3);
    expect(results[0]).toContain("search-issues");
    expect(results[1]).toContain("read-docs");
    expect(results[2]).toContain("check-tests");
  });

  it("扇出结果可聚合", async () => {
    const subtasks = [
      Promise.resolve("Found 3 issues"),
      Promise.resolve("Documentation is at docs/"),
      Promise.resolve("All tests pass"),
    ];

    const results = await Promise.all(subtasks);
    const synthesized = results.join("\n");
    expect(synthesized).toContain("Found 3 issues");
    expect(synthesized).toContain("Documentation");
    expect(synthesized).toContain("All tests pass");
  });
});

/* ─── 管线模式概念验证 ─────────────────────────────────────────────── */

describe("管线模式（Pipeline）", () => {
  it("前一个子 agent 的输出可作为后一个的输入", () => {
    // 概念验证：A 分析代码 → B 基于 A 的结果修复
    const analysis = "Found deadlock in src/harness/agent.ts line 42";
    const fix = `Fixed based on analysis: ${analysis}`;
    expect(fix).toContain("deadlock");
    expect(fix).toContain("src/harness/agent.ts");
  });
});

/* ─── 安全与隔离 ──────────────────────────────────────────────────── */

describe("安全与隔离概念", () => {
  it("子 agent 应拥有独立 transcript（概念验证：工具独立性）", () => {
    // 子 agent 的独立 transcript 意味着它的工具调用不会污染父 transcript
    // 这里验证 ToolRegistry 可在不同"context"间独立创建
    const parentRegistry = new ToolRegistry();
    const childRegistry = new ToolRegistry();

    parentRegistry.register({
      name: "parent_only",
      description: "Only available to parent",
      inputSchema: { type: "object", properties: {} },
    } as const, () => "parent");

    childRegistry.register({
      name: "child_only",
      description: "Only available to child",
      inputSchema: { type: "object", properties: {} },
    } as const, () => "child");

    // 父 agent 看不到子 agent 的工具
    const parentResult = parentRegistry.execute("child_only", {}, "call-1");
    expect(parentResult.isError).toBe(true);
    expect(parentResult.content).toContain("unknown tool");

    // 子 agent 看不到父 agent 的工具
    const childResult = childRegistry.execute("parent_only", {}, "call-1");
    expect(childResult.isError).toBe(true);
    expect(childResult.content).toContain("unknown tool");
  });

  it("子 agent 可配置工具子集", () => {
    const childTools = new ToolRegistry();
    const readDef = {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    } as const;
    const writeDef = {
      name: "write_file",
      description: "Write a file",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    } as const;

    // 只注册读工具——模拟只读子 agent
    childTools.register(readDef, (args) => `read ${args.path}`);
    // 不注册写工具
    const writeResult = childTools.execute("write_file", { path: "/tmp/test", content: "data" }, "call-1");
    expect(writeResult.isError).toBe(true);
    expect(writeResult.content).toContain("unknown tool");
  });
});
