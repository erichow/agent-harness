/**
 * 第 21 章 Checkpoint 示例 — 可恢复与持久化
 *
 * 对应设计文档「ch21-resumability — 可恢复与持久化」
 *
 * 设计要点：
 *   1. Transcript、Plan、Budget、Tool-call log 必须持久化
 *   2. 版本化 checkpoint（每次 insert 新版本号）
 *   3. Idempotency key 防止 side effect 重复执行
 *   4. 跨进程 restart 后能完整恢复
 *
 * 运行方式：
 *   npx tsx examples/ch21_checkpoint.ts
 */

import { Checkpointer } from "../src/harness/checkpoint/store.js";
import type { SessionRecord, CheckpointRecord, ToolCallRecord } from "../src/harness/checkpoint/store.js";
import * as fs from "node:fs";
import * as path from "node:path";

const SESSIONS_DIR = ".ex21-sessions";

/* ─── 清理 ──────────────────────────────────────────────────────── */

function cleanup(): void {
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
}

/* ─── 演示 ──────────────────────────────────────────────────────── */

async function main() {
  cleanup();
  console.log("━━━ ch21: Checkpoint 可恢复与持久化 ━━━\n");

  const checkpointer = new Checkpointer(SESSIONS_DIR);

  // 1. 创建 session
  console.log("─ 1. 创建 Session ────────────────────");
  const session = checkpointer.createSession("demo-session-001");
  console.log(`   sessionId: ${session.sessionId}`);
  console.log(`   status: ${session.status}`);
  console.log();

  // 2. 创建 checkpoint
  console.log("─ 2. 创建 Checkpoint ─────────────────");
  checkpointer.saveCheckpoint(
    session.sessionId,
    JSON.stringify([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "Let me calculate that." },
    ]),
    undefined,
    0.0015,
  );
  console.log(`   已保存第 1 版 checkpoint`);
  console.log();

  // 3. 记录工具调用
  console.log("─ 3. 记录工具调用 ────────────────────");
  checkpointer.recordToolCallIssued(
    session.sessionId,
    "call-1",
    "calc",
    { expression: "2+2" },
  );
  checkpointer.recordToolCallResult(
    session.sessionId,
    "call-1",
    "4",
    true,
  );
  console.log(`   已记录并完成 calc 工具调用 (id: call-1)`);
  console.log();

  // 4. 保存更多 checkpoint
  console.log("─ 4. 多个版本 Checkpoint ──────────────");
  checkpointer.saveCheckpoint(
    session.sessionId,
    JSON.stringify([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "Let me calculate that." },
      { role: "user", content: "And what is 5*3?" },
    ]),
    undefined,
    0.0030,
  );
  checkpointer.saveCheckpoint(
    session.sessionId,
    JSON.stringify([
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "The answer is 4." },
    ]),
    undefined,
    0.0045,
  );
  console.log(`   共保存 3 个 checkpoint 版本`);
  console.log();

  // 5. 列出所有 session
  console.log("─ 5. 列出所有 Session ────────────────");
  const sessions = checkpointer.listSessions();
  console.log(`   活跃 sessions: ${sessions.length}`);
  for (const s of sessions) {
    console.log(`     ${s.sessionId} — ${s.status}`);
  }
  console.log();

  // 6. 读取最新 checkpoint
  console.log("─ 6. 读取最新 Checkpoint ─────────────");
  const latestCp = checkpointer.loadLatestCheckpoint(session.sessionId);
  if (latestCp) {
    console.log(`   version: ${latestCp.version}`);
    console.log(`   budgetSpentUsd: $${latestCp.budgetSpentUsd}`);
    const transcript = JSON.parse(latestCp.transcriptJson);
    console.log(`   transcript messages: ${transcript.length}`);
  }
  console.log();

  // 7. 查看 checkpoint 历史
  console.log("─ 7. Checkpoint 历史 ──────────────────");
  const cpList = checkpointer.listCheckpoints(session.sessionId);
  console.log(`   checkpoint 版本数: ${cpList.length}`);
  for (const cp of cpList) {
    console.log(`   v${cp.version}: $${cp.budgetSpentUsd.toFixed(4)} (${cp.createdAt.slice(0, 19)})`);
  }
  console.log();

  // 8. 更新 session 状态
  console.log("─ 8. 标记 Session 完成 ───────────────");
  checkpointer.updateSessionStatus(session.sessionId, "completed");
  const updated = checkpointer.getSession(session.sessionId);
  if (updated) {
    console.log(`   session ${updated.sessionId} → status: ${updated.status}`);
  }
  console.log();

  // 9. 跨实例恢复演示
  console.log("─ 9. 跨实例恢复 ──────────────────────");
  const checkpointer2 = new Checkpointer(SESSIONS_DIR);
  const restoredSessions = checkpointer2.listSessions();
  console.log(`   新实例读取到的 sessions: ${restoredSessions.length}`);
  const restoredCp = checkpointer2.loadLatestCheckpoint(session.sessionId);
  if (restoredCp) {
    console.log(`   恢复 checkpoint v${restoredCp.version}: 已花 $${restoredCp.budgetSpentUsd}`);
  }

  cleanup();
  console.log("\n━━━ ✅ Checkpoint 示例完成 ━━━");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
