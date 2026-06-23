/**
 * DeepSeekProvider — 对接 DeepSeek API
 *
 * 只做一件事：把 Transcript + tools 翻译成 DeepSeek /chat/completions 请求，
 * 再把响应翻译回框架的 StreamEvent / ProviderResponse。
 *
 * 不涉及：
 *   - 流式/非流式分离（已由第五章 accumulate() + oneTurn() 处理）
 *   - provider 降级（已由 FallbackProvider 处理）
 *   - 重试（已由 withRetry 处理）
 *   - token 记账（已由 ContextAccountant 处理）
 *
 * 使用方式：
 *   const provider = new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY });
 *   const answer = await arun(provider, registry, "What is 2 + 2?");
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk,
} from "openai/resources/chat/completions.js";
import type { Provider } from "./base.js";
import { ProviderResponse, ToolCallRef } from "./base.js";
import type { Transcript } from "../messages.js";
import { Message } from "../messages.js";
import type { Block, TextBlock, ToolCallBlock, ToolResultBlock, ReasoningBlock } from "../messages.js";
import type { StreamEvent } from "./events.js";
import { textDelta, reasoningDelta, toolCallStart, toolCallDelta, completed } from "./events.js";

/* ─── 配置 ──────────────────────────────────────────────────────── */

export interface DeepSeekProviderOptions {
  /** API key（默认从 DEEPSEEK_API_KEY 环境变量读取） */
  apiKey?: string;
  /** API 基础 URL（默认 https://api.deepseek.com） */
  baseURL?: string;
  /** 模型名称（默认 deepseek-v4-flash） */
  model?: string;
}

/* ─── DeepSeekProvider ──────────────────────────────────────────── */

export class DeepSeekProvider implements Provider {
  name = "deepseek";

  private client: OpenAI;
  private model: string;

  constructor(options: DeepSeekProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DeepSeek API key required — set DEEPSEEK_API_KEY env var or pass apiKey option",
      );
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: options.baseURL ?? "https://api.deepseek.com",
    });
    this.model = options.model ?? "deepseek-v4-flash";
  }

  /* ─── complete（同步） ────────────────────────────────────────────
   *
   * 同步 complete() 是第 4 章 legacy 接口，只适用于 MockProvider 这类
   * 无 IO 的实现。DeepSeekProvider 必须发起 HTTP 请求，无法同步返回。
   *
   * 使用指引：请用 arun() 替代 run()，arun 通过 astream() 驱动。
   */
  complete(
    _transcript: Transcript,
    _tools: Record<string, unknown>[],
  ): ProviderResponse {
    throw new Error(
      "DeepSeekProvider.complete() is not available — HTTP calls cannot be synchronous. " +
      "Use `arun(provider, registry, message)` instead of `run(provider, registry, message)`.",
    );
  }

  /* ─── acomplete（async 非流式） ────────────────────────────────── */

  async acomplete(
    transcript: Transcript,
    tools: Record<string, unknown>[],
  ): Promise<ProviderResponse> {
    const messages = toOpenAIMessages(transcript);
    const openaiTools = tools.length > 0 ? toOpenAITools(tools) : undefined;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: openaiTools,
      stream: false,
    });

    return toProviderResponse(response);
  }

  /* ─── astream（流式，主路径） ────────────────────────────────── */

  async *astream(
    transcript: Transcript,
    tools: Record<string, unknown>[],
  ): AsyncGenerator<StreamEvent> {
    const messages = toOpenAIMessages(transcript);
    const openaiTools = tools.length > 0 ? toOpenAITools(tools) : undefined;

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: openaiTools,
      stream: true,
    });

    // 流式解析：每个 chunk 翻译为 StreamEvent
    // track 工具调用累积状态
    const toolAccumulators = new Map</* index */ number, { id: string; name: string; argsBuffer: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) {
        // 无 choices 的 chunk 可能携带 usage
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? 0;
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }
        // DeepSeek 有时在最后带 usage 的 chunk 没有 choices
        continue;
      }

      // 文本
      if (delta.content) {
        yield textDelta(delta.content);
      }

      // 推理痕迹（DeepSeek 在 delta 中传 reasoning_content）
      const reasoningContent = (delta as Record<string, unknown>).reasoning_content;
      if (reasoningContent && typeof reasoningContent === "string") {
        yield reasoningDelta(reasoningContent);
      }

      // 工具调用
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolAccumulators.has(idx)) {
            toolAccumulators.set(idx, {
              id: tc.id ?? `call_${idx}`,
              name: tc.function?.name ?? "",
              argsBuffer: "",
            });
            const entry = toolAccumulators.get(idx)!;
            yield toolCallStart(entry.id, entry.name);
          }

          if (tc.function?.arguments) {
            const entry = toolAccumulators.get(idx)!;
            entry.argsBuffer += tc.function.arguments;
            yield toolCallDelta(entry.id, tc.function.arguments);
          }
        }
      }
    }

    // 最终 usage（流结束时 usage 可能在最后 chunk 的 choices 外）
    // 有些 provider 在流结束时不返回 usage——从累计中取
    // 没有 usage 信息时留 0
    yield completed(inputTokens, outputTokens, reasoningTokens);
  }
}

/* ─── 翻译函数（导出供测试用） ───────────────────────────────────── */

/**
 * Transcript → OpenAI ChatCompletionMessageParam[]
 *
 * 注意：类型上 content 永远是 string，但 OpenAI API 实际也接受
 * content array（多模态），本 harness 只处理纯文本。
 */
export function toOpenAIMessages(transcript: Transcript): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  // system prompt
  if (transcript.system) {
    result.push({ role: "system", content: transcript.system });
  }

  for (const msg of transcript.messages) {
    switch (msg.role) {
      case "user": {
        const textBlock = msg.blocks.find((b): b is TextBlock => b.kind === "text");
        const toolResultBlock = msg.blocks.find((b): b is ToolResultBlock => b.kind === "tool_result");

        if (toolResultBlock) {
          // Anthropic 约定：tool result 挂在 user 角色下
          // OpenAI 需要 role: "tool"
          result.push({
            role: "tool",
            tool_call_id: toolResultBlock.callId,
            content: toolResultBlock.content,
          });
        } else if (textBlock) {
          result.push({ role: "user", content: textBlock.text });
        }
        break;
      }

      case "assistant": {
        const textBlock = msg.blocks.find((b): b is TextBlock => b.kind === "text");
        const toolCallBlock = msg.blocks.find((b): b is ToolCallBlock => b.kind === "tool_call");

        const content = textBlock?.text ?? null;

        if (toolCallBlock) {
          result.push({
            role: "assistant",
            content,
            tool_calls: [{
              id: toolCallBlock.id,
              type: "function",
              function: {
                name: toolCallBlock.name,
                arguments: JSON.stringify(toolCallBlock.args),
              },
            }],
          });
        } else {
          result.push({ role: "assistant", content });
        }
        break;
      }

      case "system":
        result.push({ role: "system", content: extractText(msg.blocks) });
        break;
    }
  }

  return result;
}

/**
 * Tool schema (Record<string, unknown>[]) → OpenAI ChatCompletionTool[]
 */
export function toOpenAITools(schemas: Record<string, unknown>[]): ChatCompletionTool[] {
  return schemas.map((schema) => ({
    type: "function" as const,
    function: {
      name: String(schema.name ?? ""),
      description: String(schema.description ?? ""),
      parameters: schema.inputSchema as Record<string, unknown>,
    },
  }));
}

/**
 * 非流式 ChatCompletion → ProviderResponse
 */
export function toProviderResponse(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): ProviderResponse {
  const choice = completion.choices?.[0];
  const message = choice?.message;

  if (!message) {
    return new ProviderResponse("", [], undefined, {}, 0, 0, 0);
  }

  const text = message.content ?? undefined;
  const reasoningContent = (message as unknown as Record<string, unknown>).reasoning_content;
  const reasoningText = reasoningContent && typeof reasoningContent === "string"
    ? reasoningContent
    : undefined;

  const toolCalls: ToolCallRef[] = [];
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = { _raw: tc.function.arguments };
      }
      toolCalls.push(new ToolCallRef(tc.id, tc.function.name, args));
    }
  }

  return new ProviderResponse(
    text,
    toolCalls,
    reasoningText,
    {},
    completion.usage?.prompt_tokens ?? 0,
    completion.usage?.completion_tokens ?? 0,
    0, // reasoning tokens — DeepSeek 返回的 usage 尚未细分
  );
}

/* ─── 工具 ──────────────────────────────────────────────────────── */

function extractText(blocks: Block[]): string {
  const textBlock = blocks.find((b): b is TextBlock => b.kind === "text");
  return textBlock?.text ?? "";
}
