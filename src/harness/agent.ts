/**
 * Agent 循环 — 升级版（第 3 章）
 *
 * 相比第 2 章的变化：
 *   1. Transcript 现在有 system 字段
 *   2. Message.fromAssistantResponse 一行解决"同时持久化主输出 + ReasoningBlock"
 *   3. tool dispatch 周围的 try/catch 用最小方式解决了第 2 章的 Break 1 和 Break 3
 *      — loop 不再因为"未知工具"或异常崩溃，而是把结构化错误返回给模型让它恢复
 */
import type { Provider } from "./providers/base.js";
import { Message, toolResultBlock, Transcript } from "./messages.js";

export const MAX_ITERATIONS = 20;

/** 工具函数签名：接收一个参数对象，返回字符串结果 */
export type ToolFunction = (args: Record<string, unknown>) => string;

/**
 * 运行 agent 循环。
 *
 * @param provider    - 模型供应方（mock 或真实的 provider）
 * @param tools       - 工具名 → 工具函数的映射
 * @param toolSchemas - 工具 schema 列表（传给模型描述可用工具）
 * @param userMessage - 用户的起始消息
 * @param system      - 可选的系统 prompt
 * @returns 模型的最终回答
 */
export function run(
  provider: Provider,
  tools: Record<string, ToolFunction>,
  toolSchemas: Record<string, unknown>[],
  userMessage: string,
  system?: string,
): string {
  const transcript = new Transcript(system);
  transcript.append(Message.userText(userMessage));

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = provider.complete(transcript, toolSchemas);

    if (response.isFinal) {
      // 同时保留 reasoning（如果有）和 final text
      transcript.append(Message.fromAssistantResponse(response));
      return response.text ?? "";
    }

    // 工具调用分支
    if (response.isToolCall) {
      transcript.append(Message.fromAssistantResponse(response));

      const toolName = response.toolName!;
      const toolCallId = response.toolCallId ?? `call-${i}`;

      let result: string;
      let isError = false;

      try {
        if (!(toolName in tools)) {
          throw new Error(`unknown tool: ${toolName}`);
        }
        result = String(tools[toolName](response.toolArgs ?? {}));
      } catch (e) {
        result = (e as Error).message;
        isError = true;
      }

      transcript.append(
        Message.toolResult(toolResultBlock(toolCallId, result, isError)),
      );
      continue;
    }

    throw new Error(`unexpected response: no text and no tool_name`);
  }

  throw new Error(
    `agent did not finish in ${MAX_ITERATIONS} iterations`,
  );
}
