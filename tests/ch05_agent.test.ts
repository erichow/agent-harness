/**
 * 第 5 章测试 — 流式事件 / accumulate / arun / 重试 / FallbackProvider
 */
import { describe, it, expect } from "vitest";
import { arun, MAX_ITERATIONS } from "../src/harness/agent.js";
import {
  ProviderResponse,
  ToolCallRef,
  accumulate,
} from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import {
  textDelta,
  reasoningDelta,
  toolCallStart,
  toolCallDelta,
  completed,
  isTextDelta,
  isToolCallStart,
  isToolCallDelta,
  isCompleted,
} from "../src/harness/providers/events.js";
import type { StreamEvent } from "../src/harness/providers/events.js";
import { withRetry, isRetryable, backoffDelay } from "../src/harness/providers/retry.js";
import { FallbackProvider } from "../src/harness/providers/fallback.js";

/* ─── StreamEvent 构建与 type guard ──────────────────────────────── */

describe("StreamEvent", () => {
  it("builds TextDelta and guards it", () => {
    const e = textDelta("hello");
    expect(e.kind).toBe("text_delta");
    expect(e.text).toBe("hello");
    expect(isTextDelta(e)).toBe(true);
  });

  it("builds ReasoningDelta", () => {
    const e = reasoningDelta("thinking...");
    expect(e.kind).toBe("reasoning_delta");
    expect(e.text).toBe("thinking...");
  });

  it("builds ToolCallStart and ToolCallDelta", () => {
    const start = toolCallStart("call-1", "echo");
    expect(start.kind).toBe("tool_call_start");
    expect(start.id).toBe("call-1");
    expect(start.name).toBe("echo");
    expect(isToolCallStart(start)).toBe(true);

    const delta = toolCallDelta("call-1", '{"msg":');
    expect(delta.kind).toBe("tool_call_delta");
    expect(delta.argsFragment).toBe('{"msg":');
    expect(isToolCallDelta(delta)).toBe(true);
  });

  it("builds Completed", () => {
    const e = completed(10, 20, 5, { foo: "bar" });
    expect(e.kind).toBe("completed");
    expect(e.inputTokens).toBe(10);
    expect(e.outputTokens).toBe(20);
    expect(e.reasoningTokens).toBe(5);
    expect(e.reasoningMetadata).toEqual({ foo: "bar" });
    expect(isCompleted(e)).toBe(true);
  });
});

/* ─── accumulate ─────────────────────────────────────────────────── */

describe("accumulate", () => {
  it("accumulates plain text stream", async () => {
    const events: StreamEvent[] = [
      textDelta("Hello"),
      textDelta(", "),
      textDelta("world!"),
      completed(10, 20),
    ];

    const response = await accumulate(events);
    expect(response.text).toBe("Hello, world!");
    expect(response.isFinal).toBe(true);
    expect(response.inputTokens).toBe(10);
    expect(response.outputTokens).toBe(20);
  });

  it("accumulates single tool call", async () => {
    const events: StreamEvent[] = [
      toolCallStart("call-1", "echo"),
      toolCallDelta("call-1", '{"msg": "hello"}'),
      completed(5, 15),
    ];

    const response = await accumulate(events);
    expect(response.isToolCall).toBe(true);
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].id).toBe("call-1");
    expect(response.toolCalls[0].name).toBe("echo");
    expect(response.toolCalls[0].args).toEqual({ msg: "hello" });
  });

  it("accumulates batch tool calls", async () => {
    const events: StreamEvent[] = [
      toolCallStart("call-1", "search"),
      toolCallDelta("call-1", '{"q": "weather"'),
      toolCallDelta("call-1", '}'),
      toolCallStart("call-2", "calc"),
      toolCallDelta("call-2", '{"expr": "2+2"}'),
      completed(10, 30),
    ];

    const response = await accumulate(events);
    expect(response.isToolCall).toBe(true);
    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls[0].name).toBe("search");
    expect(response.toolCalls[0].args).toEqual({ q: "weather" });
    expect(response.toolCalls[1].name).toBe("calc");
    expect(response.toolCalls[1].args).toEqual({ expr: "2+2" });
  });

  it("handles orphan delta (no prior start)", async () => {
    const events: StreamEvent[] = [
      toolCallDelta("", '{"msg": "hi"}'),
      completed(1, 1),
    ];

    const response = await accumulate(events);
    expect(response.isToolCall).toBe(true);
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].args).toEqual({ msg: "hi" });
  });

  it("handles JSON parse failure gracefully", async () => {
    const events: StreamEvent[] = [
      toolCallStart("call-1", "echo"),
      toolCallDelta("call-1", "not-json"),
      completed(1, 1),
    ];

    const response = await accumulate(events);
    expect(response.isToolCall).toBe(true);
    expect(response.toolCalls[0].args).toHaveProperty("_raw", "not-json");
  });

  it("accumulates text + reasoning", async () => {
    const events: StreamEvent[] = [
      reasoningDelta("I need to think about this..."),
      textDelta("The answer is 42."),
      completed(10, 20, 5),
    ];

    const response = await accumulate(events);
    expect(response.text).toBe("The answer is 42.");
    expect(response.reasoningText).toBe("I need to think about this...");
    expect(response.reasoningTokens).toBe(5);
  });
});

/* ─── arun 集成测试 ──────────────────────────────────────────────── */

describe("arun (Chapter 5 — async)", () => {
  it("returns final answer", async () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([new ProviderResponse("Hello!")]);

    const result = await arun(mock, registry, "Hi");
    expect(result).toBe("Hello!");
  });

  it("executes a tool and returns final answer", async () => {
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

    const result = await arun(mock, registry, "echo hello");
    expect(result).toBe("echoed: hello");
  });

  it("executes batch tool calls", async () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: "a", description: "Tool A", inputSchema: {} },
      () => "result-a",
    );
    registry.register(
      { name: "b", description: "Tool B", inputSchema: {} },
      () => "result-b",
    );

    const mock = new MockProvider([
      new ProviderResponse(undefined, [
        new ToolCallRef("call-1", "a", {}),
        new ToolCallRef("call-2", "b", {}),
      ]),
      new ProviderResponse("both done"),
    ]);

    const result = await arun(mock, registry, "run both");
    expect(result).toBe("both done");
  });

  it("returns error to model when tool is unknown (no crash)", async () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("call-1", "nonexistent", {})]),
      new ProviderResponse("I see it's not available."),
    ]);

    const result = await arun(mock, registry, "do something");
    expect(result).toBe("I see it's not available.");
  });

  it("returns error to model when args fail validation", async () => {
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

    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("call-1", "greet", {})]),
      new ProviderResponse("Sorry, I need a name."),
    ]);

    const result = await arun(mock, registry, "greet");
    expect(result).toBe("Sorry, I need a name.");
  });

  it("calls onEvent for each StreamEvent", async () => {
    const registry = new ToolRegistry();
    const events: StreamEvent[] = [];
    const mock = new MockProvider([new ProviderResponse("done")]);

    await arun(mock, registry, "hi", undefined, undefined, (e) => { events.push(e); });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === "text_delta" || e.kind === "completed")).toBe(true);
  });

  it("throws if agent exceeds MAX_ITERATIONS", async () => {
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

    await expect(arun(mock, registry, "go")).rejects.toThrow(
      `agent did not finish in ${MAX_ITERATIONS} iterations`,
    );
  });

  it("handles system prompt", async () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([new ProviderResponse("OK")]);

    const result = await arun(mock, registry, "hi", undefined, "Be brief.");
    expect(result).toBe("OK");
  });
});

/* ─── backoffDelay + isRetryable ──────────────────────────────────── */

describe("retry utilities", () => {
  it("backoffDelay returns increasing delays", () => {
    const d0 = backoffDelay(0, 30_000);
    const d1 = backoffDelay(1, 30_000);
    const d2 = backoffDelay(2, 30_000);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it("backoffDelay respects maxMs", () => {
    const d = backoffDelay(10, 5_000);
    expect(d).toBeLessThanOrEqual(5_000);
  });

  it("isRetryable returns true for 429 and 5xx", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it("isRetryable returns false for 4xx non-429", () => {
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it("withRetry succeeds on first try", async () => {
    const result = await withRetry(async () => "ok", { maxRetries: 3 });
    expect(result).toBe("ok");
  });

  it("withRetry retries on retryable error then succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw { status: 503 };
      return "success";
    }, { maxRetries: 3 });
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("withRetry throws after exhausting retries", async () => {
    await expect(
      withRetry(async () => { throw { status: 503 }; }, { maxRetries: 2 }),
    ).rejects.toEqual({ status: 503 });
  });

  it("withRetry does not retry non-retryable errors", async () => {
    let attempts = 0;
    await expect(
      withRetry(async () => {
        attempts++;
        throw { status: 400 };
      }, { maxRetries: 3 }),
    ).rejects.toEqual({ status: 400 });
    expect(attempts).toBe(1);
  });
});

/* ─── FallbackProvider ────────────────────────────────────────────── */

describe("FallbackProvider", () => {
  it("uses primary when primary succeeds", () => {
    const primary = new MockProvider([new ProviderResponse("primary")]);
    const fallback = new MockProvider([new ProviderResponse("fallback")]);
    const fp = new FallbackProvider(primary, fallback);

    // MockProvider's complete() returns its responses in order
    // We need to set up both with matching response sequences.
    // Actually, primary succeeds on first call.
    const result = fp.complete(
      { messages: [], system: undefined } as any,
      [],
    );
    expect(result.text).toBe("primary");
  });

  it("uses fallback when primary throws retryable status", () => {
    // Create a custom provider that throws on first call
    const primary: any = {
      name: "faulty-primary",
      complete: () => { throw { status: 503 }; },
      astream: async function*() { throw { status: 503 }; },
    };
    const fallback = new MockProvider([new ProviderResponse("fallback-ok")]);
    const fp = new FallbackProvider(primary, fallback);

    const result = fp.complete(
      { messages: [], system: undefined } as any,
      [],
    );
    expect(result.text).toBe("fallback-ok");
  });

  it("throws when both primary and fallback fail", () => {
    const primary: any = {
      name: "faulty-primary",
      complete: () => { throw { status: 503 }; },
      astream: async function*() { throw { status: 503 }; },
    };
    const fallback: any = {
      name: "faulty-fallback",
      complete: () => { throw { status: 503 }; },
      astream: async function*() { throw { status: 503 }; },
    };
    const fp = new FallbackProvider(primary, fallback);

    expect(() =>
      fp.complete({ messages: [], system: undefined } as any, [])
    ).toThrow();
  });

  it("does not fallback on non-fallback status code", () => {
    const primary: any = {
      name: "faulty-primary",
      complete: () => { throw { status: 400 }; },
      astream: async function*() { throw { status: 400 }; },
    };
    const fallback = new MockProvider([new ProviderResponse("should-not-reach")]);
    const fp = new FallbackProvider(primary, fallback);

    expect(() =>
      fp.complete({ messages: [], system: undefined } as any, [])
    ).toThrow();
  });
});
