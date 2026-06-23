/**
 * checkpoint/store.ts — 第 21 章：Checkpointer
 *
 * JSON-file 实现，每个 session 一个文件。
 * 默认路径：.harness/sessions/<sessionId>.json
 *
 * 设计：
 *   - 版本化 checkpoint（每次 insert 新版本号）
 *   - Tool-call log 独立于 checkpoint（更新频率不同）
 *   - sessions 是身份，checkpoints 是内容
 *
 * 当需要跨机器/高写入率时，把 Checkpointer 换成 Postgres 后端实现。
 * 接口不变。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/* ─── 数据类型 ──────────────────────────────────────────────────── */

export type SessionStatus = "active" | "completed" | "failed" | "cancelled";
export type ToolCallStatus = "issued" | "completed" | "failed";

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
}

export interface CheckpointRecord {
  sessionId: string;
  version: number;
  createdAt: string;
  transcriptJson: string;
  planJson?: string;
  budgetSpentUsd: number;
}

export interface ToolCallRecord {
  sessionId: string;
  callId: string;
  toolName: string;
  argsJson: string;
  idempotencyKey: string;
  status: ToolCallStatus;
  resultText?: string;
  startedAt: string;
  completedAt?: string;
}

interface SessionFile {
  session: SessionRecord;
  checkpoints: CheckpointRecord[];
  toolCalls: ToolCallRecord[];
}

/* ─── Checkpointer ───────────────────────────────────────────────── */

export class Checkpointer {
  private readonly baseDir: string;

  /** 内存 cache：sessionId → SessionFile，避免每操作读盘 */
  private readonly cache = new Map<string, SessionFile>();

  /**
   * @param baseDir — 持久化目录（默认 .harness/sessions）
   */
  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(".harness", "sessions");
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /* ─── Session 生命周期 ─────────────────────────────────────────── */

  /** 创建新 session */
  createSession(sessionId: string): SessionRecord {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId,
      createdAt: now,
      updatedAt: now,
      status: "active",
    };
    this._write({ session: record, checkpoints: [], toolCalls: [] });
    return record;
  }

  /** 更新 session 状态 */
  updateSessionStatus(sessionId: string, status: SessionStatus): void {
    const file = this._read(sessionId);
    file.session.status = status;
    file.session.updatedAt = new Date().toISOString();
    this._write(file);
  }

  /** 获取 session */
  getSession(sessionId: string): SessionRecord | null {
    try {
      return this._read(sessionId).session;
    } catch {
      return null;
    }
  }

  /* ─── Checkpoint 读写 ──────────────────────────────────────────── */

  /** 保存 checkpoint（自动递增版本号） */
  saveCheckpoint(
    sessionId: string,
    transcriptJson: string,
    planJson?: string,
    budgetSpentUsd = 0,
  ): CheckpointRecord {
    const file = this._ensureSession(sessionId);
    const version = file.checkpoints.length + 1;
    const record: CheckpointRecord = {
      sessionId,
      version,
      createdAt: new Date().toISOString(),
      transcriptJson,
      planJson,
      budgetSpentUsd,
    };
    file.checkpoints.push(record);
    file.session.updatedAt = record.createdAt;
    this._write(file);
    return record;
  }

  /** 加载最新 checkpoint */
  loadLatestCheckpoint(sessionId: string): CheckpointRecord | null {
    const file = this._read(sessionId);
    if (file.checkpoints.length === 0) return null;
    return file.checkpoints[file.checkpoints.length - 1];
  }

  /** 加载指定版本的 checkpoint */
  loadCheckpoint(sessionId: string, version: number): CheckpointRecord | null {
    const file = this._read(sessionId);
    return file.checkpoints.find((c) => c.version === version) ?? null;
  }

  /** 列出所有 checkpoint 版本 */
  listCheckpoints(sessionId: string): CheckpointRecord[] {
    return this._read(sessionId).checkpoints;
  }

  /* ─── Tool-call log ────────────────────────────────────────────── */

  /** 记录工具调用发起 */
  recordToolCallIssued(
    sessionId: string,
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): ToolCallRecord {
    const file = this._ensureSession(sessionId);
    const payload = `${sessionId}:${toolName}:${JSON.stringify(args, Object.keys(args).sort())}`;
    const idempotencyKey = this._sha256(payload);
    const now = new Date().toISOString();
    const record: ToolCallRecord = {
      sessionId,
      callId,
      toolName,
      argsJson: JSON.stringify(args),
      idempotencyKey,
      status: "issued",
      startedAt: now,
    };
    file.toolCalls.push(record);
    this._write(file);
    return record;
  }

  /** 记录工具调用完成 */
  recordToolCallResult(
    sessionId: string,
    callId: string,
    resultText: string,
    success: boolean,
  ): void {
    const file = this._read(sessionId);
    const record = file.toolCalls.find((t) => t.callId === callId);
    if (!record) throw new Error(`tool call not found: ${callId}`);
    record.status = success ? "completed" : "failed";
    record.resultText = resultText;
    record.completedAt = new Date().toISOString();
    this._write(file);
  }

  /** 按幂等 key 查找已完成的调用 */
  findCompletedCall(idempotencyKey: string): ToolCallRecord | null {
    for (const [, file] of this.cache) {
      const found = file.toolCalls.find(
        (t) => t.idempotencyKey === idempotencyKey && t.status === "completed",
      );
      if (found) return found;
    }
    return null;
  }

  /** 按状态获取工具调用列表 */
  getToolCallsByStatus(
    sessionId: string,
    status: ToolCallStatus,
  ): ToolCallRecord[] {
    return this._read(sessionId).toolCalls.filter((t) => t.status === status);
  }

  /** 计算幂等 key（导出给外部用） */
  computeIdempotencyKey(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    const payload = `${sessionId}:${toolName}:${JSON.stringify(args, Object.keys(args).sort())}`;
    return this._sha256(payload);
  }

  /** 列出所有 session */
  listSessions(): SessionRecord[] {
    const sessions: SessionRecord[] = [];
    try {
      const files = fs.readdirSync(this.baseDir);
      for (const f of files) {
        if (f.endsWith(".json")) {
          const file = this._read(f.replace(".json", ""));
          sessions.push(file.session);
        }
      }
    } catch {
      // 目录可能还不在
    }
    return sessions;
  }

  /* ─── 内部方法 ─────────────────────────────────────────────────── */

  private _path(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.json`);
  }

  private _read(sessionId: string): SessionFile {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;

    const raw = fs.readFileSync(this._path(sessionId), "utf-8");
    const file = JSON.parse(raw) as SessionFile;
    this.cache.set(sessionId, file);
    return file;
  }

  private _write(file: SessionFile): void {
    this.cache.set(file.session.sessionId, file);
    fs.writeFileSync(this._path(file.session.sessionId), JSON.stringify(file, null, 2), "utf-8");
  }

  private _ensureSession(sessionId: string): SessionFile {
    try {
      return this._read(sessionId);
    } catch {
      this.createSession(sessionId);
      return this._read(sessionId);
    }
  }

  private _sha256(input: string): string {
    // 纯 JS SHA-256（不需要 crypto 扩展的）
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32bit integer
    }
    // 转为十六进制字符串（模仿 hash 外形，非加密级）
    return Math.abs(hash).toString(16).padStart(8, "0");
  }
}
