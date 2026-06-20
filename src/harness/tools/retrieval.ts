/**
 * RetrievalInterface — 检索工具（第 10 章）
 *
 * 将 DocumentIndex 以 search_docs 工具的形式暴露给 agent。
 *
 * 设计原则（见 ch10 文档）：
 *   1. Agent 驱动——由模型决定何时检索，而非每回合自动注入
 *   2. Edge-placed——检索结果作为 ToolResult 回到 transcript，
 *      落在窗口末端（注意力最高处）
 *   3. 显式成本——结果末尾带 token 估算，让模型"感觉到"检索的代价
 */
import type { ToolDefinition, ToolHandler } from "./registry.js";
import { DocumentIndex } from "../retrieval/index.js";

export class RetrievalInterface {
  private index: DocumentIndex;

  constructor(index: DocumentIndex) {
    this.index = index;
  }

  /**
   * 将检索功能暴露为一个可注册的工具。
   *
   * @returns [ToolDefinition, ToolHandler] 元组
   */
  asTool(): [ToolDefinition, ToolHandler] {
    const idx = this.index;

    const definition: ToolDefinition = {
      name: "search_docs",
      description:
        "Search the document corpus for chunks matching a query. " +
        "query: keywords or a short sentence describing what you're " +
        "looking for. " +
        "k: number of hits to return (default 5, max 10). " +
        "Returns up to k hits, each with: doc_id, chunk_id, score, and " +
        "the chunk text. Chunks are ~500 tokens each; plan your context " +
        "budget before calling with k > 3. " +
        "After getting results, quote the relevant passages in your " +
        "reasoning — do not rely on memory of them across many turns. " +
        "If the first query is not useful, refine the query.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords or a short sentence describing what you're looking for",
          },
          k: {
            type: "number",
            description: "Number of hits to return (default 5, max 10)",
            default: 5,
          },
        },
        required: ["query"],
      },
    };

    const handler: ToolHandler = (args) => {
      const query = String(args.query ?? "");
      const kRaw = Number(args.k ?? 5);
      const k = Math.max(1, Math.min(10, Number.isFinite(kRaw) ? Math.round(kRaw) : 5));

      if (!query.trim()) {
        return "search_docs: query cannot be empty";
      }

      const hits = idx.search(query, k);

      if (hits.length === 0) {
        return "(no results)";
      }

      const lines: string[] = [];
      let totalChars = 0;

      for (const hit of hits) {
        const c = hit.chunk;
        lines.push(
          `\n--- ${c.docId}#${c.chunkId} (score=${hit.score.toFixed(2)}) ---`,
        );
        lines.push(c.text);
        totalChars += c.text.length;
      }

      const estimatedTokens = Math.round(totalChars / 4);
      lines.push(
        `\n[${hits.length} hits, ~${totalChars} chars (~${estimatedTokens} tokens)]`,
      );

      return lines.join("\n");
    };

    return [definition, handler];
  }
}
