/**
 * tests/ch21_checkpoint.test.ts — 第 21 章：可恢复与持久化
 *
 * 覆盖：
 *   1. Checkpointer — 创建 session / save / load checkpoint
 *   2. Checkpointer — 版本化（多次 save 递增版本号）
 *   3. Checkpointer — tool-call log（issued → completed）
 *   4. Checkpointer — 幂等 key dedup
 *   5. Checkpointer — pending tool calls
 *   6. Serde — deserializeBlock by kind
 *   7. Serde — round-trip serialize/deserialize
 *   8. Resume — getPendingToolCalls
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Checkpointer } from "../src/harness/checkpoint/store.js";
import type {
  CheckpointRecord,
  ToolCallRecord,
} from "../src/harness/checkpoint/store.js";
import { deserializeBlock, serializeMessages } from "../src/harness/checkpoint/serde.js";
import { getPendingToolCalls } from "../src/harness/checkpoint/resume.js";

const TEST_DIR = path.join(".harness", "test-sessions");

describe("Checkpointer", () => {
  let cp: Checkpointer;

  beforeEach(() => {
    // 清除测试目录
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
    cp = new Checkpointer(TEST_DIR);
  });

  it("creates a new session", () => {
    const session = cp.createSession("s-test-1");
    expect(session.sessionId).toBe("s-test-1");
    expect(session.status).toBe("active");
    expect(session.createdAt).toBeTruthy();
  });

  it("saves and loads checkpoints with versioning", () => {
    cp.createSession("s-test-2");
    cp.saveCheckpoint("s-test-2", JSON.stringify([{ role: "user", text: "hi" }]));

    const latest = cp.loadLatestCheckpoint("s-test-2");
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe(1);

    // 第二次 save → version 2
    cp.saveCheckpoint("s-test-2", JSON.stringify([{ role: "user", text: "hi" }, { role: "assistant", text: "hello" }]));
    const latest2 = cp.loadLatestCheckpoint("s-test-2");
    expect(latest2!.version).toBe(2);

    // 还可访问 v1
    const v1 = cp.loadCheckpoint("s-test-2", 1);
    expect(v1).not.toBeNull();
    expect(v1!.version).toBe(1);
  });

  it("tracks tool call lifecycle", () => {
    cp.createSession("s-test-3");

    cp.recordToolCallIssued("s-test-3", "call-1", "read_file", { path: "/tmp/x" });

    let calls = cp.getToolCallsByStatus("s-test-3", "issued");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("read_file");
    expect(calls[0].status).toBe("issued");

    cp.recordToolCallResult("s-test-3", "call-1", "file content", true);

    calls = cp.getToolCallsByStatus("s-test-3", "completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].resultText).toBe("file content");
  });

  it("deduplicates by idempotency key", () => {
    cp.createSession("s-test-4");

    const key = cp.computeIdempotencyKey("s-test-4", "write_file", { path: "/tmp/x", content: "v1" });

    // 第一次：issued → completed
    cp.recordToolCallIssued("s-test-4", "call-1", "write_file", { path: "/tmp/x", content: "v1" });
    cp.recordToolCallResult("s-test-4", "call-1", "ok", true);

    // 第二次：同 key → 找到 completed
    const prior = cp.findCompletedCall(key);
    expect(prior).not.toBeNull();
    expect(prior!.resultText).toBe("ok");
  });

  it("returns null for non-existent checkpoint", () => {
    cp.createSession("s-test-empty");
    const latest = cp.loadLatestCheckpoint("s-test-empty");
    expect(latest).toBeNull();
  });

  it("updates session status", () => {
    cp.createSession("s-test-5");
    cp.updateSessionStatus("s-test-5", "completed");

    const session = cp.getSession("s-test-5");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("completed");
  });

  it("persists to disk between new instances", () => {
    cp.createSession("s-test-6");
    cp.saveCheckpoint("s-test-6", JSON.stringify([{ role: "user", text: "persist me" }]));

    // 新实例读取同一目录
    const cp2 = new Checkpointer(TEST_DIR);
    const latest = cp2.loadLatestCheckpoint("s-test-6");
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe(1);
  });
});

describe("serde", () => {
  it("deserializes text block by kind", () => {
    const block = deserializeBlock({ kind: "text", text: "hello" });
    expect(block.kind).toBe("text");
    expect(block.text).toBe("hello");
  });

  it("deserializes tool_call block by kind", () => {
    const block = deserializeBlock({
      kind: "tool_call",
      id: "tc-1",
      name: "calc",
      args: { a: 1, b: 2 },
    });
    expect(block.kind).toBe("tool_call");
    expect(block.name).toBe("calc");
  });

  it("deserializes tool_result block with snake_case fallback", () => {
    const block = deserializeBlock({
      kind: "tool_result",
      call_id: "tc-1",
      content: "3",
      is_error: false,
    });
    expect(block.kind).toBe("tool_result");
    expect(block.callId).toBe("tc-1");
    expect(block.isError).toBe(false);
  });

  it("throws on unknown kind", () => {
    expect(() => deserializeBlock({ kind: "unknown" })).toThrow("unknown block kind");
  });
});

describe("serializeMessages", () => {
  it("adds createdAt if missing", () => {
    const msgs = [{ id: "m1", role: "user", blocks: [] }];
    const serialized = serializeMessages(msgs);
    expect(serialized[0].createdAt).toBeTruthy();
  });
});

describe("resume", () => {
  it("getPendingToolCalls returns issued calls", () => {
    const cp = new Checkpointer(TEST_DIR);
    cp.createSession("s-resume");
    cp.recordToolCallIssued("s-resume", "call-1", "read_file", { path: "/tmp/x" });

    const pending = getPendingToolCalls(cp, "s-resume");
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("read_file");
  });

  it("does not return completed calls as pending", () => {
    const cp = new Checkpointer(TEST_DIR);
    cp.createSession("s-resume-2");
    cp.recordToolCallIssued("s-resume-2", "call-1", "write_file", { path: "/tmp/y" });
    cp.recordToolCallResult("s-resume-2", "call-1", "done", true);

    const pending = getPendingToolCalls(cp, "s-resume-2");
    expect(pending).toHaveLength(0);
  });
});
