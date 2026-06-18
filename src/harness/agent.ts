/**
 * Agent 循环 — 第 4 章（ToolRegistry 版）
 *
 * 相比第 3 章的变化：
 *   1. run() 不再接收 tools + toolSchemas 两个参数
 *      改为一个 ToolRegistry，schema 和 handler 配对注册
 *   2. 工具校验和错误处理交给 registry.execute()，agent 层不再写 try/catch
 */
import type { Provider } from "./providers/base.js";
import { Message, Transcript } from "./messages.js";
import type { ToolRegistry } from "./tools/registry.js";

export const MAX_ITERATIONS = 20;

/**
 * 运行 agent 循环。
 *
 * @param provider    - 模型供应方
 * @param registry    - 工具注册中心（同时负责 schema 暴露 + 执行 + 校验）
 * @param userMessage - 用户的起始消息
 * @param system      - 可选的系统 prompt
 * @returns 模型的最终回答
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

      const toolName = response.toolName!;
      const toolCallId = response.toolCallId ?? `call-${i}`;

      // 校验 + 执行一步到位，结果自带 isError 标记
      const block = registry.execute(toolName, response.toolArgs ?? {}, toolCallId);
      transcript.append(Message.toolResult(block));
      continue;
    }

    throw new Error(`unexpected response: no text and no tool_name`);
  }

  throw new Error(
    `agent did not finish in ${MAX_ITERATIONS} iterations`,
  );
}
