/**
 * Agent 循环 — 第 5 章（async 版）
 *
 * 相比第 4 章的变化：
 *   1. arun() async — 流式输出 token，provider.astream() + accumulate()
 *   2. 中断处理 — CancelledError 捕获后 partial text checkpoint 到 transcript
 *   3. 批量工具调用 — 迭代 response.toolCalls 数组
 *   4. onEvent / onToolCall / onToolResult 回调 — 让 UI 层可以挂进度条
 *   5. run() 保留为同步 wrapper，使用 toolCalls 数组访问
 */
import type { Provider } from "./providers/base.js";
import { ProviderResponse, accumulate } from "./providers/base.js";
import type { ToolRegistry } from "./tools/registry.js";
import { Message, Transcript, toolCallBlock, toolResultBlock } from "./messages.js";
import type { Block, ToolCallBlock, ToolResultBlock } from "./messages.js";
import type { StreamEvent } from "./providers/events.js";
import { isTextDelta } from "./providers/events.js";

export const MAX_ITERATIONS = 20;

/* ─── 回调类型 ───────────────────────────────────────────────────── */

export type OnEvent = (event: StreamEvent) => void;

/* ─── arun — async loop ──────────────────────────────────────────── */

/**
 * 运行 agent 循环（async 版）。
 *
 * @param provider    - 模型供应方
 * @param registry    - 工具注册中心
 * @param userMessage - 用户的起始消息
 * @param transcript  - 可选的已有 transcript（用于多轮对话）
 * @param system      - 可选的系统 prompt
 * @param onEvent     - 每收到一个 StreamEvent 的回调（UI 进度条用）
 * @param onToolCall  - 工具调用前的回调
 * @param onToolResult- 工具执行完毕的回调
 * @returns 模型的最终回答
 */
export async function arun(
  provider: Provider,
  registry: ToolRegistry,
  userMessage: string,
  transcript?: Transcript,
  system?: string,
  onEvent?: OnEvent,
  onToolCall?: (call: ToolCallBlock) => void,
  onToolResult?: (result: ToolResultBlock) => void,
): Promise<string> {
  if (!transcript) {
    transcript = new Transcript(system);
  }
  transcript.append(Message.userText(userMessage));

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const partialText: string[] = [];
    let response: ProviderResponse;

    try {
      response = await oneTurn(provider, registry, transcript, partialText, onEvent);
    } catch (err) {
      // Ctrl-C 或中断：partial text 已经积累，checkpoint 到 transcript
      if (isCancelledError(err)) {
        if (partialText.length > 0) {
          transcript.append(Message.assistantText(
            partialText.join("") + " [interrupted]",
          ));
        }
        throw err; // 重新抛出，让上层知道被中断了
      }
      throw err;
    }

    if (response.isFinal) {
      // 提交 assistant 消息
      transcript.append(Message.fromAssistantResponse(response));
      return response.text ?? "";
    }

    // 提交 assistant 消息（携带所有 ToolCall blocks）
    transcript.append(Message.fromAssistantResponse(response));

    // 逐个派发工具调用（arrival 顺序）
    for (const ref of response.toolCalls) {
      const call = toolCallBlock(ref.id, ref.name, ref.args);
      if (onToolCall) onToolCall(call);
      const result = registry.execute(ref.name, ref.args, ref.id);
      const resultBlock = toolResultBlock(ref.id, result.content, result.isError);
      transcript.append(Message.toolResult(resultBlock));
      if (onToolResult) onToolResult(resultBlock);
    }
  }

  throw new Error(
    `agent did not finish in ${MAX_ITERATIONS} iterations`,
  );
}

/* ─── oneTurn — 一次 provider 交互 ────────────────────────────────── */

async function oneTurn(
  provider: Provider,
  registry: ToolRegistry,
  transcript: Transcript,
  partialText: string[],
  onEvent?: OnEvent,
): Promise<ProviderResponse> {
  const toolSchemas = registry.getSchemas();
  const stream = provider.astream(transcript, toolSchemas);

  // 包装 stream：转发 onEvent + 收集 TextDelta
  async function* forward(): AsyncGenerator<StreamEvent> {
    for await (const event of stream) {
      if (onEvent) onEvent(event);
      if (isTextDelta(event)) {
        partialText.push(event.text);
      }
      yield event;
    }
  }

  return accumulate(forward());
}

/* ─── 中断判断 ────────────────────────────────────────────────────── */

function isCancelledError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
     err.name === "CancelledError" ||
     (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError"))
  );
}

/* ─── run — 同步入口 ─────────────────────────────────────────────── */

/**
 * 同步 run() — 第 4 章及之前的脚本和测试仍然使用此方法。
 *
 * 使用同步 Provider.complete() 路径，不涉及流式事件。
 * 第 5 章新增的 onEvent 等回调仅在 arun() 中可用。
 */
export function run(
  provider: Provider,
  registry: ToolRegistry,
  userMessage: string,
  system?: string,
): string {
  const transcript = new Transcript(system);
  transcript.append(Message.userText(userMessage));

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const toolSchemas = registry.getSchemas();
    const response = provider.complete(transcript, toolSchemas);

    if (response.isFinal) {
      transcript.append(Message.fromAssistantResponse(response));
      return response.text ?? "";
    }

    if (response.isToolCall) {
      transcript.append(Message.fromAssistantResponse(response));

      // 逐个派发工具调用（使用 toolCalls 数组）
      for (const ref of response.toolCalls) {
        const block = registry.execute(ref.name, ref.args, ref.id);
        transcript.append(Message.toolResult(block));
      }
      continue;
    }

    throw new Error(`unexpected response: no text and no tool calls`);
  }

  throw new Error(
    `agent did not finish in ${MAX_ITERATIONS} iterations`,
  );
}