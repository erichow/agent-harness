/**
 * Agent 循环 — 最小可用版
 *
 * 第 2 章 §2.3：40 行 loop（朴素版）
 *
 * 注意：这是"朴素版"—它马上就要以 5 种方式破。
 * 但它仍是有用的起点，因为接下来缺的每一样东西都有具体的失败动机。
 */
import type { Provider } from "./providers/base.js";

export const MAX_ITERATIONS = 20;

/** 工具函数签名：接收一个参数对象，返回字符串结果 */
export type ToolFunction = (args: Record<string, unknown>) => string;

/**
 * 运行 agent 循环。
 *
 * @param provider   - 模型供应方（mock 或真实的 provider）
 * @param tools      - 工具名 → 工具函数的映射
 * @param toolSchemas - 工具 schema 列表（传给模型描述可用工具）
 * @param userMessage - 用户的起始消息
 * @returns 模型的最终回答
 */
export function run(
  provider: Provider,
  tools: Record<string, ToolFunction>,
  toolSchemas: Record<string, unknown>[],
  userMessage: string,
): string {
  const transcript: Record<string, unknown>[] = [
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = provider.complete(transcript, toolSchemas);

    // ① 最终答案 → 返回
    if (response.kind === "text") {
      transcript.push({ role: "assistant", content: response.text });
      return response.text ?? "";
    }

    // ② 工具调用 → 分发
    if (response.kind === "tool_call") {
      if (!response.tool_name) {
        throw new Error("tool_call response is missing tool_name");
      }
      if (!(response.tool_name in tools)) {
        throw new Error(`unknown tool: ${response.tool_name}`);
      }

      const toolFn = tools[response.tool_name];
      const result = String(toolFn(response.tool_args ?? {}));

      transcript.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: response.tool_name,
            id: response.tool_call_id,
            input: response.tool_args,
          },
        ],
      });
      transcript.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: response.tool_call_id,
            content: result,
          },
        ],
      });
      continue;
    }

    throw new Error(`unexpected response kind: ${(response as any).kind}`);
  }

  throw new Error(
    `agent did not finish in ${MAX_ITERATIONS} iterations`,
  );
}
