/**
 * BM25 文档索引（第 10 章）
 *
 * 基于 BM25 Okapi 算法的文本检索索引。
 * 5000 文档秒级索引、毫秒级搜索——无需 embedding 模型、向量库或网络调用。
 *
 * 设计决策：
 *   - 词级 chunk（~500 tokens, 50 token overlap）
 *   - BM25 经典参数：k1=1.5, b=0.75
 *   - 过滤零分结果（不返回"假相关"噪音）
 *   - Chunk 携带 doc_id + chunk_id（agent 可回引）
 */
import * as fs from "node:fs";
import * as path from "node:path";

/* ─── 分词 ───────────────────────────────────────────────────────── */

/** 将文本分词为小写单词列表 */
function _tokenize(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(/\w+/g)).map((m) => m[0]);
}

/* ─── 类型 ────────────────────────────────────────────────────────── */

export interface Chunk {
  docId: string;
  chunkId: number;
  text: string;
}

export interface SearchHit {
  chunk: Chunk;
  score: number;
}

/* ─── 常量 ───────────────────────────────────────────────────────── */

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/* ─── DocumentIndex ──────────────────────────────────────────────── */

export class DocumentIndex {
  readonly root: string;
  readonly chunks: Chunk[] = [];

  /** 每个 chunk 的分词结果（用于更新 BM25 状态） */
  private _tokenizedChunks: string[][] = [];

  /** 文档频率表：term → 包含该 term 的 chunk 数 */
  private _df: Map<string, number> = new Map();

  /** 总 chunk 数 */
  private _totalChunks = 0;

  /** 平均 chunk 长度（tokens） */
  private _avgdl = 0;

  /** BM25 参数 */
  private _k1: number;
  private _b: number;

  constructor(
    root: string,
    chunkTokens: number = 500,
    overlap: number = 50,
    k1: number = DEFAULT_K1,
    b: number = DEFAULT_B,
  ) {
    this.root = root;
    this._k1 = k1;
    this._b = b;
    this._build(chunkTokens, overlap);
    this._computeStats();
  }

  /* ─── 构建索引 ──────────────────────────────────────────────── */

  private _build(chunkTokens: number, overlap: number): void {
    if (!fs.existsSync(this.root)) {
      return; // 目录不存在，空索引
    }

    const entries = this._walkDir(this.root);

    for (const filePath of entries) {
      let text: string;
      try {
        text = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue; // 跳过不可读文件（二进制、权限等）
      }

      const words = text.split(/\s+/);
      const relPath = path.relative(this.root, filePath);
      const step = chunkTokens - overlap;

      for (let i = 0, start = 0; start < words.length; i++, start += step) {
        const chunkText = words.slice(start, start + chunkTokens).join(" ");
        if (chunkText.trim()) {
          this.chunks.push({
            docId: relPath,
            chunkId: i,
            text: chunkText,
          });
        }
      }
    }
  }

  /** 递归遍历目录，返回所有文件路径（排序后稳定） */
  private _walkDir(dir: string): string[] {
    const results: string[] = [];
    const list = fs.readdirSync(dir).sort();
    for (const entry of list) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        results.push(...this._walkDir(full));
      } else if (stat.isFile()) {
        results.push(full);
      }
    }
    return results;
  }

  /* ─── 统计 ──────────────────────────────────────────────────── */

  private _computeStats(): void {
    this._totalChunks = this.chunks.length;
    let totalTokens = 0;

    for (const chunk of this.chunks) {
      const tokens = _tokenize(chunk.text);
      this._tokenizedChunks.push(tokens);
      totalTokens += tokens.length;

      // 更新文档频率
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          this._df.set(t, (this._df.get(t) ?? 0) + 1);
        }
      }
    }

    this._avgdl = this._totalChunks > 0 ? totalTokens / this._totalChunks : 0;
  }

  /* ─── 搜索 ──────────────────────────────────────────────────── */

  /**
   * 搜索与 query 最相关的 k 个 chunk。
   *
   * @param query - 搜索查询（关键词或短句）
   * @param k     - 返回结果数上限（默认 5）
   * @returns 按 score 降序排列的 SearchHit 数组，不含零分结果
   */
  search(query: string, k: number = 5): SearchHit[] {
    if (this._totalChunks === 0) return [];

    const queryTokens = _tokenize(query).filter((t) => t.length > 0);
    if (queryTokens.length === 0) return [];

    // 计算每个 query term 的 IDF
    const idfCache = new Map<string, number>();
    for (const t of queryTokens) {
      idfCache.set(t, this._idf(t));
    }

    // 为每个 chunk 打分
    const scores: number[] = new Array(this._totalChunks).fill(0);

    for (let i = 0; i < this._totalChunks; i++) {
      const tokens = this._tokenizedChunks[i];
      const docLen = tokens.length;

      // 计算 term frequency
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }

      let score = 0;
      for (const qt of queryTokens) {
        const termFreq = tf.get(qt) ?? 0;
        if (termFreq === 0) continue;

        const idf = idfCache.get(qt) ?? 0;
        const numerator = termFreq * (this._k1 + 1);
        const denominator = termFreq + this._k1 * (1 - this._b + this._b * docLen / this._avgdl);
        score += idf * numerator / denominator;
      }

      scores[i] = score;
    }

    // 排序并取 top-K（仅正分）
    const indexed = scores
      .map((s, i) => ({ index: i, score: s }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    return indexed.map((x) => ({
      chunk: this.chunks[x.index],
      score: x.score,
    }));
  }

  /* ─── IDF ────────────────────────────────────────────────────── */

  /**
   * BM25 Okapi IDF 公式。
   *
   * idf(t) = log((N - n(t) + 0.5) / (n(t) + 0.5))
   *
   * 其中 N = 总 chunk 数，n(t) = 包含 t 的 chunk 数。
   * +0.5 防止除零——当 t 出现在所有 chunk 中时 idf 趋于 0。
   */
  private _idf(term: string): number {
    const n = this._df.get(term) ?? 0;
    return Math.log((this._totalChunks - n + 0.5) / (n + 0.5));
  }
}
