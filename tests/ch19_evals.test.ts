/**
 * tests/ch19_evals.test.ts — 第 19 章：评测 (Evals)
 *
 * 覆盖：
 *   1. EvalCase / EvalResult 类型
 *   2. EvalRunner 处理 checkAnswer pass / fail
 *   3. EvalRunner 处理 crash
 *   4. caseFromTrace 转换
 *   5. checkAnswer 函数
 */
import { describe, it, expect } from "vitest";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse } from "../src/harness/providers/base.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import type { EvalCase } from "../src/harness/evals/case.js";
import { EvalRunner } from "../src/harness/evals/runner.js";
import { caseFromTrace } from "../src/harness/evals/from_trace.js";
import type { TraceSummary } from "../src/harness/evals/from_trace.js";

/* ─── 测试用的工具 ─────────────────────────────────────────────── */

function calcDef() {
  return {
    name: "calc",
    description: "Add two numbers",
    inputSchema: {
      type: "object" as const,
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  };
}

function calcHandler(args: Record<string, unknown>): string {
  return String((args.a as number) + (args.b as number));
}

/* ─── EvalRunner ──────────────────────────────────────────────────── */

describe("EvalRunner", () => {
  it("passes a case where checkAnswer matches", async () => {
    const registry = new ToolRegistry();
    registry.register(calcDef(), calcHandler);

    const case_: EvalCase = {
      id: "check-pass",
      description: "answer contains 4",
      userMessage: "what is 2+2?",
      checkAnswer: (ans) => ans.includes("4"),
    };

    const provider = new MockProvider([new ProviderResponse("The answer is 4")]);
    const runner = new EvalRunner(provider, registry);
    const result = await runner.runOne(case_);

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when checkAnswer returns false", async () => {
    const registry = new ToolRegistry();
    registry.register(calcDef(), calcHandler);

    const case_: EvalCase = {
      id: "check-fail",
      description: "expects 42 but gets 4",
      userMessage: "what is the meaning of life?",
      checkAnswer: (ans) => ans.includes("42"),
    };

    const provider = new MockProvider([new ProviderResponse("The answer is 4")]);
    const runner = new EvalRunner(provider, registry);
    const result = await runner.runOne(case_);

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("answer check failed");
  });

  it("handles arun crash as failure", async () => {
    const registry = new ToolRegistry();
    registry.register(calcDef(), calcHandler);

    const crashCase: EvalCase = {
      id: "crash-test",
      description: "provider with no responses",
      userMessage: "crash me",
    };

    // Provider with no responses — arun will throw
    const provider = new MockProvider([]);
    const runner = new EvalRunner(provider, registry);
    const result = await runner.runOne(crashCase);

    // Expect crash to be caught, not thrown
    expect(result.passed).toBe(false);
    // arun throws error — runner catches it
    expect(typeof result.durationMs).toBe("number");
  });
});

/* ─── checkAnswer ─────────────────────────────────────────────────── */

describe("checkAnswer", () => {
  it("passes with matching content", () => {
    const check = (ans: string) => ["1", "4", "9"].every((n) => ans.includes(n));
    expect(check("Results: 1, 4, 9")).toBe(true);
  });

  it("fails with missing content", () => {
    const check = (ans: string) => ["1", "4", "9"].every((n) => ans.includes(n));
    expect(check("Results: 1, 4")).toBe(false);
  });
});

/* ─── caseFromTrace ───────────────────────────────────────────────── */

describe("caseFromTrace", () => {
  it("creates EvalCase from trace summary", () => {
    const trace: TraceSummary = {
      traceId: "abcdef123456",
      userMessage: "read /etc/hostname",
      system: "You are a helpful assistant.",
      tokensUsed: 5000,
      failureReason: "timeout after 15 iterations",
    };

    const result = caseFromTrace(trace);

    expect(result.id).toBe("prod-regression-abcdef12");
    expect(result.userMessage).toBe("read /etc/hostname");
    expect(result.system).toBe("You are a helpful assistant.");
    expect(result.description).toContain("timeout");
    expect(result.maxTokens).toBe(7500); // 5000 * 1.5
  });

  it("handles missing failure reason", () => {
    const trace: TraceSummary = {
      traceId: "short",
      userMessage: "hello",
      tokensUsed: 100,
    };

    const result = caseFromTrace(trace);
    expect(result.description).toContain("regression from production");
  });

  it("enforces minimum maxTokens of 1000", () => {
    const trace: TraceSummary = {
      traceId: "tiny",
      userMessage: "hi",
      tokensUsed: 10,
    };

    const result = caseFromTrace(trace);
    expect(result.maxTokens).toBeGreaterThanOrEqual(1000);
  });
});
