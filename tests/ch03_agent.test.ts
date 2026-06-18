/**
 * 第 3 章 agent 循环测试（更新后 API）
 */
import { describe, it, expect } from "vitest";
import { run, MAX_ITERATIONS } from "../src/harness/agent.js";
import { ProviderResponse } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";

describe("agent loop (Chapter 3)", () => {
  it("returns final answer for a text response", () => {
    const mock = new MockProvider([new ProviderResponse("Hello!")]);

    const answer = run(mock, {}, [], "Hi");
    expect(answer).toBe("Hello!");
  });

  it("executes a tool and returns the final answer", () => {
    const mock = new MockProvider([
      new ProviderResponse(
        undefined,
        "call-1",
        "echo",
        { msg: "hello" },
      ),
      new ProviderResponse("echoed: hello"),
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

  it("returns error to model when tool is unknown (instead of crashing)", () => {
    const mock = new MockProvider([
      new ProviderResponse(
        undefined,
        "call-1",
        "nonexistent",
        {},
      ),
      new ProviderResponse("I see the tool isn't available."),
    ]);

    const answer = run(mock, {}, [], "do something");
    expect(answer).toBe("I see the tool isn't available.");
  });

  it("returns error to model when tool throws", () => {
    const mock = new MockProvider([
      new ProviderResponse(
        undefined,
        "call-1",
        "faulty",
        {},
      ),
      new ProviderResponse("Fixed it."),
    ]);

    const tools = {
      faulty: () => { throw new Error("kaboom"); },
    };

    const answer = run(mock, tools, [], "run tool");
    expect(answer).toBe("Fixed it.");
  });

  it("throws if agent exceeds MAX_ITERATIONS", () => {
    // Mock that keeps returning tool_call forever
    const responses = Array.from(
      { length: MAX_ITERATIONS + 1 },
      (_, i) => new ProviderResponse(
        undefined,
        `call-${i}`,
        "ping",
        {},
      ),
    );
    const mock = new MockProvider(responses);
    const tools = { ping: () => "pong" };

    expect(() => run(mock, tools, [], "go")).toThrow(
      `agent did not finish in ${MAX_ITERATIONS} iterations`,
    );
  });

  it("handles system prompt", () => {
    const mock = new MockProvider([new ProviderResponse("OK")]);
    const answer = run(mock, {}, [], "hi", "Be brief.");
    expect(answer).toBe("OK");
  });
});
