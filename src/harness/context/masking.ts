/**
 * mask_older_results — 遮蔽旧的 tool_result 内容（第 8 章）
 *
 * 把旧的 ToolResult.content 替换成占位符，保留 call_id 和原始 token 数。
 * 可逆（agent 可重跑工具）、幂等（已 mask 的不再处理）。
 *
 * 不可违反的不变量：tool_call 记录永远保留——只替换 content 不删 block。
 */
import { Message } from "../messages.js";
import type { ToolResultBlock } from "../messages.js";
import type { Transcript } from "../messages.js";

/** 遮蔽占位模板 */
const MASK_TEMPLATE =
  "[tool_result elided; call_id={callId}; original_tokens~={tokens}]";

/** 已遮蔽的 content 前缀（用于幂等判断） */
const ELIDED_PREFIX = "[tool_result elided";

/**
 * 遮蔽所有早于最近 keepRecent 条的 tool_result。
 *
 * @param transcript - 对话记录（会被修改——重建 message 以保持不可变纪律）
 * @param keepRecent - 保留最近多少条 tool_result 不遮蔽
 * @returns 释放的 token 数近似值
 */
export function maskOlderResults(
  transcript: Transcript,
  keepRecent: number = 3,
): number {
  // 收集所有 ToolResult block 的位置 (messageIndex, blockIndex)
  const results: Array<{
    msgIdx: number;
    blockIdx: number;
    block: ToolResultBlock;
  }> = [];

  for (let mi = 0; mi < transcript.messages.length; mi++) {
    const msg = transcript.messages[mi];
    for (let bi = 0; bi < msg.blocks.length; bi++) {
      const block = msg.blocks[bi];
      if (block.kind === "tool_result") {
        results.push({ msgIdx: mi, blockIdx: bi, block });
      }
    }
  }

  // 如果总数 <= keepRecent，不需要遮蔽
  if (results.length <= keepRecent) return 0;

  const toMask = results.slice(0, results.length - keepRecent);
  let freed = 0;

  for (const { msgIdx, blockIdx, block } of toMask) {
    // 幂等：已 mask 的跳过
    if (block.content.startsWith(ELIDED_PREFIX)) continue;

    const originalTokens = estimateTokens(block.content);
    const newContent = MASK_TEMPLATE.replace("{callId}", block.callId)
      .replace("{tokens}", String(originalTokens));
    const newTokens = estimateTokens(newContent);
    freed += originalTokens - newTokens;

    // 重建 block 和 message（不可变纪律）
    const newBlock: ToolResultBlock = {
      kind: "tool_result",
      callId: block.callId,
      content: newContent,
      isError: block.isError,
    };

    const oldMsg = transcript.messages[msgIdx];
    const newBlocks = [...oldMsg.blocks];
    newBlocks[blockIdx] = newBlock;
    transcript.messages[msgIdx] = new Message(
      oldMsg.role,
      newBlocks,
      oldMsg.createdAt,
      oldMsg.id,
    );
  }

  return freed;
}

/**
 * 粗略估算 token 数（与 accountant 保持一致）。
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let charCount = 0;
  for (const ch of text) {
    charCount += ch.charCodeAt(0) > 127 ? 2 : 1;
  }
  return Math.max(1, Math.ceil(charCount / 4));
}
