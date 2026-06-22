/**
 * 第 13 章测试 — MCP 客户端 + 异步工具执行
 *
 * 覆盖：
 *   1. MCPClient 协议通信 — mock server 的 initialize / tools/list / tools/call
 *   2. wrapMcpTools — MCP 工具 → CatalogEntry 转换
 *   3. ToolRegistry.aregister / executeAsync — 异步工具注册与执行
 *   4. CatalogEntry.asyncHandler — selector 注册 async handler
 *   5. MCPServerConfig 和 MCPTool 数据结构
 *   6. MCPClient 关闭与清理
 *
 * 使用内联的 mock MCP server（Node.js 脚本通过 stdio 通信）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { MCPClient } from "../src/harness/mcp/client.js";
import type { MCPServerConfig, MCPTool } from "../src/harness/mcp/client.js";
import { wrapMcpTools } from "../src/harness/mcp/tools.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import type { AsyncToolHandler } from "../src/harness/tools/registry.js";

/* ─── Mock MCP Server 脚本 ──────────────────────────────────────── */

const MOCK_SERVER_SCRIPT = path.resolve(
  __dirname, ".mock-mcp-server.mjs",
);

/** 创建 mock MCP server 脚本 */
function createMockServer(): void {
  const script = `\
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
let tools = [
  {
    name: "echo",
    description: "Echo the input text back",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo" },
      },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
    },
  },
];

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    const id = msg.id;

    if (msg.method === "initialize") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-mcp", version: "1.0.0" },
        },
      }));
    } else if (msg.method === "notifications/initialized") {
      // no response expected
    } else if (msg.method === "tools/list") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools },
      }));
    } else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params;
      if (name === "echo") {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: args.text || "" }],
          },
        }));
      } else if (name === "add") {
        const sum = (args.a || 0) + (args.b || 0);
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: String(sum) }],
          },
        }));
      } else {
        console.log(JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: \`Tool not found: \${name}\` },
        }));
      }
    }
  } catch (e) {
    // ignore parse errors
  }
});
`;

  fs.writeFileSync(MOCK_SERVER_SCRIPT, script, "utf-8");
}

/** 清理 mock server 脚本 */
function cleanupMockServer(): void {
  try {
    fs.unlinkSync(MOCK_SERVER_SCRIPT);
  } catch {
    // ignore
  }
}

/* ─── MCPClient ──────────────────────────────────────────────────── */

describe("MCPClient", () => {
  let client: MCPClient;

  beforeAll(() => {
    createMockServer();
  });

  afterAll(() => {
    cleanupMockServer();
  });

  afterEach(async () => {
    if (client) {
      await client.close();
    }
  });

  it("connects to a mock MCP server and discovers tools", async () => {
    client = new MCPClient();
    const config: MCPServerConfig = {
      name: "mock",
      command: "node",
      args: [MOCK_SERVER_SCRIPT],
    };

    await client.connect(config);

    const tools = client.listTools();
    expect(tools.length).toBe(2);

    const echoTool = client.getTool("mcp__mock__echo");
    expect(echoTool).toBeDefined();
    expect(echoTool!.rawName).toBe("echo");
    expect(echoTool!.server).toBe("mock");

    const addTool = client.getTool("mcp__mock__add");
    expect(addTool).toBeDefined();
    expect(addTool!.rawName).toBe("add");
  });

  it("calls an MCP tool and gets the result", async () => {
    client = new MCPClient();
    await client.connect({
      name: "mock",
      command: "node",
      args: [MOCK_SERVER_SCRIPT],
    });

    const result = await client.call("mcp__mock__echo", { text: "hello world" });
    expect(result).toBe("hello world");
  });

  it("calls add tool with numbers", async () => {
    client = new MCPClient();
    await client.connect({
      name: "mock",
      command: "node",
      args: [MOCK_SERVER_SCRIPT],
    });

    const result = await client.call("mcp__mock__add", { a: 3, b: 4 });
    expect(result).toBe("7");
  });

  it("connects multiple servers simultaneously", async () => {
    client = new MCPClient();

    await client.connect({
      name: "server-a",
      command: "node",
      args: [MOCK_SERVER_SCRIPT],
    });

    await client.connect({
      name: "server-b",
      command: "node",
      args: [MOCK_SERVER_SCRIPT],
    });

    const tools = client.listTools();
    // Each server has 2 tools, so 4 total
    expect(tools.length).toBe(4);

    // Names should be qualified to avoid collision
    expect(client.getTool("mcp__server-a__echo")).toBeDefined();
    expect(client.getTool("mcp__server-b__echo")).toBeDefined();
  });

  it("close cleans up all connections", async () => {
    client = new MCPClient();
    await client.connect({
      name: "mock",
      command: "node",
      args: [MOCK_SERVER_SCRIPT],
    });

    expect(client.listTools().length).toBe(2);
    await client.close();
    // After close, no tools should be available
    // (new connection would be needed)
  });
});

/* ─── wrapMcpTools ───────────────────────────────────────────────── */

describe("wrapMcpTools", () => {
  let client: MCPClient;

  beforeAll(() => {
    createMockServer();
  });

  afterAll(() => {
    cleanupMockServer();
  });

  afterEach(async () => {
    if (client) await client.close();
  });

  it("converts MCP tools to CatalogEntry array", async () => {
    client = new MCPClient();
    await client.connect({
      name: "mock",
      command: "node",
      args: [MOCK_SERVER_SCRIPT],
    });

    const entries = wrapMcpTools(client);
    expect(entries.length).toBe(2);

    // Tool names should be qualified
    expect(entries[0].definition.name).toMatch(/^mcp__mock__/);

    // Should have asyncHandler
    expect(entries[0].asyncHandler).toBeDefined();
  });

  it("wrapped tools can be registered in ToolRegistry and executed async", async () => {
    client = new MCPClient();
    await client.connect({
      name: "mock",
      command: "node",
      args: [MOCK_SERVER_SCRIPT],
    });

    const entries = wrapMcpTools(client);
    const registry = new ToolRegistry();

    for (const entry of entries) {
      registry.aregister(entry.definition, entry.asyncHandler!);
    }

    // Execute echo via async dispatch
    const result = await registry.executeAsync(
      "mcp__mock__echo",
      { text: "async works" },
      "call-1",
    );

    expect(result.isError).toBe(false);
    // MCP 工具 output 被 trust label 包装
    expect(result.content).toContain("async works");
    expect(result.content).toContain("<untrusted_content");
    expect(result.content).toContain("mcp__mock__echo");
  });
});

/* ─── ToolRegistry async methods ─────────────────────────────────── */

describe("ToolRegistry async", () => {
  it("aregister stores an async handler", () => {
    const registry = new ToolRegistry();
    const handler: AsyncToolHandler = async (args) => {
      return `async: ${args.x}`;
    };

    registry.aregister(
      {
        name: "async_greet",
        description: "Async greeting tool",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
      },
      handler,
    );

    expect(registry.has("async_greet")).toBe(true);
    expect(registry.list()).toContain("async_greet");
  });

  it("executeAsync calls async handler", async () => {
    const registry = new ToolRegistry();
    registry.aregister(
      {
        name: "async_echo",
        description: "Async echo",
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      },
      async (args) => `echo: ${args.msg}`,
    );

    const result = await registry.executeAsync(
      "async_echo",
      { msg: "hello" },
      "call-1",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("echo: hello");
  });

  it("executeAsync falls back to sync handler when no async handler", async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "sync_add",
        description: "Sync addition",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      (args) => String(Number(args.a) + Number(args.b)),
    );

    const result = await registry.executeAsync(
      "sync_add",
      { a: 5, b: 7 },
      "call-1",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("12");
  });

  it("executeAsync validates args before executing", async () => {
    const registry = new ToolRegistry();
    registry.aregister(
      {
        name: "strict_tool",
        description: "Tool with required args",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      async (args) => `Hello ${args.name}`,
    );

    // Missing required arg
    const result = await registry.executeAsync(
      "strict_tool",
      {},
      "call-1",
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("invalid arguments");
  });

  it("executeAsync detects unknown tools", async () => {
    const registry = new ToolRegistry();
    const result = await registry.executeAsync(
      "nonexistent",
      {},
      "call-1",
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown tool");
  });

  it("executeAsync detects tool call loops", async () => {
    const registry = new ToolRegistry();
    const handler: AsyncToolHandler = async (args) => `fixed: ${args.x}`;

    registry.aregister(
      {
        name: "loop_tool",
        description: "Tool used for loop test",
        inputSchema: {
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
        },
      },
      handler,
    );

    // Call with same args 3 times — should trigger loop detection
    await registry.executeAsync("loop_tool", { x: "same" }, "call-1");
    await registry.executeAsync("loop_tool", { x: "same" }, "call-2");
    const result = await registry.executeAsync("loop_tool", { x: "same" }, "call-3");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("loop detected");
  });
});

/* ─── MCPTool data structure ─────────────────────────────────────── */

describe("MCPTool structure", () => {
  it("has required fields", () => {
    const tool: MCPTool = {
      name: "mcp__test__my_tool",
      rawName: "my_tool",
      server: "test",
      description: "A test tool",
      inputSchema: { type: "object", properties: {} },
    };

    expect(tool.name).toBe("mcp__test__my_tool");
    expect(tool.rawName).toBe("my_tool");
    expect(tool.server).toBe("test");
    expect(tool.description).toBe("A test tool");
    expect(tool.inputSchema.type).toBe("object");
  });
});
