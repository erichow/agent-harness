/**
 * 第 9 章测试 — Scratchpad 外部持久化 KV 存储
 *
 * 覆盖：
 *   1. write / read — 基本读写
 *   2. key 消毒 — 拒绝非法 key
 *   3. list — 列出所有 key
 *   4. 持久化 — 跨实例保留
 *   5. 空 scratchpad
 *   6. asTools — 返回正确的工具定义
 *   7. 集成 — 通过 registry 执行
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { Scratchpad } from "../src/harness/tools/scratchpad.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

const TEST_DIR = ".test-scratchpad";

describe("Scratchpad", () => {
  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  /* ─── write / read ──────────────────────────────────────────── */

  it("writes and reads a value", () => {
    const pad = new Scratchpad(TEST_DIR);
    const result = pad.write("plan", "Step 1: read files\nStep 2: summarize");
    expect(result).toContain("wrote");
    expect(result).toContain("plan");

    const content = pad.read("plan");
    expect(content).toBe("Step 1: read files\nStep 2: summarize");
  });

  it("overwrites existing key", () => {
    const pad = new Scratchpad(TEST_DIR);
    pad.write("greeting", "hello");
    pad.write("greeting", "world");
    expect(pad.read("greeting")).toBe("world");
  });

  it("reads back written content exactly", () => {
    const pad = new Scratchpad(TEST_DIR);
    const longText = "x".repeat(10000);
    pad.write("long", longText);
    expect(pad.read("long")).toBe(longText);
  });

  /* ─── key sanitization ──────────────────────────────────────── */

  it("rejects key with slashes", () => {
    const pad = new Scratchpad(TEST_DIR);
    expect(() => pad.write("../../etc/passwd", "evil")).toThrow(
      "invalid key",
    );
  });

  it("rejects key with dots", () => {
    const pad = new Scratchpad(TEST_DIR);
    expect(() => pad.write("config.json", "data")).toThrow("invalid key");
  });

  it("rejects empty key", () => {
    const pad = new Scratchpad(TEST_DIR);
    expect(() => pad.write("", "data")).toThrow("key cannot be empty");
  });

  it("accepts alphanumeric, dash, underscore", () => {
    const pad = new Scratchpad(TEST_DIR);
    pad.write("plan-A_1", "works");
    expect(pad.read("plan-A_1")).toBe("works");
  });

  /* ─── list ──────────────────────────────────────────────────── */

  it("lists all keys sorted", () => {
    const listDir = ".test-scratchpad-list";
    const pad = new Scratchpad(listDir);
    pad.write("b-key", "b");
    pad.write("a-key", "a");
    pad.write("c-key", "c");

    const keys = pad.list();
    expect(keys).toEqual(["a-key", "b-key", "c-key"]);
    fs.rmSync(listDir, { recursive: true, force: true });
  });

  it("returns empty list for empty scratchpad", () => {
    const emptyDir = ".test-scratchpad-empty";
    const pad = new Scratchpad(emptyDir);
    expect(pad.list()).toEqual([]);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  /* ─── read error ────────────────────────────────────────────── */

  it("throws on reading non-existent key", () => {
    const pad = new Scratchpad(TEST_DIR);
    expect(() => pad.read("nonexistent")).toThrow("not found");
  });

  /* ─── asTools ───────────────────────────────────────────────── */

  describe("asTools", () => {
    it("returns 3 tools", () => {
      const pad = new Scratchpad(TEST_DIR);
      const tools = pad.asTools();
      expect(tools).toHaveLength(3);
      expect(tools[0][0].name).toBe("scratchpad_write");
      expect(tools[1][0].name).toBe("scratchpad_read");
      expect(tools[2][0].name).toBe("scratchpad_list");
    });

    it("all 3 tools work through the registry", () => {
      const registry = new ToolRegistry();
      const pad = new Scratchpad(TEST_DIR);

      for (const [def, handler] of pad.asTools()) {
        registry.register(def, handler);
      }

      // scratchpad_write
      const writeResult = registry.execute(
        "scratchpad_write",
        { key: "test-key", content: "hello world" },
        "call-1",
      );
      expect(writeResult.isError).toBe(false);
      expect(writeResult.content).toContain("wrote");

      // scratchpad_read
      const readResult = registry.execute(
        "scratchpad_read",
        { key: "test-key" },
        "call-2",
      );
      expect(readResult.isError).toBe(false);
      expect(readResult.content).toBe("hello world");

      // scratchpad_list
      const listResult = registry.execute(
        "scratchpad_list",
        {},
        "call-3",
      );
      expect(listResult.isError).toBe(false);
      expect(listResult.content).toContain("test-key");
    });
  });
});
