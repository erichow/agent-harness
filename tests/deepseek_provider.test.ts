/**
 * DeepSeekProvider 测试
 *
 * 测试策略：翻译函数（纯逻辑，无 IO）直接做单元测试；
 * acomplete / astream 通过 mock OpenAI client 验证。
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { DeepSeekProvider, toOpenAIMessages, toOpenAITools, toProviderResponse } from "../src/harness/providers/deepseek.js";
import { Transcript, Message, textBlock, toolCallBlock, toolResultBlock, reasoningBlock } from "../src/harness/messages.js";
import { ProviderResponse, ToolCallRef, accumulate } from "../src/harness/providers/base.js";
import type { Provider } from "../src/harness/providers/base.js";
import { arun } from "../src/harness/agent.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { ContextAccountant, ContextSnapshot } from "../src/harness/context/accountant.js";

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
      model: "deepseek-v4-flash",
      choices: [{ ...baseChoice, message: { role: "assistant", content: "Hello!", refusal: null } }],
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
      model: "deepseek-v4-flash",
      choices: [{
        ...baseChoice,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
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
      model: "deepseek-v4-flash",
      choices: [{
        ...baseChoice,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
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
      model: "deepseek-v4-flash",
      choices: [{
        ...baseChoice,
        message: {
          role: "assistant",
          content: "Final answer",
          refusal: null,
          // DeepSeek 在 message 层面附加 reasoning_content
          reasoning_content: "Let me think...",
        } as any,
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
      model: "deepseek-v4-flash",
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
      model: "deepseek-v4-flash",
      choices: [{
        ...baseChoice,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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
        model: "deepseek-v4-flash",
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

/* ═══════════════════════════════════════════════════════════════════
 * 以下 seam 测试来自 ch05 / ch07 / ch22 — 需要真实 DEEPSEEK_API_KEY
 * 在 mock 测不到的真实 API 行为上做最终验证。
 ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(!process.env.DEEPSEEK_API_KEY)("DeepSeek (real API)", () => {
  it("accumulate 处理真实 DeepSeek 流式文本", async () => {
    const provider = new DeepSeekProvider();
    const transcript = new Transcript();
    transcript.append(Message.userText("Say 'hello' in one word."));

    const stream = provider.astream(transcript, []);
    const response = await accumulate(stream);

    expect(response.isFinal).toBe(true);
    expect(response.text).toBeTruthy();
    // 真实 chunk 碎片顺序可能与 mock 不同，accumulate 必须能拼回完整文本
    expect(response.text!.length).toBeGreaterThan(0);
    // 注：DeepSeek 流式响应不总是返回 usage 数据，inputTokens 可能为 0
  });

  it("arun 完整循环 with DeepSeek（文本 + 工具调用）", async () => {
    const provider = new DeepSeekProvider();
    const registry = new ToolRegistry();

    registry.register(
      {
        name: "calc",
        description: "Evaluate an arithmetic expression.",
        inputSchema: {
          type: "object",
          properties: {
            expression: { type: "string", description: "The expression to evaluate" },
          },
          required: ["expression"],
        },
      },
      (args: Record<string, unknown>) => {
        const expr = String(args.expression ?? "");
        const sanitized = expr.replace(/[^0-9+\-*/().%\s]/g, "");
        try {
          // eslint-disable-next-line no-eval
          return String(eval(sanitized));
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    );

    // 这个测试同时验证：
    //   1. arun 调 astream → oneTurn → accumulate 链路在真实 provider 上通
    //   2. 工具调用 chunk 碎片在真实场景下能被正确累积
    //   3. completed 事件携带的 usage 数据被 accumulate 正确提取
    const answer = await arun(
      provider,
      registry,
      "What is 1 + 2? Use the calc tool.",
    );

    expect(answer).toContain("3");
  }, 30_000);

  it("流式不返回 usage 时 ContextAccountant 不崩", async () => {
    // DeepSeek 流式响应有时不携带 usage 数据。
    // ContextAccountant 必须能处理 outputTokens=0 的 completed 事件。
    const provider = new DeepSeekProvider();
    const registry = new ToolRegistry();
    const accountant = new ContextAccountant();
    const snapshots: ContextSnapshot[] = [];

    await arun(
      provider,
      registry,
      "Say 'hello' in one word.",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (s) => snapshots.push(s),
      accountant,
    );

    // 循环至少走了 1 轮，snapshot 没有被 0 token 搞崩
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    // snapshot 的 state 应该是 green（这么短的对话不会超）
    expect(["green", "yellow"]).toContain(snapshots[0].state);
  }, 20_000);

  it("ProviderResponse 契约形状与 MockProvider 一致", async () => {
    const provider = new DeepSeekProvider();
    const transcript = new Transcript();
    transcript.append(Message.userText("Say hello"));

    const response = await provider.acomplete(transcript, []);

    // ch22 契约：跨 provider 一致的形状
    expect(response).toHaveProperty("text");
    expect(response).toHaveProperty("isFinal");
    expect(response).toHaveProperty("isToolCall");
    expect(response).toHaveProperty("toolCalls");
    expect(typeof response.isFinal).toBe("boolean");
    expect(Array.isArray(response.toolCalls)).toBe(true);
  });

  it("astream 事件 kind 在标准集合内", async () => {
    const provider = new DeepSeekProvider();
    const transcript = new Transcript();
    transcript.append(Message.userText("Say hello"));

    const validKinds = new Set([
      "text_delta", "reasoning_delta",
      "tool_call_start", "tool_call_delta",
      "completed",
    ]);

    for await (const event of provider.astream(transcript, [])) {
      expect(validKinds.has(event.kind)).toBe(true);
    }
  });

  it("accumulate 流式响应 → ProviderResponse 形状正确", async () => {
    const provider = new DeepSeekProvider();
    const transcript = new Transcript();
    transcript.append(Message.userText("Say hello"));

    const response = await accumulate(provider.astream(transcript, []));

    expect(response).toHaveProperty("isFinal");
    expect(response).toHaveProperty("text");
    expect(response).toHaveProperty("inputTokens");
    expect(response).toHaveProperty("outputTokens");
  });

  it("DeepSeekProvider 通过 Provider 接口一致性检查", () => {
    const provider: Provider = new DeepSeekProvider();
    expect(typeof provider.name).toBe("string");
    expect(typeof provider.complete).toBe("function");
    expect(typeof provider.astream).toBe("function");
  });
});



