/**
 * ToolCatalog — 动态工具选择器（第 12 章）
 *
 * 基于 BM25 的工具检索，每回合从完整 catalog 中选取 top-K 相关工具。
 * 避免"工具悬崖"——工具数 ≥ 20 时模型选择准确率的非线性塌陷。
 *
 * 设计：
 *   - BM25 索引工具名 + 描述
 *   - mustInclude 钉住核心工具（discovery、scratchpad 等）
 *   - 0 分结果过滤（宁可空不返回不相关）
 *   - queryFromTranscript 从对话历史提取检索 query
 *   - listAvailableTools discovery 工具——永远 pin，避免 agent "盲掉"
 */
import type { ToolDefinition, ToolHandler } from "./registry.js";
import { ToolRegistry } from "./registry.js";
import { Transcript } from "../messages.js";

/* ─── 分词 ───────────────────────────────────────────────────────── */

function _tokenize(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(/\w+/g)).map((m) => m[0]);
}

/* ─── CatalogEntry ───────────────────────────────────────────────── */

/**
 * 目录条目：同时保存工具定义和执行函数。
 *
 * ToolRegistry 只保存已注册的工具，而 ToolCatalog 需要有能力
 * 在每回合动态选取后创建临时 registry——因此必须持 handler。
 *
 * handler + asyncHandler：工具可以是同步或异步的。
 * MCP 工具通过 asyncHandler 路径执行（异步 IO）。
 * 纯本地工具（calc、fileViewport）使用 sync handler。
 */
export interface CatalogEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** 可选的异步 handler（MCP 工具等 async IO 场景） */
  asyncHandler?: (args: Record<string, unknown>) => Promise<string>;
}

/* ─── ToolCatalog ────────────────────────────────────────────────── */

export class ToolCatalog {
  readonly entries: CatalogEntry[];
  private _byName: Map<string, CatalogEntry>;
  private _tokenized: string[][];
  private _df: Map<string, number>;
  private _total: number;
  private _avgdl: number;

  constructor(entries: CatalogEntry[]) {
    this.entries = entries;
    this._byName = new Map(entries.map((e) => [e.definition.name, e]));
    this._tokenized = entries.map((e) =>
      _tokenize(`${e.definition.name} ${e.definition.description}`),
    );
    this._df = new Map();
    this._total = entries.length;

    let totalTokens = 0;
    for (const tokens of this._tokenized) {
      totalTokens += tokens.length;
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          this._df.set(t, (this._df.get(t) ?? 0) + 1);
        }
      }
    }
    this._avgdl = this._total > 0 ? totalTokens / this._total : 0;
  }

  /** 从 ToolRegistry 创建（迁移便利方法） */
  static fromRegistry(registry: ToolRegistry): ToolCatalog {
    const entries: CatalogEntry[] = [];
    for (const name of registry.list()) {
      const def = registry.get(name);
      if (def) {
        entries.push({
          definition: def,
          handler: (args) => {
            const result = registry.execute(def.name, args, "from_catalog");
            return result.content;
          },
        });
      }
    }
    return new ToolCatalog(entries);
  }

  /** 注册一个额外条目（用于添加 discovery 工具等） */
  add(entry: CatalogEntry): void {
    if (this._byName.has(entry.definition.name)) {
      throw new Error(`tool already in catalog: ${entry.definition.name}`);
    }
    this.entries.push(entry);
    this._byName.set(entry.definition.name, entry);
    // 重建 BM25 索引
    this._rebuildIndex();
  }

  /** 重新构建 BM25 索引（add 后或批量变更后调用） */
  private _rebuildIndex(): void {
    this._tokenized = this.entries.map((e) =>
      _tokenize(`${e.definition.name} ${e.definition.description}`),
    );
    this._df = new Map();
    this._total = this.entries.length;
    let totalTokens = 0;
    for (const tokens of this._tokenized) {
      totalTokens += tokens.length;
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          this._df.set(t, (this._df.get(t) ?? 0) + 1);
        }
      }
    }
    this._avgdl = this._total > 0 ? totalTokens / this._total : 0;
  }

  /**
   * 选取与 query 最相关的 k 个工具（含必须包含的钉子工具）。
   *
   * @param query        - 检索查询（从 transcript 提取）
   * @param k            - 返回上限（默认 7）
   * @param mustInclude  - 无论 score 都包含的工具名集合
   * @returns 选中的 CatalogEntry 列表
   */
  select(
    query: string,
    k: number = 7,
    mustInclude?: Set<string>,
  ): CatalogEntry[] {
    if (this._total === 0) return [];

    const pinned: CatalogEntry[] = [];
    if (mustInclude) {
      for (const name of mustInclude) {
        const entry = this._byName.get(name);
        if (entry) pinned.push(entry);
      }
    }

    const queryTokens = _tokenize(query).filter((t) => t.length > 0);
    if (queryTokens.length === 0) return pinned;

    // BM25 scoring (k1=1.5, b=0.75)
    const k1 = 1.5;
    const b = 0.75;

    const idfCache = new Map<string, number>();
    for (const t of queryTokens) {
      const n = this._df.get(t) ?? 0;
      idfCache.set(t, Math.log((this._total - n + 0.5) / (n + 0.5)));
    }

    const scores: number[] = new Array(this._total).fill(0);

    for (let i = 0; i < this._total; i++) {
      const tokens = this._tokenized[i];
      const docLen = tokens.length;

      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }

      let score = 0;
      for (const qt of queryTokens) {
        const termFreq = tf.get(qt) ?? 0;
        if (termFreq === 0) continue;
        const idf = idfCache.get(qt) ?? 0;
        const numerator = termFreq * (k1 + 1);
        const denominator =
          termFreq + k1 * (1 - b + b * (docLen / this._avgdl));
        score += (idf * numerator) / denominator;
      }
      scores[i] = score;
    }

    // 排序、过滤零分、跳过已钉的
    const pinnedNames = new Set(pinned.map((e) => e.definition.name));
    const ranked = scores
      .map((s, i) => ({ index: i, score: s }))
      .filter(
        (x) =>
          x.score > 0 && !pinnedNames.has(this.entries[x.index].definition.name),
      )
      .sort((a, b) => b.score - a.score);

    const picks: CatalogEntry[] = [...pinned];

    for (let i = 0; i < ranked.length && picks.length < k; i++) {
      picks.push(this.entries[ranked[i].index]);
    }

    return picks;
  }

  /** 按名称获取单个目录条目 */
  get(name: string): CatalogEntry | undefined {
    return this._byName.get(name);
  }

  /** 工具定义列表 */
  get definitions(): ToolDefinition[] {
    return this.entries.map((e) => e.definition);
  }

  /** 所有工具名列表 */
  list(): string[] {
    return this.entries.map((e) => e.definition.name);
  }

  /** 工具总数 */
  get size(): number {
    return this._total;
  }
}

/* ─── queryFromTranscript ────────────────────────────────────────── */

/**
 * 从对话历史提取 BM25 检索 query。
 *
 * 混合策略：
 *   - user 首条消息作为 anchor（任务初衷）
 *   - 最近 1-2 条 assistant 内容（当前方向）
 *   - 最近的工具调用名 + 参数名（帮助定位上下文）
 */
export function queryFromTranscript(transcript: Transcript): string {
  const parts: string[] = [];

  // 首条 user 消息
  const firstMsg = transcript.messages[0];
  if (firstMsg) {
    for (const block of firstMsg.blocks) {
      if (block.kind === "text") {
        parts.push(block.text);
      }
    }
  }

  // 最近 3 条 assistant 消息
  const recent = transcript.messages
    .filter((m) => m.role === "assistant")
    .slice(-3);

  for (const msg of recent) {
    for (const block of msg.blocks) {
      if (block.kind === "text") {
        parts.push(block.text.slice(0, 500));
      } else if (block.kind === "tool_call") {
        parts.push(`${block.name} ${Object.keys(block.args).join(" ")}`);
      }
    }
  }

  return parts.join(" ");
}

/* ─── Discovery 工具 ─────────────────────────────────────────────── */

/**
 * 创建 list_available_tools discovery 工具的 CatalogEntry。
 *
 * 此工具必须被钉在 pinnedTools 中，解决两个失败模式：
 *   1. 模糊开场（"hi"、"help"）——query 全 0 分
 *   2. 任务中途转向（被旧词汇主导的 query）
 */
export function createDiscoveryEntry(
  catalog: ToolCatalog,
): CatalogEntry {
  const definition: ToolDefinition = {
    name: "list_available_tools",
    description:
      "List tools available in this harness. " +
      'filter_term: optional — substring to match against tool names or descriptions. ' +
      'Use this when you think a capability you need exists but isn\'t in ' +
      'your current tool list. After discovering a tool name, you can call ' +
      'it directly — the tool will be loaded for your next turn.',
    inputSchema: {
      type: "object",
      properties: {
        filter_term: {
          type: "string",
          description: "Optional substring filter for tool name or description",
        },
      },
    },
  };

  const handler = (args: Record<string, unknown>): string => {
    const filterTerm = String(args.filter_term ?? "").toLowerCase();
    const results: string[] = [];

    for (const entry of catalog.entries) {
      const firstLine = entry.definition.description.split("\n", 1)[0];
      const text = `${entry.definition.name} — ${firstLine}`;
      if (filterTerm && !text.toLowerCase().includes(filterTerm)) {
        continue;
      }
      results.push(text);
    }

    return results.length > 0
      ? results.join("\n")
      : "(no matching tools)";
  };

  return { definition, handler };
}
