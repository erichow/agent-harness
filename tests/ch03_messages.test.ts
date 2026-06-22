/**
 * 第 3 章测试 — 类型化消息系统
 *
 * 验证 Block 类型和工厂、Message 构建与序列化、Transcript 操作。
 * 核心特性：不可变性、类型安全、多 Block 组合。
 */
import { describe, it, expect } from "vitest";
import {
  textBlock,
  toolCallBlock,
  toolResultBlock,
  reasoningBlock,
  Message,
  Transcript,
} from "../src/harness/messages.js";
import type { Block } from "../src/harness/messages.js";
import { ProviderResponse, ToolCallRef } from "../src/harness/providers/base.js";

describe("Block 工厂", () => {
  it("textBlock 创建文本块", () => {
    const b = textBlock("hello");
    expect(b.kind).toBe("text");
    expect(b.text).toBe("hello");
  });

  it("toolCallBlock 创建工具调用块", () => {
    const b = toolCallBlock("c1", "calc", { expression: "1+1" });
    expect(b.kind).toBe("tool_call");
    expect(b.id).toBe("c1");
    expect(b.name).toBe("calc");
    expect(b.args).toEqual({ expression: "1+1" });
  });

  it("toolResultBlock 创建工具结果块（默认 isError=false）", () => {
    const b = toolResultBlock("c1", "2");
    expect(b.kind).toBe("tool_result");
    expect(b.callId).toBe("c1");
    expect(b.content).toBe("2");
    expect(b.isError).toBe(false);
  });

  it("toolResultBlock 支持 isError=true", () => {
    const b = toolResultBlock("c1", "error", true);
    expect(b.isError).toBe(true);
  });

  it("reasoningBlock 创建推理块", () => {
    const b = reasoningBlock("thinking process");
    expect(b.kind).toBe("reasoning");
    expect(b.text).toBe("thinking process");
    expect(b.metadata).toEqual({});
  });

  it("reasoningBlock 接受自定义 metadata", () => {
    const b = reasoningBlock("thinking", { signature: "abc123" });
    expect(b.metadata.signature).toBe("abc123");
  });
});

describe("Message", () => {
  it("创建一个完整的 Message", () => {
    const msg = new Message("user", [textBlock("hello")]);
    expect(msg.role).toBe("user");
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0].kind).toBe("text");
  });

  it("自动生成 id 和 createdAt", () => {
    const msg = new Message("user", [textBlock("hi")]);
    expect(msg.id).toBeDefined();
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.createdAt).toBeInstanceOf(Date);
  });

  it("userText 工厂方法创建纯文本用户消息", () => {
    const msg = Message.userText("What is 2+2?");
    expect(msg.role).toBe("user");
    expect(msg.blocks).toHaveLength(1);
    const block = msg.blocks[0];
    expect(block.kind).toBe("text");
    if (block.kind === "text") {
      expect(block.text).toBe("What is 2+2?");
    }
  });

  it("assistantText 工厂方法创建助手文本消息", () => {
    const msg = Message.assistantText("答案是 42");
    expect(msg.role).toBe("assistant");
    expect(msg.blocks).toHaveLength(1);
    const block = msg.blocks[0];
    expect(block.kind).toBe("text");
  });

  it("assistantText 支持附加推理块", () => {
    const rb = reasoningBlock("用户问算术题");
    const msg = Message.assistantText("答案是 42", rb);
    expect(msg.blocks).toHaveLength(2);
    expect(msg.blocks[0].kind).toBe("reasoning");
    expect(msg.blocks[1].kind).toBe("text");
  });

  it("assistantToolCall 工厂方法创建工具调用消息", () => {
    const tc = toolCallBlock("c1", "calc", { expression: "1+1" });
    const msg = Message.assistantToolCall(tc);
    expect(msg.role).toBe("assistant");
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0].kind).toBe("tool_call");
  });

  it("assistantToolCall 支持附加推理块", () => {
    const tc = toolCallBlock("c1", "calc", {});
    const rb = reasoningBlock("需要计算");
    const msg = Message.assistantToolCall(tc, rb);
    expect(msg.blocks).toHaveLength(2);
    expect(msg.blocks[0].kind).toBe("reasoning");
    expect(msg.blocks[1].kind).toBe("tool_call");
  });

  it("toolResult 创建工具结果消息（role=user）", () => {
    const tr = toolResultBlock("c1", "42");
    const msg = Message.toolResult(tr);
    expect(msg.role).toBe("user");
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0].kind).toBe("tool_result");
  });
});

describe("Message.fromAssistantResponse", () => {
  it("从文本响应创建 assistant 消息", () => {
    const response = new ProviderResponse("hello");
    const msg = Message.fromAssistantResponse(response);
    expect(msg.role).toBe("assistant");
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0].kind).toBe("text");
  });

  it("从工具调用响应创建 assistant 消息", () => {
    const response = new ProviderResponse(undefined, [
      new ToolCallRef("c1", "calc", { expression: "1+1" }),
    ]);
    const msg = Message.fromAssistantResponse(response);
    expect(msg.role).toBe("assistant");
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0].kind).toBe("tool_call");
  });

  it("从含推理文本的响应创建 assistant 消息", () => {
    const response = new ProviderResponse("answer", [], "thinking...", { sig: "x" });
    const msg = Message.fromAssistantResponse(response);
    expect(msg.role).toBe("assistant");
    expect(msg.blocks).toHaveLength(2);
    expect(msg.blocks[0].kind).toBe("reasoning");
    expect(msg.blocks[1].kind).toBe("text");
  });

  it("从含推理文本的工具调用响应创建 assistant 消息", () => {
    const response = new ProviderResponse(
      "let me calculate",
      [new ToolCallRef("c1", "calc", { expression: "1+1" })],
      "用户问算术题",
    );
    const msg = Message.fromAssistantResponse(response);
    expect(msg.blocks).toHaveLength(2);
    expect(msg.blocks[0].kind).toBe("reasoning");
    expect(msg.blocks[1].kind).toBe("tool_call");
  });
});

describe("Transcript", () => {
  it("创建空的 Transcript", () => {
    const t = new Transcript();
    expect(t.messages).toHaveLength(0);
    expect(t.system).toBeUndefined();
  });

  it("创建带 system prompt 的 Transcript", () => {
    const t = new Transcript("你是一个助手");
    expect(t.system).toBe("你是一个助手");
  });

  it("append 增加消息", () => {
    const t = new Transcript();
    t.append(Message.userText("hi"));
    expect(t.messages).toHaveLength(1);
  });

  it("extend 批量增加消息", () => {
    const t = new Transcript();
    t.extend([Message.userText("hi"), Message.userText("again")]);
    expect(t.messages).toHaveLength(2);
  });

  it("last 返回最后一条消息", () => {
    const t = new Transcript();
    t.append(Message.userText("first"));
    t.append(Message.userText("last"));
    expect(t.last()?.blocks[0].kind).toBe("text");
  });

  it("last 在空 Transcript 上返回 undefined", () => {
    const t = new Transcript();
    expect(t.last()).toBeUndefined();
  });

  it("length 返回消息数量", () => {
    const t = new Transcript();
    expect(t.length).toBe(0);
    t.append(Message.userText("a"));
    t.append(Message.userText("b"));
    expect(t.length).toBe(2);
  });
});
