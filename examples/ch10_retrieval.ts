/**
 * 第 10 章 Retrieval 示例 — BM25 文档检索
 *
 * 对应设计文档「ch10-retrieval — 检索：Agent 驱动的、放在窗口末端的、
 *   显式成本的 RAG」
 *
 * 设计要点：
 *   1. Agent 驱动检索 — 模型自己决定何时搜、搜什么
 *   2. Edge-placed — 检索结果作为 ToolResult 放在 transcript 末端
 *   3. 显式成本 — 返回结果末尾标注 token 估算
 *
 * 运行方式：
 *   npx tsx examples/ch10_retrieval.ts
 */

import { DocumentIndex } from "../src/harness/retrieval/index.js";
import { RetrievalInterface } from "../src/harness/tools/retrieval.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import * as fs from "node:fs";
import * as path from "node:path";

const CORPUS_DIR = ".ex10-corpus";

/* ─── 构建测试语料库 ─────────────────────────────────────────────── */

function buildCorpus(): void {
  fs.rmSync(CORPUS_DIR, { recursive: true, force: true });
  fs.mkdirSync(CORPUS_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(CORPUS_DIR, "typescript.txt"),
    [
      "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.",
      "It offers static type checking, interfaces, enums, and generics.",
      "TypeScript is developed by Microsoft and first appeared in 2012.",
      "The TypeScript compiler (tsc) can be configured via tsconfig.json.",
      "TypeScript adds optional static typing to JavaScript, making it easier to catch errors at compile time.",
    ].join(" "),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(CORPUS_DIR, "rust.txt"),
    [
      "Rust is a systems programming language focused on safety, speed, and concurrency.",
      "It guarantees memory safety without a garbage collector through its ownership system.",
      "Rust was originally designed by Graydon Hoare at Mozilla Research.",
      "The Rust compiler (rustc) enforces strict borrow checking rules at compile time.",
      "Cargo is Rust's package manager and build system.",
    ].join(" "),
    "utf-8",
  );

  fs.writeFileSync(
    path.join(CORPUS_DIR, "agent.txt"),
    [
      "An AI agent is a system that uses a language model to reason and take actions.",
      "The agent loop alternates between calling the LLM and executing tool calls.",
      "Tool use allows the agent to interact with external systems and data sources.",
      "Context management is critical for long-running agent sessions.",
      "The harness provides the runtime for agent execution including tool dispatch.",
    ].join(" "),
    "utf-8",
  );
}

function cleanup(): void {
  fs.rmSync(CORPUS_DIR, { recursive: true, force: true });
}

/* ─── 演示 ──────────────────────────────────────────────────────── */

async function main() {
  buildCorpus();
  console.log("━━━ ch10: BM25 文档检索 ━━━\n");

  // 1. 从目录构建索引
  console.log("─ 1. 从目录构建索引 ───────────────");
  const index = new DocumentIndex(CORPUS_DIR);
  console.log(`   索引了 ${index.chunks.length} 个 chunk\n`);

  // 2. 基本搜索
  console.log("─ 2. 搜索 'type checking' ─────────");
  const hits1 = index.search("type checking", 3);
  if (hits1.length === 0) console.log("   (无匹配结果)");
  for (const hit of hits1) {
    console.log(`   [${hit.score.toFixed(2)}] ${hit.chunk.docId} → ${hit.chunk.text.slice(0, 60)}...`);
  }
  console.log();

  // 3. 搜索 agent 相关
  console.log("─ 3. 搜索 'agent loop tool' ────────");
  const hits2 = index.search("agent agent loop", 3);
  if (hits2.length === 0) console.log("   (无匹配结果)");
  for (const hit of hits2) {
    console.log(`   [${hit.score.toFixed(2)}] ${hit.chunk.docId} → ${hit.chunk.text.slice(0, 60)}...`);
  }
  console.log();

  // 4. 搜索不存在的词 — 空结果
  console.log("─ 4. 搜索 'python'（不存在） ────────");
  const hits3 = index.search("python", 3);
  console.log(`   结果数: ${hits3.length}`);
  console.log();

  // 5. 通过 registry 集成（search_docs 工具）
  console.log("─ 5. search_docs 工具集成 ─────────");
  const registry = new ToolRegistry();
  const retrievalTool = new RetrievalInterface(index);
  const [def, handler] = retrievalTool.asTool();
  registry.register(def, handler);

  const result1 = registry.execute(
    "search_docs",
    { query: "memory safety ownership", k: 2 },
    "call-1",
  );
  console.log(`   搜索 "memory safety ownership":`);
  console.log(`   ${result1.content.slice(0, 200)}...`);
  console.log();

  // 6. 成本字符串
  console.log("─ 6. 结果末尾的 token 估算 ━━━━━━━━━");
  const result2 = registry.execute(
    "search_docs",
    { query: "TypeScript compiler", k: 1 },
    "call-2",
  );
  const lines = result2.content.split("\n");
  console.log(`   ${lines.slice(-3).join("\n   ")}`);

  cleanup();
  console.log("\n━━━ ✅ Retrieval 示例完成 ━━━");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
