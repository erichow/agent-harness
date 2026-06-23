/**
 * tests/ch20_cost.test.ts — 第 20 章：成本控制
 *
 * 覆盖：
 *   1. BudgetEnforcer.record — 成本累积
 *   2. BudgetEnforcer — 告警阈值触发
 *   3. BudgetEnforcer — halt 时 throw BudgetExceeded
 *   4. BudgetEnforcer — 剩余预算
 *   5. ModelRouter.choose — economy / mid / premium
 *   6. ModelRouter — 长 context 触发 premium
 */
import { describe, it, expect } from "vitest";
import { BudgetEnforcer, BudgetExceeded } from "../src/harness/cost/enforcer.js";
import { ModelRouter } from "../src/harness/cost/router.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse } from "../src/harness/providers/base.js";

/* ─── BudgetEnforcer ─────────────────────────────────────────────── */

describe("BudgetEnforcer", () => {
  it("accumulates costs from record()", () => {
    const enforcer = new BudgetEnforcer(1.0);

    // Sonnet: 1000 input + 200 output
    enforcer.record(1000, 200, "claude-sonnet-4-6");

    // (1000 * 3.0 + 200 * 15.0) / 1_000_000 = (3000 + 3000) / 1_000_000 = 0.006
    expect(enforcer.spentUsd).toBeCloseTo(0.006, 5);
  });

  it("fires alert thresholds", () => {
    const alerted: string[] = [];
    const consoleWarn = console.warn;
    console.warn = (msg: string) => alerted.push(msg);

    try {
      // maxUsd = 0.01, 50% at 0.005
      const enforcer = new BudgetEnforcer(0.01, [0.5]);

      // Sonnet: 1000 input tokens → 0.003. Half of threshold (0.005) not yet
      enforcer.record(1000, 0, "claude-sonnet-4-6"); // 0.003
      expect(alerted.length).toBe(0); // 30% < 50%

      // Another 1000 input → 0.006. Over 50% threshold
      enforcer.record(1000, 0, "claude-sonnet-4-6"); // 0.006
      expect(alerted.length).toBe(1);
      expect(alerted[0]).toContain("50%");
    } finally {
      console.warn = consoleWarn;
    }
  });

  it("throws BudgetExceeded when spent exceeds max", () => {
    const enforcer = new BudgetEnforcer(0.005);

    expect(() => {
      // Sonnet 2000 input → 0.006 > 0.005
      enforcer.record(2000, 0, "claude-sonnet-4-6");
    }).toThrow(BudgetExceeded);
  });

  it("throws with correct spent and max values", () => {
    const enforcer = new BudgetEnforcer(0.01);

    try {
      enforcer.record(4000, 0, "claude-sonnet-4-6"); // 0.012 > 0.01
    } catch (e) {
      expect(e).toBeInstanceOf(BudgetExceeded);
      const be = e as BudgetExceeded;
      expect(be.spentUsd).toBeCloseTo(0.012, 4);
      expect(be.maxUsd).toBe(0.01);
    }
  });

  it("reports remaining budget", () => {
    const enforcer = new BudgetEnforcer(1.0);
    expect(enforcer.remainingUsd()).toBeCloseTo(1.0);
    expect(enforcer.isExceeded()).toBe(false);

    enforcer.record(100_000, 10_000, "claude-sonnet-4-6"); // ~0.45
    expect(enforcer.remainingUsd()).toBeLessThan(1.0);
    expect(enforcer.remainingUsd()).toBeGreaterThan(0.5);
  });
});

/* ─── ModelRouter ─────────────────────────────────────────────────── */

describe("ModelRouter", () => {
  const economy = new MockProvider([new ProviderResponse("economy")]);
  const mid = new MockProvider([new ProviderResponse("mid")]);
  const premium = new MockProvider([new ProviderResponse("premium")]);
  const router = new ModelRouter(economy, mid, premium);

  it("routes classify/extract/summarize to economy", () => {
    expect(router.choose(undefined, "classify")).toBe(economy);
    expect(router.choose(undefined, "extract")).toBe(economy);
    expect(router.choose(undefined, "summarize")).toBe(economy);
  });

  it("routes code/plan/reason to premium", () => {
    expect(router.choose(undefined, "code")).toBe(premium);
    expect(router.choose(undefined, "plan")).toBe(premium);
    expect(router.choose(undefined, "reason")).toBe(premium);
    expect(router.choose(undefined, "debug")).toBe(premium);
  });

  it("defaults to mid for unknown tasks", () => {
    expect(router.choose(undefined, "translate")).toBe(mid);
    expect(router.choose()).toBe(mid); // no hint at all
  });

  it("routes long context to premium", () => {
    const longTranscript = {
      messages: Array.from({ length: 10 }, (_, i) => ({
        content: "x".repeat(25_000), // ~250K chars ≈ 62K tokens
      })),
    };
    expect(router.choose(longTranscript, "classify")).toBe(premium);
    // 即使 hint 是 classify，长 context 也 override
  });

  it("chooseTier returns correct tier name", () => {
    expect(router.chooseTier(undefined, "classify")).toBe("economy");
    expect(router.chooseTier(undefined, "code")).toBe("premium");
    expect(router.chooseTier()).toBe("mid");
  });
});
