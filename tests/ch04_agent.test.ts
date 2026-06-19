/**
 * 第 4 章测试 — ToolRegistry + agent 集成
 *
 * 第 5 章迁移：ProviderResponse 构造函数签名改为 toolCalls 数组
 *   old: new ProviderResponse(text?, toolCallId?, toolName?, toolArgs?, ...)
 *   new: new ProviderResponse(text?, toolCalls: ToolCallRef[] = [], ...)
 */
import { describe, it, expect } from "vitest";
import { run, MAX_ITERATIONS } from "../src/harness/agent.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

describe("ToolRegistry", () => {
  it("registers and retrieves a tool definition", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "echo", description: "Echo input", inputSchema: {} },
      (args) => `echo: ${args.msg}`,
    );

    expect(registry.has("echo")).toBe(true);
    expect(registry.get("echo")?.name).toBe("echo");
  });

  it("getSchemas returns schemas in registration order", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "a", description: "first", inputSchema: {} },
      () => "a",
    );
    registry.register(
      { name: "b", description: "second", inputSchema: {} },
      () => "b",
    );

    const schemas = registry.getSchemas();
    expect(schemas).toHaveLength(2);
    expect(schemas[0].name).toBe("a");
    expect(schemas[1].name).toBe("b");
  });

  it("execute returns result for valid call", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "ping", description: "Ping", inputSchema: {} },
      () => "pong",
    );

    const block = registry.execute("ping", {}, "call-1");
    expect(block.kind).toBe("tool_result");
    expect(block.content).toBe("pong");
    expect(block.isError).toBe(false);
  });

  it("execute returns error for unknown tool", () => {
    const registry = new ToolRegistry();
    const block = registry.execute("nope", {}, "call-1");
    expect(block.isError).toBe(true);
    expect(block.content).toContain("unknown tool");
  });

  it("execute returns error when required field is missing", () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "greet",
        description: "Greet someone",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      (args) => `Hello, ${args.name}!`,
    );

    const block = registry.execute("greet", {}, "call-1");
    expect(block.isError).toBe(true);
    expect(block.content).toContain("invalid arguments");
    expect(block.content).toContain("required property");
  });

  it("execute catches handler exceptions", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "faulty", description: "Always fails", inputSchema: {} },
      () => { throw new Error("kaboom"); },
    );

    const block = registry.execute("faulty", {}, "call-1");
    expect(block.isError).toBe(true);
    expect(block.content).toBe("faulty raised Error: kaboom");
  });

  it("list returns all tool names", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "x", description: "", inputSchema: {} },
      () => "",
    );
    registry.register(
      { name: "y", description: "", inputSchema: {} },
      () => "",
    );

    expect(registry.list()).toEqual(["x", "y"]);
  });

  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "dup", description: "", inputSchema: {} },
      () => "",
    );
    expect(() =>
      registry.register(
        { name: "dup", description: "", inputSchema: {} },
        () => "",
      )
    ).toThrow("tool already registered");
  });
});

describe("agent loop (Chapter 4 — ToolRegistry)", () => {
  it("returns final answer", () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([new ProviderResponse("Hello!")]);

    expect(run(mock, registry, "Hi")).toBe("Hello!");
  });

  it("executes a tool and returns final answer", () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "echo",
        description: "Echo back",
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      },
      (args) => `echoed: ${args.msg}`,
    );

    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("call-1", "echo", { msg: "hello" })]),
      new ProviderResponse("echoed: hello"),
    ]);

    expect(run(mock, registry, "echo hello")).toBe("echoed: hello");
  });

  it("returns error to model when tool is unknown (no crash)", () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("call-1", "nonexistent", {})]),
      new ProviderResponse("I see it's not available."),
    ]);

    expect(run(mock, registry, "do something")).toBe("I see it's not available.");
  });

  it("returns error to model when args fail validation", () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "greet",
        description: "Greet",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
      (args) => `Hi ${args.name}`,
    );

    // 模型忘记传 name 参数
    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("call-1", "greet", {})]),
      new ProviderResponse("Sorry, I need a name."),
    ]);

    expect(run(mock, registry, "greet")).toBe("Sorry, I need a name.");
  });

  it("returns error to model when tool throws", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "faulty", description: "Faulty", inputSchema: {} },
      () => { throw new Error("kaboom"); },
    );

    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("call-1", "faulty", {})]),
      new ProviderResponse("Fixed it."),
    ]);

    expect(run(mock, registry, "run tool")).toBe("Fixed it.");
  });

  it("throws if agent exceeds MAX_ITERATIONS", () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "ping", description: "Ping", inputSchema: {} },
      () => "pong",
    );

    const responses = Array.from(
      { length: MAX_ITERATIONS + 1 },
      (_, i) => new ProviderResponse(undefined, [new ToolCallRef(`call-${i}`, "ping", {})]),
    );
    const mock = new MockProvider(responses);

    expect(() => run(mock, registry, "go")).toThrow(
      `agent did not finish in ${MAX_ITERATIONS} iterations`,
    );
  });

  it("handles system prompt", () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([new ProviderResponse("OK")]);

    expect(run(mock, registry, "hi", "Be brief.")).toBe("OK");
  });
});
