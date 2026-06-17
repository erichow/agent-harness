/**
 * 烟雾测试 — 验证包可导入、运行时正确
 */
import { describe, it, expect } from "vitest";
import { VERSION } from "../src/harness/index.js";

describe("harness smoke tests", () => {
  it("exports a version string", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("runs on Node.js 20+", () => {
    const parts = process.version.slice(1).split(".").map(Number);
    expect(parts[0]).toBeGreaterThanOrEqual(20);
  });
});
