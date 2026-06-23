/**
 * checkpoint/serde.ts — 第 21 章：序列化 / 反序列化
 *
 * 第 3.2 章的 block `kind` 判别字段让反序列化变成 dispatch 表，不是猜测。
 */

/**
 * 反序列化一个 block 对象。
 * `kind` 判别字段是 dispatch 表。
 */
export function deserializeBlock(d: any): any {
  switch (d.kind) {
    case "text":
      return { kind: "text", text: d.text };
    case "reasoning":
      return { kind: "reasoning", text: d.text, metadata: d.metadata ?? {} };
    case "tool_call":
      return { kind: "tool_call", id: d.id, name: d.name, args: d.args };
    case "tool_result":
      return {
        kind: "tool_result",
        callId: d.callId ?? d.call_id,
        content: d.content,
        isError: d.isError ?? d.is_error ?? false,
      };
    default:
      throw new Error(`unknown block kind: ${d.kind}`);
  }
}

/**
 * 反序列化整个 transcript 的 messages。
 */
export function deserializeTranscript(data: any[]): any {
  return data.map((msg: any) => ({
    id: msg.id,
    role: msg.role,
    createdAt: msg.createdAt ?? msg.created_at,
    blocks: (msg.blocks ?? []).map(deserializeBlock),
  }));
}

/**
 * 序列化 messages 为 JSON（调用 JSON.stringify 前）。
 */
export function serializeMessages(messages: any[]): any[] {
  return messages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    createdAt: typeof msg.createdAt === "string"
      ? msg.createdAt
      : msg.createdAt?.toISOString?.() ?? new Date().toISOString(),
    blocks: (msg.blocks ?? []).map((b: any) => ({ ...b })),
  }));
}
