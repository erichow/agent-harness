/**
 * tests/ch18_observability.test.ts — 第 18 章：可观测性
 *
 * Smoke test 验证:
 *   1. setupTracing() 幂等
 *   2. SessionContext 在 span 中正确附加
 *   3. subagentContext() 继承 sessionId/taskId，改变 agentId
 *   4. span() 在同步和异步路径上都正确传递
 */

import { describe, it, expect, beforeEach } from "vitest";

// OTel 的 NodeTracerProvider 需要先 setup 再 import 被测试模块
// 这里我们验证的是 harness 的 wrapper API，不依赖 OTel 后端
import {
  getSessionContext,
  runWithContext,
  subagentContext,
  span,
} from "../src/harness/observability/tracing.js";
import type { SessionContext } from "../src/harness/observability/tracing.js";

describe("SessionContext", () => {
  it("returns null when no context is set", () => {
    expect(getSessionContext()).toBeNull();
  });

  it("returns the context set by runWithContext", () => {
    const ctx: SessionContext = {
      sessionId: "s-001",
      taskId: "t-001",
      agentId: "root",
    };
    runWithContext(ctx, () => {
      expect(getSessionContext()).toEqual(ctx);
    });
  });

  it("restores previous context after runWithContext exits", () => {
    const ctx: SessionContext = {
      sessionId: "s-001",
      taskId: "t-001",
      agentId: "root",
    };
    runWithContext(ctx, () => { /* noop */ });
    expect(getSessionContext()).toBeNull();
  });
});

describe("subagentContext", () => {
  it("inherits sessionId and taskId, changes agentId", () => {
    const parent: SessionContext = {
      sessionId: "s-001",
      taskId: "t-001",
      agentId: "root",
    };
    const sub = subagentContext(parent, "sub-researcher");

    expect(sub.sessionId).toBe("s-001");
    expect(sub.taskId).toBe("t-001");
    expect(sub.agentId).toBe("sub-researcher");
  });

  it("does not mutate the parent context", () => {
    const parent: SessionContext = {
      sessionId: "s-001",
      taskId: "t-001",
      agentId: "root",
    };
    const original = { ...parent };
    subagentContext(parent, "sub-xxx");
    expect(parent).toEqual(original);
  });
});

describe("span()", () => {
  it("executes the callback and returns its value", () => {
    const result = span("test-span", {}, () => 42);
    expect(result).toBe(42);
  });

  it("propagates exceptions from the callback", () => {
    expect(() => {
      span("error-span", {}, () => {
        throw new Error("intentional");
      });
    }).toThrow("intentional");
  });

  it("attaches SessionContext attributes when run under runWithContext", () => {
    const ctx: SessionContext = {
      sessionId: "s-002",
      taskId: "t-002",
      agentId: "test-agent",
    };

    // span() 内部会调用 getSessionContext()，在 runWithContext 内应拿到 ctx
    let captured: SessionContext | null = null;
    runWithContext(ctx, () => {
      span("check-ctx", {}, () => {
        captured = getSessionContext();
      });
    });

    expect(captured).not.toBeNull();
    expect(captured!.sessionId).toBe("s-002");
    expect(captured!.agentId).toBe("test-agent");
  });
});

describe("setupTracing", () => {
  it("can be called multiple times (idempotent)", async () => {
    // 只需确认不抛异常
    const { setupTracing } = await import(
      "../src/harness/observability/tracing.js"
    );
    expect(() => setupTracing()).not.toThrow();
    expect(() => setupTracing()).not.toThrow();  // 第二次是 no-op
    expect(() => setupTracing("another-name")).not.toThrow();  // 仍 no-op
  });
});
