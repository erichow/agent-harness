/**
 * Agent 循环 — 第 8 章（compaction-aware async 版）
 *
 * 相比第 7 章的变化：
 *   1. + Compactor — red state 时自动压缩（mask→summarize）
 *   2. + onCompaction 回调 — 通知观察者压缩结果
 *   3. 压缩后发送二次 snapshot（决策帧 + 效果帧）
 *   4. 原有 onEvent / onToolCall / onToolResult / onSnapshot 保持不动
 */
import type { Provider } from "./providers/base.js";
import { ProviderResponse, accumulate } from "./providers/base.js";
import type { ToolRegistry } from "./tools/registry.js";
import { Message, Transcript, toolCallBlock, toolResultBlock } from "./messages.js";
import type { Block, ToolCallBlock, ToolResultBlock } from "./messages.js";
import type { StreamEvent } from "./providers/events.js";
import { isTextDelta } from "./providers/events.js";
import { ContextAccountant } from "./context/accountant.js";
import type { ContextSnapshot } from "./context/accountant.js";
import { Compactor } from "./context/compactor.js";
import type { CompactionResult } from "./context/compactor.js";

export const MAX_ITERATIONS = 20;

/* ─── 回调类型 ───────────────────────────────────────────────────── */

export type OnEvent = (event: StreamEvent) => void;
export type OnSnapshot = (snapshot: ContextSnapshot) => void;
export type OnCompaction = (result: CompactionResult) => void;

/* ─── arun — async loop ──────────────────────────────────────────── */

/**
 * 运行 agent 循环（async 版，第 8 章升级）。
 *
 * @param provider    - 模型供应方
 * @param registry    - 工具注册中心
 * @param userMessage - 用户的起始消息
 * @param transcript  - 可选的已有 transcript（用于多轮对话）
 * @param system      - 可选的系统 prompt
 * @param onEvent     - 每收到一个 StreamEvent 的回调（UI 进度条用）
 * @param onToolCall  - 工具调用前的回调
 * @param onToolResult- 工具执行完毕的回调
 * @param onSnapshot  - 每回合 snapshot 后的回调（第 7 章新增）
 * @param accountant  - 上下文记账员（第 7 章新增）
 * @param compactor   - 压缩协调者（第 8 章新增）
 * @param onCompaction- 压缩完成后的回调（第 8 章新增）
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
  onSnapshot?: OnSnapshot,
  accountant?: ContextAccountant,
  compactor?: Compactor,
  onCompaction?: OnCompaction,
): Promise<string> {
  if (!transcript) {
    transcript = new Transcript(system);
  }
  transcript.append(Message.userText(userMessage));

  const ctxAccountant = accountant ?? new ContextAccountant();
  const ctxCompactor = compactor ?? new Compactor(ctxAccountant, provider);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // 第 7 章：每 turn 前 snapshot
    const snapshot = ctxAccountant.snapshot(transcript, registry.getSchemas());
    if (onSnapshot) onSnapshot(snapshot);
    if (snapshot.state === "red") {
      // 第 8 章：压缩
      const result = await ctxCompactor.compactIfNeeded(
        transcript,
        registry.getSchemas(),
      );
      if (onCompaction) onCompaction(result);
      // 再发一次 snapshot 让观察者看到压缩后的状态（效果帧）
      if (onSnapshot) {
        onSnapshot(ctxAccountant.snapshot(transcript, registry.getSchemas()));
      }
    }

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