/**
 * 第 8 章测试 — 压缩（Compaction）
 *
 * 覆盖：
 *   1. maskOlderResults — 幂等、保留最近、token 释放
 *   2. summarizePrefix — 跳过 anchor、替换前缀
 *   3. Compactor — 先 mask 再 summarize、红色不触发、两根不够则警告
 *   4. Agent 集成 — compactor 参数、onCompaction 回调
 */
import { describe, it, expect } from "vitest";
import { Message, Transcript } from "../src/harness/messages.js";
import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import { ContextAccountant, ContextBudget } from "../src/harness/context/accountant.js";
import { maskOlderResults } from "../src/harness/context/masking.js";
import { summarizePrefix } from "../src/harness/context/summarizer.js";
import { Compactor } from "../src/harness/context/compactor.js";
import { arun } from "../src/harness/agent.js";
import type { CompactionResult } from "../src/harness/context/compactor.js";

/* ─── maskOlderResults ───────────────────────────────────────────── */

describe("maskOlderResults", () => {
  function makeTranscriptWithResults(count: number): Transcript {
    const t = new Transcript("system");
    for (let i = 0; i < count; i++) {
      t.append(Message.assistantToolCall({
        kind: "tool_call", id: `c-${i}`, name: "echo",
        args: { msg: `hello-${i}` },
      }));
      t.append(Message.toolResult({
        kind: "tool_result", callId: `c-${i}`,
        content: `result-${i}-${"x".repeat(100)}`,
        isError: false,
      }));
    }
    return t;
  }

  it("does nothing when count <= keepRecent", () => {
    const t = makeTranscriptWithResults(2);
    const freed = maskOlderResults(t, 3);
    expect(freed).toBe(0);
    // 所有 tool_result 都应该未 mask
    for (const msg of t.messages) {
      for (const block of msg.blocks) {
        if (block.kind === "tool_result") {
          expect(block.content.startsWith("[tool_result elided")).toBe(false);
        }
      }
    }
  });

  it("masks older results, keeps recent ones", () => {
    const t = makeTranscriptWithResults(5);
    const freed = maskOlderResults(t, 2);
    expect(freed).toBeGreaterThan(0);

    let maskedCount = 0;
    let keptCount = 0;
    for (const msg of t.messages) {
      for (const block of msg.blocks) {
        if (block.kind === "tool_result") {
          if (block.content.startsWith("[tool_result elided")) {
            maskedCount++;
          } else {
            keptCount++;
          }
        }
      }
    }
    // 5 个结果，keepRecent=2，应 mask 3 个
    expect(maskedCount).toBe(3);
    expect(keptCount).toBe(2);
  });

  it("is idempotent — second call frees 0", () => {
    const t = makeTranscriptWithResults(5);
    maskOlderResults(t, 2);
    const freed2 = maskOlderResults(t, 2);
    expect(freed2).toBe(0);
  });

  it("masks nothing when there are no tool results", () => {
    const t = new Transcript("system");
    t.append(Message.userText("hello"));
    t.append(Message.assistantText("hi"));
    const freed = maskOlderResults(t, 3);
    expect(freed).toBe(0);
  });

  it("preserves callId and isError in masked result", () => {
    const t = makeTranscriptWithResults(3);
    maskOlderResults(t, 1);

    for (const msg of t.messages) {
      for (const block of msg.blocks) {
        if (block.kind === "tool_result" && block.content.startsWith("[tool_result elided")) {
          // callId 应该保留
          expect(block.callId).toBeTruthy();
          expect(typeof block.isError).toBe("boolean");
        }
      }
    }
  });
});

/* ─── summarizePrefix ────────────────────────────────────────────── */

describe("summarizePrefix", () => {
  it("returns null when not enough messages", async () => {
    const t = new Transcript("system");
    t.append(Message.userText("hello"));
    t.append(Message.assistantText("world"));
    const provider = new MockProvider([new ProviderResponse("summary")]);

    const result = await summarizePrefix(t, provider, 6);
    expect(result).toBeNull();
  });

  it("replaces prefix with a summary message", async () => {
    const t = new Transcript("system");
    t.append(Message.userText("anchor — initial goal"));  // msg[0] — anchor
    t.append(Message.userText("turn 1"));                  // msg[1]
    t.append(Message.assistantText("response 1"));         // msg[2]
    t.append(Message.userText("turn 2"));                  // msg[3]
    t.append(Message.assistantText("response 2"));         // msg[4]
    t.append(Message.userText("turn 3"));                  // msg[5]
    t.append(Message.assistantText("response 3"));         // msg[6] — kept as recent

    const provider = new MockProvider([new ProviderResponse("This is a summary of turns 1-2.")]);

    const result = await summarizePrefix(t, provider, 2);
    // msg[0] + msg[1..4] (4 turns) summarized → replaced with 1 summary msg
    // Total: anchor(0) + summary(1) + recent(2) = 3
    expect(result).not.toBeNull();
    expect(result!.turnsReplaced).toBe(4);
    expect(result!.inputTokens).toBe(0);
    expect(result!.outputTokens).toBe(0);
    // anchor(0) + summaryMsg + turn3 + resp3 = 4 messages
    expect(t.messages.length).toBe(4);
    expect(t.messages[0].blocks[0].kind).toBe("text");
    expect(t.messages[1].blocks[0].kind).toBe("text");
    const block = t.messages[1].blocks[0];
    if (block.kind === "text") {
      expect(block.text).toContain("session summary");
    }
  });
});

/* ─── Compactor ──────────────────────────────────────────────────── */

describe("Compactor", () => {
  it("does nothing when state is green", async () => {
    const provider = new MockProvider([new ProviderResponse("summary")]);
    const accountant = new ContextAccountant(new ContextBudget(200_000, 4096, 0.6, 0.8));
    const compactor = new Compactor(accountant, provider);
    const t = new Transcript("system");
    t.append(Message.userText("hello"));
    t.append(Message.assistantText("hi"));

    const result = await compactor.compactIfNeeded(t, []);
    expect(result.finalState).toBe("green");
    expect(result.maskingTokensFreed).toBe(0);
  });

  it("applies masking when in red", async () => {
    const provider = new MockProvider([new ProviderResponse("summary")]);
    const accountant = new ContextAccountant(new ContextBudget(200_000, 4096, 0.6, 0.005));
    const compactor = new Compactor(accountant, provider);
    const t = new Transcript("system");
    // 加很多消息使其 red
    for (let i = 0; i < 10; i++) {
      t.append(Message.assistantToolCall({
        kind: "tool_call", id: `c-${i}`, name: "echo", args: { msg: "x" },
      }));
      t.append(Message.toolResult({
        kind: "tool_result", callId: `c-${i}`,
        content: "x".repeat(5000), isError: false,
      }));
    }

    const result = await compactor.compactIfNeeded(t, []);
    // 应该 mask 了一些 tool_result
    expect(result.maskingTokensFreed).toBeGreaterThan(0);
  });
});

/* ─── Agent integration ──────────────────────────────────────────── */

describe("agent integration with Compactor", () => {
  it("onCompaction fires when red state triggers", async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "echo",
        description: "Echo",
        inputSchema: { type: "object", properties: { msg: { type: "string" } } },
      },
      (args) => `echoed: ${args.msg}`,
    );

    // 用极小的 budget + 很长的 system prompt 让第 1 回合就 red
    const bigSystem = "x".repeat(500); // ~125 tokens
    const tinyBudget = new ContextBudget(300, 20, 0.3, 0.4); // usable=280, red at 112
    const accountant = new ContextAccountant(tinyBudget);
    // compactor 的 provider 独立于主 loop
    const summaryProvider = new MockProvider([
      new ProviderResponse("summary text"),
    ]);
    const compactor = new Compactor(accountant, summaryProvider);

    const mock = new MockProvider([
      new ProviderResponse(undefined, [new ToolCallRef("c1", "echo", { msg: "hi" })]),
      new ProviderResponse("Done!"),
    ]);

    const snapshots: string[] = [];
    const compactions: CompactionResult[] = [];

    await arun(
      mock, registry, "Hello world!",
      undefined,            // transcript
      bigSystem,            // system — 大文本确保 red
      undefined, undefined, undefined,
      (s) => snapshots.push(s.state),
      accountant,
      compactor,
      (r) => compactions.push(r),
    );

    // 应该至少有一次压缩
    expect(compactions.length).toBeGreaterThanOrEqual(1);
    // snapshot 应该包含压缩前后的状态
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
  });

  it("compactor defaults do not break normal flow", async () => {
    const registry = new ToolRegistry();
    const mock = new MockProvider([new ProviderResponse("Hello!")]);

    // 不传 compactor，用默认
    await arun(mock, registry, "Hi");
    // 没报错就算通过
  });
});
