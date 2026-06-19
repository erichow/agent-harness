/**
 * 第 7 章测试 — 上下文窗口记账
 *
 * 覆盖：
 *   1. ContextBudget — 配置和 usable 计算
 *   2. ContextSnapshot — totalUsed, utilization, state 判定
 *   3. ContextAccountant — 对 text / messages / tools 的计数
 *   4. 集成测试 — snapshot 与 transcript 联动
 *   5. agent 集成 — onSnapshot 回调
 */
import { describe, it, expect } from "vitest";
import {
  ContextBudget,
  ContextSnapshot,
  ContextAccountant,
} from "../src/harness/context/accountant.js";
import { Message, Transcript } from "../src/harness/messages.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { arun } from "../src/harness/agent.js";
import type { ContextSnapshot as CS } from "../src/harness/context/accountant.js";

/* ─── ContextBudget ──────────────────────────────────────────────── */

describe("ContextBudget", () => {
  it("uses defaults", () => {
    const b = new ContextBudget();
    expect(b.windowSize).toBe(200_000);
    expect(b.headroom).toBe(4096);
    expect(b.usable).toBe(200_000 - 4096);
  });

  it("computes usable = windowSize - headroom", () => {
    const b = new ContextBudget(100_000, 2000);
    expect(b.usable).toBe(98_000);
  });

  it("custom thresholds", () => {
    const b = new ContextBudget(200_000, 4096, 0.5, 0.75);
    expect(b.yellowThreshold).toBe(0.5);
    expect(b.redThreshold).toBe(0.75);
  });
});

/* ─── ContextSnapshot ────────────────────────────────────────────── */

describe("ContextSnapshot", () => {
  const budget = new ContextBudget(200_000, 4096);

  it("totalUsed excludes headroom", () => {
    const snap = new ContextSnapshot(
      { system: 100, tools: 200, history: 300, retrieved: 0, headroom: 4096 },
      budget,
    );
    expect(snap.totalUsed).toBe(600);
  });

  it("utilization = totalUsed / usable", () => {
    const snap = new ContextSnapshot(
      { system: 100, tools: 200, history: 300, retrieved: 0, headroom: 4096 },
      budget,
    );
    const expectedUtil = 600 / (200_000 - 4096);
    expect(snap.utilization).toBeCloseTo(expectedUtil, 6);
  });

  it("state is green when below yellow threshold", () => {
    const snap = new ContextSnapshot(
      { system: 10_000, tools: 10_000, history: 20_000, retrieved: 0, headroom: 4096 },
      budget,
    );
    // 40_000 / 195_904 ≈ 0.204 → green
    expect(snap.state).toBe("green");
  });

  it("state is yellow between thresholds", () => {
    const snap = new ContextSnapshot(
      { system: 2000, tools: 5000, history: 120_000, retrieved: 0, headroom: 4096 },
      budget,
    );
    // 127_000 / 195_904 ≈ 0.648 → yellow (≥ 0.60)
    expect(snap.state).toBe("yellow");
  });

  it("state is red above red threshold", () => {
    const snap = new ContextSnapshot(
      { system: 2000, tools: 5000, history: 170_000, retrieved: 0, headroom: 4096 },
      budget,
    );
    // 177_000 / 195_904 ≈ 0.904 → red
    expect(snap.state).toBe("red");
  });

  it("utilization handles zero usable (defensive)", () => {
    const tinyBudget = new ContextBudget(100, 100); // usable = 0
    const snap = new ContextSnapshot(
      { system: 0, tools: 0, history: 0, retrieved: 0, headroom: 100 },
      tinyBudget,
    );
    expect(snap.utilization).toBe(0);
  });
});

/* ─── ContextAccountant: text counting ───────────────────────────── */

describe("ContextAccountant — text counting", () => {
  it("empty string counts as 0 tokens", () => {
    const acct = new ContextAccountant();
    const transcript = new Transcript("");
    transcript.append(Message.userText(""));
    const snap = acct.snapshot(transcript);
    expect(snap.totals.system).toBe(0);
  });

  it("counts longer text as more tokens", () => {
    const acct = new ContextAccountant();
    const short = acct.snapshot(
      new Transcript("hello"),
    );
    const long = acct.snapshot(
      new Transcript("hello world this is a much longer sentence with many words"),
    );
    expect(long.totals.system).toBeGreaterThan(short.totals.system);
  });
});

/* ─── ContextAccountant: transcript counting ─────────────────────── */

describe("ContextAccountant — message counting", () => {
  it("counts messages in transcript history", () => {
    const acct = new ContextAccountant();
    const transcript = new Transcript("You are a helpful assistant.");
    transcript.append(Message.userText("Hello!"));
    transcript.append(Message.assistantText("Hi there! How can I help?"));

    const snap = acct.snapshot(transcript);
    // system + 2 messages should add up to something > system alone
    expect(snap.totals.history).toBeGreaterThan(0);
  });

  it("counts tool call and tool result blocks", () => {
    const acct = new ContextAccountant();
    const transcript = new Transcript("system");
    transcript.append(Message.userText("calculate something"));
    transcript.append(Message.assistantToolCall(
      { kind: "tool_call", id: "call-1", name: "calc", args: { expression: "1+1" } },
    ));
    transcript.append(Message.toolResult(
      { kind: "tool_result", callId: "call-1", content: "2", isError: false },
    ));

    const snap = acct.snapshot(transcript);
    // Should count the tool call and result blocks
    expect(snap.totals.history).toBeGreaterThan(0);
  });
});

/* ─── ContextAccountant: snapshot completeness ───────────────────── */

describe("ContextAccountant — snapshot", () => {
  it("returns all 5 components in totals", () => {
    const acct = new ContextAccountant();
    const transcript = new Transcript("system prompt");
    transcript.append(Message.userText("hello"));

    const snap = acct.snapshot(transcript, [{ name: "calc", description: "calc", input_schema: {} }]);
    expect(snap.totals).toHaveProperty("system");
    expect(snap.totals).toHaveProperty("tools");
    expect(snap.totals).toHaveProperty("history");
    expect(snap.totals).toHaveProperty("retrieved");
    expect(snap.totals).toHaveProperty("headroom");
  });

  it("snapshot changes as transcript grows", () => {
    const acct = new ContextAccountant();
    const transcript = new Transcript("system");

    const snap1 = acct.snapshot(transcript);
    transcript.append(Message.userText("a very long user message that adds tokens to the history"));
    const snap2 = acct.snapshot(transcript);

    expect(snap2.totals.history).toBeGreaterThan(snap1.totals.history);
  });
});

/* ─── Agent integration ──────────────────────────────────────────── */

describe("agent integration with ContextAccountant", () => {
  it("onSnapshot is called each iteration", async () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([
      new ProviderResponse("Hello!"),
    ]);
    const snapshots: CS[] = [];

    await arun(
      mock, registry, "Hi",
      undefined,    // transcript
      undefined,    // system
      undefined,    // onEvent
      undefined,    // onToolCall
      undefined,    // onToolResult
      (s) => snapshots.push(s),
    );

    expect(snapshots.length).toBe(1);
    expect(snapshots[0].totals).toHaveProperty("system");
    expect(snapshots[0].totals).toHaveProperty("history");
    expect(snapshots[0].totals).toHaveProperty("tools");
  });

  it("onSnapshot fires each turn in multi-turn", async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "echo",
        description: "Echo",
        inputSchema: { type: "object", properties: { msg: { type: "string" } } },
      },
      (args) => `echoed: ${args.msg}`,
    );
    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("c1", "echo", { msg: "hi" })]),
      new ProviderResponse("Done!"),
    ]);
    const snapshots: CS[] = [];

    await arun(
      mock, registry, "echo hi",
      undefined, undefined, undefined, undefined, undefined,
      (s) => snapshots.push(s),
    );

    // Turn 1: snapshot before provider call
    // Turn 2: snapshot before second provider call
    expect(snapshots.length).toBe(2);
  });

  it("custom accountant is used", async () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([
      new ProviderResponse("Final answer"),
    ]);
    const customBudget = new ContextBudget(100_000, 2000, 0.5, 0.8);
    const accountant = new ContextAccountant(customBudget);
    const snapshots: CS[] = [];

    await arun(
      mock, registry, "Hi",
      undefined, undefined, undefined, undefined, undefined,
      (s) => snapshots.push(s),
      accountant,
    );

    expect(snapshots[0].budget.windowSize).toBe(100_000);
    expect(snapshots[0].budget.headroom).toBe(2000);
  });
});
