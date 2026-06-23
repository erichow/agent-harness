/**
 * DeepSeekProvider 测试
 *
 * 测试策略：翻译函数（纯逻辑，无 IO）直接做单元测试；
 * acomplete / astream 通过 mock OpenAI client 验证。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DeepSeekProvider, toOpenAIMessages, toOpenAITools, toProviderResponse } from "../src/harness/providers/deepseek.js";
import { Transcript, Message, textBlock, toolCallBlock, toolResultBlock, reasoningBlock } from "../src/harness/messages.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";

/* ─── 环境变量管理 ─────────────────────────────────────────────── */

/** 保存真实 key，以便真机测试恢复 */
const REAL_API_KEY = process.env.DEEPSEEK_API_KEY;

/* ─── Constructor ───────────────────────────────────────────────── */

describe("DeepSeekProvider 构造", () => {
  afterEach(() => {
    process.env.DEEPSEEK_API_KEY = REAL_API_KEY;
  });

  it("从环境变量读取 apiKey", () => {
    process.env.DEEPSEEK_API_KEY = "test-key-12345";
    const provider = new DeepSeekProvider();
    expect(provider.name).toBe("deepseek");
  });

  it("显式传入 apiKey 优先于环境变量", () => {
    const provider = new DeepSeekProvider({ apiKey: "explicit-key" });
    expect(provider.name).toBe("deepseek");
  });

  it("没有 apiKey 时抛错", () => {
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => new DeepSeekProvider()).toThrow("DeepSeek API key required");
  });

  it("接受自定义 baseURL 和 model", () => {
    const provider = new DeepSeekProvider({
      apiKey: "k",
      baseURL: "https://custom.deepseek.com",
      model: "deepseek-reasoner",
    });
    expect(provider.name).toBe("deepseek");
  });
});

/* ─── complete() ────────────────────────────────────────────────── */

describe("complete()", () => {
  it("同步 complete 抛出指引错误", () => {
    const provider = new DeepSeekProvider();
    const transcript = new Transcript();
    transcript.append(Message.userText("hi"));
    expect(() => provider.complete(transcript, [])).toThrow(
      "DeepSeekProvider.complete() is not available",
    );
  });
});

/* ─── toOpenAIMessages ──────────────────────────────────────────── */

describe("toOpenAIMessages", () => {
  it("空 transcript 返回空数组", () => {
    const t = new Transcript();
    expect(toOpenAIMessages(t)).toEqual([]);
  });

  it("system prompt 放在第一条", () => {
    const t = new Transcript("Be helpful");
    t.append(Message.userText("hi"));
    const msgs = toOpenAIMessages(t);
    expect(msgs[0]).toEqual({ role: "system", content: "Be helpful" });
  });

  it("user 文本消息翻译正确", () => {
    const t = new Transcript();
    t.append(Message.userText("What is 2 + 2?"));
    const msgs = toOpenAIMessages(t);
    expect(msgs).toContainEqual({ role: "user", content: "What is 2 + 2?" });
  });

  it("assistant 文本消息翻译正确", () => {
    const t = new Transcript();
    t.append(Message.assistantText("The answer is 4"));
    const msgs = toOpenAIMessages(t);
    expect(msgs).toContainEqual({ role: "assistant", content: "The answer is 4" });
  });

  it("assistant 工具调用翻译为 tool_calls", () => {
    const t = new Transcript();
    t.append(Message.assistantToolCall(
      toolCallBlock("call-1", "calc", { expression: "2+2" }),
    ));
    const msgs = toOpenAIMessages(t);
    expect(msgs[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "calc", arguments: '{"expression":"2+2"}' },
      }],
    });
  });

  it("tool result 翻译为 role: tool", () => {
    const t = new Transcript();
    const tr = toolResultBlock("call-1", "4");
    t.append(Message.userText("What is 2+2?"));
    t.append(Message.toolResult(tr));
    const msgs = toOpenAIMessages(t);
    // tool result 应该出现
    expect(msgs).toContainEqual({
      role: "tool",
      tool_call_id: "call-1",
      content: "4",
    });
  });

  it("多条消息按顺序翻译", () => {
    const t = new Transcript();
    t.append(Message.userText("hi"));
    t.append(Message.assistantText("hello"));
    t.append(Message.userText("calc 1+1"));
    const msgs = toOpenAIMessages(t);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[2].role).toBe("user");
  });
});

/* ─── toOpenAITools ─────────────────────────────────────────────── */

describe("toOpenAITools", () => {
  it("空数组返回空数组", () => {
    expect(toOpenAITools([])).toEqual([]);
  });

  it("翻译单个工具 schema", () => {
    const schemas = [
      {
        name: "calc",
        description: "Evaluate an expression",
        inputSchema: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
      },
    ];
    const tools = toOpenAITools(schemas);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "calc",
        description: "Evaluate an expression",
        parameters: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
      },
    });
  });

  it("翻译多个工具", () => {
    const schemas = [
      { name: "a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
      { name: "b", description: "Tool B", inputSchema: { type: "object", properties: {} } },
    ];
    expect(toOpenAITools(schemas)).toHaveLength(2);
  });
});

/* ─── toProviderResponse ────────────────────────────────────────── */

describe("toProviderResponse", () => {
  const baseChoice = {
    index: 0,
    finish_reason: "stop" as const,
    logprobs: null,
  };

  it("纯文本响应", () => {
    const response = toProviderResponse({
      id: "r1",
      object: "chat.completion",
      created: 100,
      model: "deepseek-chat",
      choices: [{ ...baseChoice, message: { role: "assistant", content: "Hello!" } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });

    expect(response.text).toBe("Hello!");
    expect(response.isFinal).toBe(true);
    expect(response.inputTokens).toBe(10);
    expect(response.outputTokens).toBe(20);
  });

  it("工具调用响应", () => {
    const response = toProviderResponse({
      id: "r2",
      object: "chat.completion",
      created: 101,
      model: "deepseek-chat",
      choices: [{
        ...baseChoice,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "calc", arguments: '{"expression":"2+2"}' },
          }],
        },
      }],
    });

    expect(response.isToolCall).toBe(true);
    expect(response.isFinal).toBe(false);
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].name).toBe("calc");
    expect(response.toolCalls[0].args).toEqual({ expression: "2+2" });
  });

  it("批量工具调用", () => {
    const response = toProviderResponse({
      id: "r3",
      object: "chat.completion",
      created: 102,
      model: "deepseek-chat",
      choices: [{
        ...baseChoice,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "calc", arguments: '{"a":1,"b":2}' } },
            { id: "c2", type: "function", function: { name: "echo", arguments: '{"msg":"hi"}' } },
          ],
        },
      }],
    });

    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls[0].name).toBe("calc");
    expect(response.toolCalls[1].name).toBe("echo");
  });

  it("包含推理内容 (reasoning_content)", () => {
    const response = toProviderResponse({
      id: "r4",
      object: "chat.completion",
      created: 103,
      model: "deepseek-chat",
      choices: [{
        ...baseChoice,
        message: {
          role: "assistant",
          content: "Final answer",
          // DeepSeek 在 message 层面附加 reasoning_content
          reasoning_content: "Let me think...",
        } as Record<string, unknown>,
      }],
    });

    expect(response.text).toBe("Final answer");
    expect(response.reasoningText).toBe("Let me think...");
  });

  it("无 choices 时返回空响应", () => {
    const response = toProviderResponse({
      id: "r5",
      object: "chat.completion",
      created: 104,
      model: "deepseek-chat",
      choices: [],
    });

    expect(response.text).toBe("");
    expect(response.isFinal).toBe(true);
    expect(response.toolCalls).toHaveLength(0);
  });

  it("JSON 解析失败时暴露原始 buffer", () => {
    const response = toProviderResponse({
      id: "r6",
      object: "chat.completion",
      created: 105,
      model: "deepseek-chat",
      choices: [{
        ...baseChoice,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "c1",
            type: "function",
            function: { name: "bad", arguments: "not-json" },
          }],
        },
      }],
    });

    expect(response.toolCalls[0].args).toEqual({ _raw: "not-json" });
  });
});

/* ─── astream（mock OpenAI） ────────────────────────────────────── */

describe("astream（mock）", () => {
  it("yield textDelta 事件", async () => {
    // 构造一个 mock 快照流
    async function* mockStream(): AsyncIterable<unknown> {
      yield {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 100,
        model: "deepseek-chat",
        choices: [{
          index: 0,
          delta: { content: "Hello" },
          finish_reason: null,
        }],
      };
      yield {
        id: "chunk-2",
        object: "chat.completion.chunk",
        created: 100,
        model: "deepseek-chat",
        choices: [{
          index: 0,
          delta: { content: " world!" },
          finish_reason: null,
        }],
      };
      // 最后一个 chunk 带 usage
      yield {
        id: "chunk-3",
        object: "chat.completion.chunk",
        created: 100,
        model: "deepseek-chat",
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
      };
    }

    // 用 client injection 来 mock
    const provider = new DeepSeekProvider();
    (provider as unknown as Record<string, unknown>).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream()),
        },
      },
    };

    const transcript = new Transcript();
    transcript.append(Message.userText("hi"));

    const kinds: string[] = [];
    let text = "";
    for await (const event of provider.astream(transcript, [])) {
      kinds.push(event.kind);
      if (event.kind === "text_delta") text += event.text;
      if (event.kind === "completed") {
        expect(event.inputTokens).toBe(5);
        expect(event.outputTokens).toBe(8);
      }
    }

    expect(kinds).toEqual(["text_delta", "text_delta", "completed"]);
    expect(text).toBe("Hello world!");
  });

  it("yield toolCall 事件（流式工具调用）", async () => {
    async function* mockStream(): AsyncIterable<unknown> {
      yield {
        id: "c1",
        object: "chat.completion.chunk",
        created: 100,
        model: "deepseek-chat",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "tc-1", function: { name: "calc", arguments: "" } }] },
          finish_reason: null,
        }],
      };
      yield {
        id: "c2",
        object: "chat.completion.chunk",
        created: 100,
        model: "deepseek-chat",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"expression":' } }] },
          finish_reason: null,
        }],
      };
      yield {
        id: "c3",
        object: "chat.completion.chunk",
        created: 100,
        model: "deepseek-chat",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"2+2"}' } }] },
          finish_reason: "tool_calls",
        }],
      };
    }

    const provider = new DeepSeekProvider();
    (provider as unknown as Record<string, unknown>).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream()),
        },
      },
    };

    const transcript = new Transcript();
    transcript.append(Message.userText("calc 2+2"));

    const kinds: string[] = [];
    let toolName = "";
    for await (const event of provider.astream(transcript, [])) {
      kinds.push(event.kind);
      if (event.kind === "tool_call_start") {
        toolName = event.name;
      }
    }

    expect(kinds).toContain("tool_call_start");
    expect(kinds).toContain("tool_call_delta");
    expect(kinds).toContain("completed");
    expect(toolName).toBe("calc");
  });

  it("yield reasoningDelta 事件", async () => {
    async function* mockStream(): AsyncIterable<unknown> {
      yield {
        id: "r1",
        object: "chat.completion.chunk",
        created: 100,
        model: "deepseek-chat",
        choices: [{
          index: 0,
          delta: { content: "", reasoning_content: "Let me think..." },
          finish_reason: null,
        }],
      };
      yield {
        id: "r2",
        object: "chat.completion.chunk",
        created: 100,
        model: "deepseek-chat",
        choices: [{
          index: 0,
          delta: { content: "Answer: 4" },
          finish_reason: "stop",
        }],
      };
    }

    const provider = new DeepSeekProvider();
    (provider as unknown as Record<string, unknown>).client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(mockStream()),
        },
      },
    };

    const transcript = new Transcript();
    transcript.append(Message.userText("2+2?"));

    const kinds: string[] = [];
    for await (const event of provider.astream(transcript, [])) {
      kinds.push(event.kind);
    }

    expect(kinds).toContain("reasoning_delta");
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("completed");
  });
});



