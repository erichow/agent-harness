/**
 * 第 2 章测试 — 最小可用 Agent 循环
 *
 * 验证 Provider 协议、MockProvider 行为、以及基础循环的契约。
 * 第 4 章的测试在此基础上增加了 ToolRegistry 集成。
 */
import { describe, it, expect } from "vitest";
import { MAX_ITERATIONS } from "../src/harness/agent.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import type { Provider } from "../src/harness/providers/base.js";
import { Transcript, Message } from "../src/harness/messages.js";

describe("Provider 协议", () => {
  it("Provider 接口定义了 complete 和 astream 方法", () => {
    // Provider 就是个 DUCK 类型接口——有 complete() 和 astream() 就算 Provider
    const provider: Provider = new MockProvider([new ProviderResponse("ok")]);
    expect(provider.name).toBe("mock");
    expect(typeof provider.complete).toBe("function");
    expect(typeof provider.astream).toBe("function");
  });

  it("MockProvider 按顺序返回预设响应", () => {
    const mock = new MockProvider([
      new ProviderResponse("first"),
      new ProviderResponse("second"),
    ]);

    const transcript = new Transcript();
    const r1 = mock.complete(transcript, []);
    const r2 = mock.complete(transcript, []);

    expect(r1.text).toBe("first");
    expect(r2.text).toBe("second");
  });

  it("MockProvider 用完预设响应后抛异常", () => {
    const mock = new MockProvider([new ProviderResponse("only")]);
    const transcript = new Transcript();

    mock.complete(transcript, []);
    expect(() => mock.complete(transcript, [])).toThrow("mock ran out of responses");
  });
});

describe("ProviderResponse", () => {
  it("纯文本响应的 isFinal 为 true", () => {
    const r = new ProviderResponse("hello");
    expect(r.text).toBe("hello");
    expect(r.isFinal).toBe(true);
    expect(r.isToolCall).toBe(false);
  });

  it("工具调用响应的 isToolCall 为 true、isFinal 为 false", () => {
    const r = new ProviderResponse(undefined, [new ToolCallRef("c1", "echo", {})]);
    expect(r.text).toBeUndefined();
    expect(r.isToolCall).toBe(true);
    expect(r.isFinal).toBe(false);
  });

  it("支持批量工具调用", () => {
    const r = new ProviderResponse(undefined, [
      new ToolCallRef("c1", "calc", { expression: "1+1" }),
      new ToolCallRef("c2", "echo", { msg: "hi" }),
    ]);
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls[0].name).toBe("calc");
    expect(r.toolCalls[1].name).toBe("echo");
  });

  it("同时有文本和工具调用时 isToolCall 为 true", () => {
    const r = new ProviderResponse("thinking", [new ToolCallRef("c1", "calc", {})]);
    expect(r.text).toBe("thinking");
    expect(r.isToolCall).toBe(true);
    expect(r.isFinal).toBe(false);
  });

  it("记录 token 计数", () => {
    const r = new ProviderResponse("ok", [], undefined, {}, 10, 20, 5);
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(20);
    expect(r.reasoningTokens).toBe(5);
  });

  it("向后兼容：单数访问器返回第一个工具调用", () => {
    const r = new ProviderResponse(undefined, [
      new ToolCallRef("c1", "first", { a: 1 }),
      new ToolCallRef("c2", "second", { b: 2 }),
    ]);
    expect(r.toolCallId).toBe("c1");
    expect(r.toolName).toBe("first");
    expect(r.toolArgs).toEqual({ a: 1 });
  });
});

describe("MockProvider 流式模式", () => {
  it("astream 从流式预设生成事件", async () => {
    const mock = new MockProvider([]);
    const { textDelta, completed } = await import("../src/harness/providers/events.js");

    mock.setStreamPreset([
      textDelta("Hel"),
      textDelta("lo!"),
      completed(5, 10),
    ]);

    const transcript = new Transcript();
    const events: string[] = [];
    for await (const e of mock.astream(transcript, [])) {
      events.push(e.kind);
    }

    expect(events).toEqual(["text_delta", "text_delta", "completed"]);
  });

  it("astream 从预设响应自动生成流式事件", async () => {
    const mock = new MockProvider([new ProviderResponse("Hello world!")]);
    const transcript = new Transcript();

    const events: string[] = [];
    for await (const e of mock.astream(transcript, [])) {
      events.push(e.kind);
    }

    expect(events).toContain("text_delta");
    expect(events).toContain("completed");
  });

  it("reset 后可以重新使用 MockProvider", () => {
    const mock = new MockProvider([new ProviderResponse("ok")]);
    const transcript = new Transcript();

    expect(mock.complete(transcript, []).text).toBe("ok");
    mock.reset();
    expect(mock.complete(transcript, []).text).toBe("ok");
  });
});

describe("Agent 循环契约", () => {
  it("循环在 isFinal=true 时终止", () => {
    // 这是循环的核心契约：一旦 response.isFinal 为 true，循环返回文本
    const mock = new MockProvider([new ProviderResponse("done")]);
    const transcript = new Transcript();
    transcript.append(Message.userText("hi"));

    const response = mock.complete(transcript, []);
    expect(response.isFinal).toBe(true);
    expect(response.text).toBe("done");
  });

  it("循环在工具调用后继续", () => {
    // 工具调用 → isFinal=false → 需要下一轮
    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("c1", "echo", {})]),
      new ProviderResponse("finally done"),
    ]);
    const transcript = new Transcript();
    transcript.append(Message.userText("go"));

    const r1 = mock.complete(transcript, []);
    expect(r1.isToolCall).toBe(true);
    expect(r1.isFinal).toBe(false);

    const r2 = mock.complete(transcript, []);
    expect(r2.isFinal).toBe(true);
    expect(r2.text).toBe("finally done");
  });

  it("MAX_ITERATIONS 常量已定义", () => {
    expect(MAX_ITERATIONS).toBeGreaterThan(0);
    expect(typeof MAX_ITERATIONS).toBe("number");
  });

  it("空文本响应也能正常结束", () => {
    const mock = new MockProvider([new ProviderResponse("")]);
    const transcript = new Transcript();
    transcript.append(Message.userText("hi"));

    const r = mock.complete(transcript, []);
    expect(r.isFinal).toBe(true);
    expect(r.text).toBe("");
  });
});
