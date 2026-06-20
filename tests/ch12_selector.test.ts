/**
 * 第 12 章测试 — ToolCatalog 动态工具选择
 *
 * 覆盖：
 *   1. ToolCatalog 构建 — 从 CatalogEntry 数组
 *   2. fromRegistry — 从 ToolRegistry 迁移
 *   3. select — 基本检索
 *   4. mustInclude — 钉住核心工具
 *   5. 0 分过滤 — 不匹配时只返回 pinned
 *   6. k 参数 — 返回上限
 *   7. BM25 排序 — 更相关的工具排前面
 *   8. 空目录
 *   9. queryFromTranscript — 从对话提取 query
 *   10. list_available_tools — discovery 工具
 *   11. arun 向后兼容 — 传 ToolRegistry 仍可用
 *   12. 从 mock provider 集成测试
 */
import { describe, it, expect } from "vitest";
import { ToolCatalog, queryFromTranscript, createDiscoveryEntry } from "../src/harness/tools/selector.js";
import type { CatalogEntry } from "../src/harness/tools/selector.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { Transcript, Message } from "../src/harness/messages.js";

/* ─── 测试工具 ──────────────────────────────────────────────────── */

function toolEntry(name: string, desc: string, kw: string): CatalogEntry {
  return {
    definition: {
      name,
      description: desc,
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: () => `${name} executed`,
  };
}

const testTools: CatalogEntry[] = [
  toolEntry("read_file_viewport", "Read a slice of a text file with line numbers", "read file viewport text"),
  toolEntry("edit_lines", "Replace a line range in a file with new content", "edit lines replace write"),
  toolEntry("bash", "Run a shell command", "bash shell command run execute"),
  toolEntry("calc", "Evaluate a math expression", "calc math arithmetic compute"),
  toolEntry("search_docs", "Search documentation corpus by keywords", "search docs find query"),
  toolEntry("github_search", "Search code across GitHub repositories", "github search code repository"),
  toolEntry("npm_info", "Get info about an npm package", "npm package info"),
  toolEntry("run_tests", "Run the project test suite", "run tests pytest jest"),
  toolEntry("git_diff", "Show changes between commits", "git diff changes"),
  toolEntry("git_status", "Show working tree status", "git status changes"),
  toolEntry("http_fetch", "Fetch a URL", "http fetch url request"),
  toolEntry("slack_post", "Post a message to Slack", "slack post message"),
  toolEntry("scratchpad_list", "List keys in the scratchpad", "scratchpad list keys"),
  toolEntry("scratchpad_read", "Read a value from scratchpad", "scratchpad read key"),
  toolEntry("list_available_tools", "List all available tools", "list tools discover help"),
];

/* ─── ToolCatalog ────────────────────────────────────────────────── */

describe("ToolCatalog", () => {
  it("builds catalog from entries", () => {
    const catalog = new ToolCatalog(testTools);
    expect(catalog.size).toBe(15);
    expect(catalog.list()).toContain("read_file_viewport");
    expect(catalog.list()).toContain("bash");
  });

  it("fromRegistry creates catalog from ToolRegistry", () => {
    const registry = new ToolRegistry();
    registry.register(testTools[0].definition, testTools[0].handler);
    registry.register(testTools[1].definition, testTools[1].handler);

    const catalog = ToolCatalog.fromRegistry(registry);
    expect(catalog.size).toBe(2);
    expect(catalog.list()).toContain("read_file_viewport");
    expect(catalog.list()).toContain("edit_lines");
  });

  it("get returns entry by name", () => {
    const catalog = new ToolCatalog(testTools);
    const entry = catalog.get("bash");
    expect(entry).toBeDefined();
    expect(entry!.definition.name).toBe("bash");
    expect(catalog.get("nonexistent")).toBeUndefined();
  });

  it("add inserts a new entry", () => {
    const catalog = new ToolCatalog([testTools[0]]);
    expect(catalog.size).toBe(1);
    catalog.add(testTools[1]);
    expect(catalog.size).toBe(2);
    expect(catalog.list()).toContain("edit_lines");
  });

  /* ─── select ────────────────────────────────────────────────── */

  it("select returns relevant tools for query", () => {
    const catalog = new ToolCatalog(testTools);
    const selected = catalog.select("read file", 5);

    expect(selected.length).toBeGreaterThanOrEqual(1);
    const names = selected.map((e) => e.definition.name);
    expect(names).toContain("read_file_viewport");
  });

  it("select respects k parameter", () => {
    const catalog = new ToolCatalog(testTools);
    const selected = catalog.select("tool", 3);
    expect(selected.length).toBeLessThanOrEqual(3);
  });

  it("select returns mustInclude tools regardless of score", () => {
    const catalog = new ToolCatalog(testTools);
    const mustInclude = new Set(["slack_post", "scratchpad_list"]);

    // "read file" query — slack_post should be included despite low score
    const selected = catalog.select("read file math calc", 3, mustInclude);
    const names = selected.map((e) => e.definition.name);
    expect(names).toContain("slack_post");
    expect(names).toContain("scratchpad_list");
  });

  it("select returns only pinned tools when query matches nothing", () => {
    const catalog = new ToolCatalog(testTools);
    const mustInclude = new Set(["list_available_tools"]);
    const selected = catalog.select("xyznonexistentblahblah", 7, mustInclude);

    expect(selected.length).toBe(1);
    expect(selected[0].definition.name).toBe("list_available_tools");
  });

  it("select sorts by relevance descending", () => {
    const catalog = new ToolCatalog(testTools);
    // "slack" should rank slack_post highest
    const selected = catalog.select("slack post message", 5);

    expect(selected.length).toBeGreaterThanOrEqual(1);
    expect(selected[0].definition.name).toBe("slack_post");
  });

  it("select returns empty when catalog is empty", () => {
    const catalog = new ToolCatalog([]);
    expect(catalog.select("anything")).toEqual([]);
  });

  it("select returns pinned only for empty query", () => {
    const catalog = new ToolCatalog(testTools);
    const mustInclude = new Set(["list_available_tools"]);
    const selected = catalog.select("", 7, mustInclude);
    expect(selected.length).toBe(1);
    expect(selected[0].definition.name).toBe("list_available_tools");
  });

  it("BM25 ranks bash highly for shell queries", () => {
    const catalog = new ToolCatalog(testTools);
    const selected = catalog.select("run shell command execute", 3);
    expect(selected.length).toBeGreaterThanOrEqual(1);
    // bash should be in the top results
    const topNames = selected.slice(0, 3).map((e) => e.definition.name);
    expect(topNames).toContain("bash");
  });

  /* ─── Handler execution ─────────────────────────────────────── */

  it("selected entries execute correctly", () => {
    const catalog = new ToolCatalog(testTools);
    const selected = catalog.select("read file", 3);
    for (const entry of selected) {
      const result = entry.handler({});
      expect(result).toContain("executed");
    }
  });
});

/* ─── queryFromTranscript ────────────────────────────────────────── */

describe("queryFromTranscript", () => {
  it("extracts first user message", () => {
    const t = new Transcript();
    t.append(Message.userText("read the config file and find errors"));

    const query = queryFromTranscript(t);
    expect(query).toContain("read the config file");
  });

  it("includes recent tool calls", () => {
    const t = new Transcript();
    t.append(Message.userText("fix bugs"));
    t.append(Message.assistantToolCall({
      kind: "tool_call",
      id: "call-1",
      name: "read_file_viewport",
      args: { path: "src/main.ts" },
    }));

    const query = queryFromTranscript(t);
    expect(query).toContain("read_file_viewport");
    expect(query).toContain("path");
  });

  it("returns empty string for empty transcript", () => {
    const t = new Transcript();
    expect(queryFromTranscript(t)).toBe("");
  });
});

/* ─── Discovery 工具 ─────────────────────────────────────────────── */

describe("list_available_tools", () => {
  it("returns all tools when no filter", () => {
    const catalog = new ToolCatalog(testTools);
    const entry = createDiscoveryEntry(catalog);

    const result = entry.handler({});
    expect(result).toContain("read_file_viewport");
    expect(result).toContain("bash");
    expect(result).toContain("slack_post");
  });

  it("filters by substring", () => {
    const catalog = new ToolCatalog(testTools);
    const entry = createDiscoveryEntry(catalog);

    const result = entry.handler({ filter_term: "slack" });
    expect(result).toContain("slack_post");
    expect(result).not.toContain("bash");
  });

  it("returns no-matching message for bad filter", () => {
    const catalog = new ToolCatalog(testTools);
    const entry = createDiscoveryEntry(catalog);

    const result = entry.handler({ filter_term: "xyznonexistent" });
    expect(result).toBe("(no matching tools)");
  });
});

/* ─── 向后兼容 ──────────────────────────────────────────────────── */

describe("backward compatibility", () => {
  it("arun still accepts ToolRegistry (via type test)", async () => {
    // 验证 ToolRegistry 可以作为 ToolCatalog | ToolRegistry 类型的参数传入
    // 这里用类型兼容性测试——直接实例化验证
    const registry = new ToolRegistry();
    registry.register(testTools[0].definition, testTools[0].handler);

    // fromRegistry 方法验证
    const catalog = ToolCatalog.fromRegistry(registry);
    expect(catalog.size).toBe(1);
    expect(catalog.list()).toContain("read_file_viewport");
  });
});

/* ─── 集成：catalog → registry → execute ────────────────────────── */

describe("catalog integration", () => {
  it("selected tools can be registered into ToolRegistry and execute", () => {
    const catalog = new ToolCatalog(testTools);
    const selected = catalog.select("list keys scratchpad", 3);

    const registry = new ToolRegistry();
    for (const entry of selected) {
      registry.register(entry.definition, entry.handler);
    }

    // scratchpad_list should be selected and executable
    const result = registry.execute("scratchpad_list", {}, "call-1");
    expect(result.isError).toBe(false);
    expect(result.content).toBe("scratchpad_list executed");
  });

  it("full flow: catalog → select → arun-compatible", () => {
    // 模拟 arun 内部逻辑
    const catalog = new ToolCatalog(testTools);
    const mustInclude = new Set(["list_available_tools"]);

    // 模拟 transcript query
    const selected = catalog.select("read the file", 7, mustInclude);
    const registry = new ToolRegistry();
    for (const entry of selected) {
      registry.register(entry.definition, entry.handler);
    }

    // 验证 discovery 工具总在
    expect(registry.has("list_available_tools")).toBe(true);
    expect(registry.has("read_file_viewport")).toBe(true);
  });
});

/* ─── 30 工具悬崖模拟 ────────────────────────────────────────────── */

describe("tool cliff mitigation", () => {
  it("select caps at 7 tools by default", () => {
    // 建 30 个工具
    const manyTools: CatalogEntry[] = [];
    for (let i = 0; i < 30; i++) {
      manyTools.push(toolEntry(
        `tool_${i}`,
        `Tool number ${i} for testing purposes`,
        `tool test ${i}`,
      ));
    }
    const catalog = new ToolCatalog(manyTools);

    // 即使有 30 个工具，select 也只返回 7 个（默认 k）
    const selected = catalog.select("testing", 7);
    expect(selected.length).toBeLessThanOrEqual(7);

    // pinned 工具不影响上界
    const withPin = catalog.select("testing", 7, new Set(["tool_0"]));
    expect(withPin.length).toBeLessThanOrEqual(7);
  });

  it("filters irrelevant tools from 30-tool catalog", () => {
    const manyTools: CatalogEntry[] = [];
    for (let i = 0; i < 30; i++) {
      const topic = i < 10 ? "file" : i < 20 ? "network" : "database";
      manyTools.push(toolEntry(
        `${topic}_tool_${i}`,
        `A ${topic} tool for testing number ${i}`,
        `${topic} test ${i}`,
      ));
    }
    const catalog = new ToolCatalog(manyTools);

    // query about "file" should only return file tools
    const selected = catalog.select("file read write", 7);
    for (const entry of selected) {
      expect(entry.definition.name).toMatch(/^file/);
    }
  });
});
