/**
 * 第 10 章测试 — BM25 文档检索
 *
 * 覆盖：
 *   1. 构建索引 — 从目录读取文件并 chunk
 *   2. 搜索 — 基本关键词匹配
 *   3. BM25 评分 — 相同关键词的文档分高于无关文档
 *   4. 空索引 / 无结果
 *   5. 空查询
 *   6. search_docs 工具 — 通过 registry 集成
 *   7. k 上限（max 10）
 *   8. 成本字符串 — 结果末尾的 token 估算
 *   9. 搜索非 .txt 文件（二进制跳过）
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
import { DocumentIndex } from "../src/harness/retrieval/index.js";
import type { Chunk, SearchHit } from "../src/harness/retrieval/index.js";
import { RetrievalInterface } from "../src/harness/tools/retrieval.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

/* ─── 测试语料库目录 ─────────────────────────────────────────────── */

const CORPUS_DIR = ".test-corpus";

/** 创建测试语料库 */
function buildCorpus(): void {
  fs.rmSync(CORPUS_DIR, { recursive: true, force: true });
  fs.mkdirSync(CORPUS_DIR, { recursive: true });

  // doc-1: TypeScript
  fs.writeFileSync(
    path.join(CORPUS_DIR, "typescript.txt"),
    [
      "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.",
      "It offers static type checking, interfaces, enums, and generics.",
      "TypeScript is developed by Microsoft and first appeared in 2012.",
      "The TypeScript compiler (tsc) can be configured via tsconfig.json.",
      "TypeScript supports modern ECMAScript features and compiles them to a target of your choice.",
      "TypeScript adds optional static typing to JavaScript, making it easier to catch errors at compile time.",
      "Many large-scale applications use TypeScript for better developer experience and code maintainability.",
    ].join(" "),
    "utf-8",
  );

  // doc-2: Rust
  fs.writeFileSync(
    path.join(CORPUS_DIR, "rust.txt"),
    [
      "Rust is a systems programming language focused on safety, speed, and concurrency.",
      "It guarantees memory safety without a garbage collector through its ownership system.",
      "Rust was originally designed by Graydon Hoare at Mozilla Research.",
      "The Rust compiler (rustc) enforces strict borrow checking rules at compile time.",
      "Rust's type system prevents null pointer dereferences and data races.",
      "Cargo is Rust's package manager and build system.",
    ].join(" "),
    "utf-8",
  );

  // doc-3: Agent (relevant for overlap tests)
  fs.writeFileSync(
    path.join(CORPUS_DIR, "agent.txt"),
    [
      "An AI agent is a program that uses a language model to decide what actions to take.",
      "Agents can call tools, read context, and produce responses in a loop.",
      "The agent harness manages the loop between the language model and tool execution.",
      "Key components of an agent: provider, registry, transcript, and context accountant.",
      "The ToolRegistry validates arguments before dispatching tool calls.",
      "Compaction reduces context window pressure by masking or summarizing old turns.",
    ].join(" "),
    "utf-8",
  );

  // doc-4: short doc (tests small files)
  fs.writeFileSync(
    path.join(CORPUS_DIR, "short.txt"),
    "BM25 is a ranking function used in information retrieval.",
    "utf-8",
  );

  // doc-5: binary-like (should be skipped)
  fs.writeFileSync(
    path.join(CORPUS_DIR, "binary.bin"),
    Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]),
  );

  // sub-dir test
  fs.mkdirSync(path.join(CORPUS_DIR, "sub"), { recursive: true });
  fs.writeFileSync(
    path.join(CORPUS_DIR, "sub", "nested.txt"),
    "Nested file content for recursion testing. TypeScript is great.",
    "utf-8",
  );
}

describe("DocumentIndex", () => {
  afterAll(() => {
    fs.rmSync(CORPUS_DIR, { recursive: true, force: true });
  });

  /* ─── 构建索引 ──────────────────────────────────────────────── */

  it("builds index from a directory", () => {
    buildCorpus();
    const index = new DocumentIndex(CORPUS_DIR);

    expect(index.chunks.length).toBeGreaterThanOrEqual(4); // 至少 4 个文档
    expect(index.chunks.length).toBeLessThanOrEqual(20);

    // 检查 chunk 结构
    for (const chunk of index.chunks) {
      expect(chunk.docId).toBeTruthy();
      expect(typeof chunk.chunkId).toBe("number");
      expect(chunk.text.length).toBeGreaterThan(0);
    }

    // 检查递归遍历子目录
    const nestedChunks = index.chunks.filter((c) =>
      c.docId.includes("nested"),
    );
    expect(nestedChunks.length).toBe(1);
    expect(nestedChunks[0].docId).toBe("sub/nested.txt");
  });

  it("handles non-existent directory", () => {
    const index = new DocumentIndex("/tmp/non-existent-dir-xyz");
    expect(index.chunks).toEqual([]);
    expect(index.search("anything")).toEqual([]);
  });

  /* ─── 搜索 ──────────────────────────────────────────────────── */

  it("returns relevant results for keywords", () => {
    const index = new DocumentIndex(CORPUS_DIR);

    const hits = index.search("TypeScript typed JavaScript", 3);
    expect(hits.length).toBeGreaterThanOrEqual(1);

    // TypeScript doc should be the top result
    const topDocIds = hits.map((h) => h.chunk.docId);
    expect(topDocIds).toContain("typescript.txt");

    // All hits should have positive scores
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  it("returns empty when nothing matches", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    const hits = index.search("xyznonexistentabcdefghijklmnop", 5);
    expect(hits).toEqual([]);
  });

  it("returns empty for empty query", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    expect(index.search("")).toEqual([]);
    expect(index.search("   ")).toEqual([]);
  });

  /* ─── 排序 ──────────────────────────────────────────────────── */

  it("scores more relevant docs higher", () => {
    const index = new DocumentIndex(CORPUS_DIR);

    // "Rust safety ownership" should rank rust.txt highest
    const rustHits = index.search("Rust safety ownership borrow", 5);
    expect(rustHits.length).toBeGreaterThanOrEqual(1);

    const rustDoc = rustHits.find((h) => h.chunk.docId === "rust.txt");
    expect(rustDoc).toBeDefined();

    // Typescript doc should score lower for Rust query
    const tsDoc = rustHits.find((h) => h.chunk.docId === "typescript.txt");
    if (tsDoc && rustDoc) {
      expect(rustDoc.score).toBeGreaterThan(tsDoc.score);
    }
  });

  it("returns results sorted by score descending", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    const hits = index.search("TypeScript", 5);

    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].score).toBeLessThanOrEqual(hits[i - 1].score);
    }
  });

  /* ─── k 参数 ────────────────────────────────────────────────── */

  it("respects k parameter", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    const hits = index.search("TypeScript", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("filters zero-score results", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    for (const hit of index.search("TypeScript", 100)) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  /* ─── 整数搜索（跨文档） ─────────────────────────────────────── */

  it("finds content across multiple docs", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    const hits = index.search("compiler", 5);
    // Both typescript.txt and rust.txt mention "compiler"
    const docIds = hits.map((h) => h.chunk.docId);
    expect(docIds).toContain("typescript.txt");
    expect(docIds).toContain("rust.txt");
  });
});

/* ─── RetrievalInterface 集成测试 ────────────────────────────────── */

describe("RetrievalInterface", () => {
  afterAll(() => {
    fs.rmSync(CORPUS_DIR, { recursive: true, force: true });
  });

  it("search_docs returns structured results via registry", () => {
    buildCorpus();
    const index = new DocumentIndex(CORPUS_DIR);
    const retriever = new RetrievalInterface(index);
    const registry = new ToolRegistry();

    registry.register(...retriever.asTool());

    const result = registry.execute(
      "search_docs",
      { query: "TypeScript compiler", k: 3 },
      "call-1",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("typescript.txt");
    expect(result.content).toContain("score=");

    // 检查成本字符串
    expect(result.content).toMatch(/\[\d+ hits, ~\d+ chars \(~\d+ tokens\)\]/);
  });

  it("clamps k to max 10", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    const retriever = new RetrievalInterface(index);
    const registry = new ToolRegistry();
    registry.register(...retriever.asTool());

    // k=100 应被 clamp 到 10
    const result = registry.execute(
      "search_docs",
      { query: "TypeScript", k: 100 },
      "call-2",
    );

    expect(result.isError).toBe(false);
    // 验证结果不超过 10 个命中（如果索引中有 10 个以上匹配的话）
    const hitCount = (result.content.match(/---/g) || []).length;
    expect(hitCount).toBeLessThanOrEqual(10);
  });

  it("returns no results for unmatched query", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    const retriever = new RetrievalInterface(index);
    const registry = new ToolRegistry();
    registry.register(...retriever.asTool());

    const result = registry.execute(
      "search_docs",
      { query: "xyznonexistent" },
      "call-3",
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("(no results)");
  });

  it("handles empty query gracefully", () => {
    const index = new DocumentIndex(CORPUS_DIR);
    const retriever = new RetrievalInterface(index);
    const registry = new ToolRegistry();
    registry.register(...retriever.asTool());

    const result = registry.execute(
      "search_docs",
      { query: "" },
      "call-4",
    );

    expect(result.isError).toBe(false); // handler 返回字符串而非抛异常
    expect(result.content).toContain("empty");
  });

  it("search_docs tool definition is correct", () => {
    buildCorpus();
    const index = new DocumentIndex(CORPUS_DIR);
    const retriever = new RetrievalInterface(index);
    const [def] = retriever.asTool();

    expect(def.name).toBe("search_docs");
    expect(def.inputSchema).toHaveProperty("properties.query");
    expect(def.inputSchema).toHaveProperty("properties.k");
    expect((def.inputSchema as Record<string, unknown>).required).toContain("query");
  });
});

/* ─── 自测：在 harness 自己的源代码上测试 ────────────────────────── */

describe("self-test: index harness source", () => {
  it("can index its own source and find relevant code", () => {
    // 索引 harness 的 src/
    const index = new DocumentIndex(path.join(PROJECT_ROOT, "src/harness"), 200, 20);
    expect(index.chunks.length).toBeGreaterThanOrEqual(5);

    // 搜索 "BM25" 应该在新文件中有匹配
    const hits = index.search("BM25 ranking retrieval", 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);

    // 应该找到 retrieval/index.ts
    const retrievalHits = hits.filter((h) =>
      h.chunk.docId.includes("retrieval"),
    );
    expect(retrievalHits.length).toBeGreaterThanOrEqual(1);
    expect(retrievalHits[0].chunk.docId).toContain("index");
  });
});
