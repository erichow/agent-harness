/**
 * 第 2 章 agent 循环测试
 */
import { describe, it, expect } from "vitest";
import { run, MAX_ITERATIONS } from "../src/harness/agent.js";
import { MockProvider } from "../src/harness/providers/mock.js";

describe("agent loop (Chapter 2)", () => {
  it("returns final answer for a text response", () => {
    const mock = new MockProvider([{ kind: "text", text: "Hello!" }]);

    const answer = run(mock, {}, [], "Hi");
    expect(answer).toBe("Hello!");
  });

  it("executes a tool and returns the final answer", () => {
    const mock = new MockProvider([
      {
        kind: "tool_call",
        tool_name: "echo",
        tool_args: { msg: "hello" },
        tool_call_id: "call-1",
      },
      { kind: "text", text: "echoed: hello" },
    ]);

    const tools = {
      echo: (args: Record<string, unknown>) => `echo: ${args.msg}`,
    };

    const schemas = [
      {
        name: "echo",
        description: "Echo back a message",
        input_schema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      },
    ];

    const answer = run(mock, tools, schemas, "echo hello");
    expect(answer).toBe("echoed: hello");
  });

  it("throws if tool is unknown", () => {
    const mock = new MockProvider([
      {
        kind: "tool_call",
        tool_name: "nonexistent",
        tool_args: {},
        tool_call_id: "call-1",
      },
    ]);

    expect(() => run(mock, {}, [], "do something")).toThrow(
      "unknown tool: nonexistent",
    );
  });

  it("throws if agent exceeds MAX_ITERATIONS", () => {
    // Mock that keeps returning tool_call forever
    const responses = Array.from({ length: MAX_ITERATIONS + 1 }, (_, i) => ({
      kind: "tool_call" as const,
      tool_name: "ping",
      tool_args: {},
      tool_call_id: `call-${i}`,
    }));
    const mock = new MockProvider(responses);
    const tools = { ping: () => "pong" };

    expect(() => run(mock, tools, [], "go")).toThrow(
      `agent did not finish in ${MAX_ITERATIONS} iterations`,
    );
  });
});
