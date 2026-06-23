/**
 * 第 9 章 Scratchpad 示例 — 外部持久化 KV 存储
 *
 * 对应设计文档「ch09-scratchpad — 外部状态：草稿本」
 *
 * 设计要点：
 *   1. Scratchpad 把重要数据写在磁盘上，不在对话 transcript 里
 *   2. Compactor 动不了它 — 压缩不会丢失外部状态
 *   3. 跨 session 存活 — 进程重启后数据仍在
 *   4. 省 token — 需要时才读，而不是每轮重读
 *
 * 运行方式：
 *   npx tsx examples/ch09_scratchpad.ts
 */

import { Scratchpad } from "../src/harness/tools/scratchpad.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import * as fs from "node:fs";

const SCRATCH_DIR = ".ex09-scratchpad";

/* ─── 清理 ──────────────────────────────────────────────────────── */

function cleanup(): void {
  fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

/* ─── 演示 ──────────────────────────────────────────────────────── */

async function main() {
  cleanup();
  console.log("━━━ ch09: Scratchpad 外部存储 ━━━\n");

  // 1. 基本读写
  console.log("─ 1. 基本读写 ────────────────────");
  const pad = new Scratchpad(SCRATCH_DIR);

  const r1 = pad.write("plan", "1. 分析问题\n2. 搜索文档\n3. 实现修复");
  console.log(`   write("plan", …) → ${r1}`);

  const r2 = pad.write("port-decision", "端口改为 8081（8080 被占用）");
  console.log(`   write("port-decision", …) → ${r2}`);

  const content = pad.read("plan");
  console.log(`   read("plan") → ${JSON.stringify(content)}`);

  // 2. 列出所有 key
  console.log("\n─ 2. 列出所有 key ─────────────────");
  console.log(`   list() → ${JSON.stringify(pad.list())}`);

  // 3. 覆盖已有 key
  console.log("\n─ 3. 覆盖已有 key ─────────────────");
  pad.write("plan", "1. 分析问题\n2. 搜索文档\n3. 实现修复\n4. 验证修复");
  console.log(`   覆盖后 read("plan") → ${JSON.stringify(pad.read("plan"))}`);

  // 4. key 消毒 — 拒绝非法字符
  console.log("\n─ 4. key 消毒 ─────────────────────");
  try {
    pad.write("../../etc/passwd", "evil");
  } catch (e) {
    console.log(`   write("../../etc/passwd") → 拒绝: ${(e as Error).message}`);
  }
  try {
    pad.write("config.json", "data");
  } catch (e) {
    console.log(`   write("config.json") → 拒绝: ${(e as Error).message}`);
  }

  // 5. 通过 registry 集成（asTools）
  console.log("\n─ 5. 通过 Registry 集成 ───────────");
  const registry = new ToolRegistry();
  for (const [def, handler] of pad.asTools()) {
    registry.register(def, handler);
  }

  const writeResult = registry.execute(
    "scratchpad_write",
    { key: "discovery", content: "函数 retryWithBackoff 在 src/providers/retry.ts" },
    "call-1",
  );
  console.log(`   scratchpad_write → ${writeResult.content}`);

  const readResult = registry.execute("scratchpad_read", { key: "discovery" }, "call-2");
  console.log(`   scratchpad_read  → ${readResult.content}`);

  const listResult = registry.execute("scratchpad_list", {}, "call-3");
  console.log(`   scratchpad_list  → ${listResult.content}`);

  // 6. 跨 session 持久化
  console.log("\n─ 6. 跨实例持久化 ─────────────────");
  const pad2 = new Scratchpad(SCRATCH_DIR);
  console.log(`   新实例 list() → ${JSON.stringify(pad2.list())}`);
  console.log(`   旧数据 read("discovery") → ${JSON.stringify(pad2.read("discovery"))}`);

  console.log("\n━━━ ✅ Scratchpad 示例完成 ━━━");

  cleanup();
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
