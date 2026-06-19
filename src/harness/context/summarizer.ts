/**
 * summarize_prefix — LLM 摘要（第 8 章）
 *
 * 当 masking 不足以降到 red 以下时，用 LLM 总结对话前缀。
 * 跳过第 1 条 user message（初始目标 anchor），返回摘要消息替换原内容。
 *
 * 设计选择：
 *   - Summarizer 是另一次 LLM 调用（可传更便宜的模型）
 *   - Tool calls 显式渲染到 summarizer 输入，prompt 要求逐行保留
 *   - 就地替换 transcript（第 1 条保留，摘要成第 2 条，最近 turn 保留）
 *   - 不可逆（细节永丢）——所以是 mask 之后的回退
 */
import { Message, Transcript } from "../messages.js";
import type { Block } from "../messages.js";
import type { Provider } from "../providers/base.js";

/* ─── Summarizer system prompt ──────────────────────────────────── */

const SUMMARIZER_SYSTEM = `You are a conversation summarizer for an AI agent session.

Your job is to condense the provided conversation into a brief summary that
preserves:
- Key facts discovered (files read, values computed, decisions made).
- Open questions and in-progress subtasks.
- Which tools have been called and what they returned, in sequence.
- Any user-expressed preferences or constraints.

DO NOT:
- Invent information not present in the transcript.
- Omit tool calls — list each tool call with a one-line outcome.
- Exceed 1000 words.

Return plain prose.`;

/* ─── SummarizationResult ────────────────────────────────────────── */

export interface SummarizationResult {
  summaryText: string;
  turnsReplaced: number;
  inputTokens: number;
  outputTokens: number;
}

/* ─── summarize_prefix ──────────────────────────────────────────── */

/**
 * 总结 transcript 的前缀。
 *
 * @param transcript       - 对话记录（会被修改——前缀替换为摘要消息）
 * @param provider         - LLM provider（用来做总结）
 * @param keepRecentTurns  - 保留最近多少轮不总结
 * @returns SummarizationResult | null（无可总结的内容时返回 null）
 */
export async function summarizePrefix(
  transcript: Transcript,
  provider: Provider,
  keepRecentTurns: number = 6,
): Promise<SummarizationResult | null> {
  if (transcript.messages.length <= keepRecentTurns + 1) {
    return null; // 不够需要总结
  }

  // 第 1 条 user message 保留（初始目标 anchor）
  const prefixEnd = transcript.messages.length - keepRecentTurns;
  const prefixToSummarize = transcript.messages.slice(1, prefixEnd);

  if (prefixToSummarize.length === 0) return null;

  // 将前缀渲染为 summarizer 可读的文本
  const renderedParts: string[] = [];
  for (const msg of prefixToSummarize) {
    for (const block of msg.blocks) {
      switch (block.kind) {
        case "text":
          renderedParts.push(`[${msg.role}] ${block.text}`);
          break;
        case "tool_call":
          renderedParts.push(
            `[assistant→tool] ${block.name}(${JSON.stringify(block.args)})`,
          );
          break;
        case "tool_result":
          if (block.isError) {
            renderedParts.push(`[tool→error] ${block.content}`);
          } else {
            // 对长内容摘要显示
            const preview =
              block.content.length > 200
                ? block.content.slice(0, 200) + `… (${block.content.length} chars total)`
                : block.content;
            renderedParts.push(`[tool→result] ${preview}`);
          }
          break;
        case "reasoning":
          renderedParts.push(`[assistant→reasoning] ${block.text}`);
          break;
      }
    }
  }

  const rendered = renderedParts.join("\n");

  // 调用 provider 做摘要
  const subTranscript = new Transcript(SUMMARIZER_SYSTEM);
  subTranscript.append(
    Message.userText(`Summarize this conversation.\n\n${rendered}`),
  );
  const response = provider.complete(subTranscript, []);

  // 如果没有工具调用，complete 返回的 response.text 就是摘要
  // 如果响应包含工具调用（不该），fallback
  let summaryText: string;
  if (response.text) {
    summaryText = response.text;
  } else {
    summaryText = "(empty summary)";
  }

  // 替换前缀为一条合成消息
  const summaryMessage = Message.userText(
    `[session summary — ${prefixToSummarize.length} turns replaced]\n${summaryText}`,
  );
  // 替换从 index 1 到 prefixEnd 的部分
  transcript.messages.splice(1, prefixToSummarize.length, summaryMessage);

  return {
    summaryText,
    turnsReplaced: prefixToSummarize.length,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}
