/**
 * MockProvider — 脚本化的假 Provider，用于教学和测试
 *
 * 第 3 章：用新 ProviderResponse 形状（无 kind 字段）
 * 第 5 章：增加 astream() 流式支持 + 预设 StreamEvent 序列
 *
 * 离线、确定性、零成本。按固定顺序逐条返回预设的响应。
 */
import type { Transcript } from "../messages.js";
import { ProviderResponse, ToolCallRef } from "./base.js";
import type { Provider } from "./base.js";
import type { StreamEvent } from "./events.js";
import { textDelta, toolCallStart, toolCallDelta, completed } from "./events.js";

/** 预设的流式事件序列 */
interface StreamPreset {
  events: StreamEvent[];
}

export class MockProvider implements Provider {
  name = "mock";

  private responses: ProviderResponse[];
  private streamPresets: StreamPreset[];
  private index: number;

  constructor(responses: ProviderResponse[]) {
    this.responses = [...responses];
    this.streamPresets = [];
    this.index = 0;
  }

  /** 注册流式事件预设（第 5 章） */
  setStreamPreset(events: StreamEvent[]): void {
    this.streamPresets.push({ events });
  }

  /**
   * 同步 complete（ch04 back-compat）。
   * 第 3-4 章的测试继续使用此方法。
   */
  complete(
    _transcript: Transcript,
    _tools: Record<string, unknown>[],
  ): ProviderResponse {
    if (this.index >= this.responses.length) {
      throw new Error("mock ran out of responses");
    }
    return this.responses[this.index++];
  }

  /**
   * 流式生成（第 5 章）。
   * 依次 yield 预设的 StreamEvent 序列，然后 fallback 到 complete() 的逻辑。
   */
  async *astream(
    _transcript: Transcript,
    _tools: Record<string, unknown>[],
  ): AsyncGenerator<StreamEvent> {
    // 如果有流式预设，按预设 yield
    if (this.index < this.streamPresets.length) {
      const preset = this.streamPresets[this.index];
      this.index++;
      for (const event of preset.events) {
        yield event;
        // 模拟真实流的微小延迟
        await Promise.resolve();
      }
      return;
    }

    // 没有流式预设时，从预设 responses 构建流式事件
    if (this.index >= this.responses.length) {
      throw new Error("mock ran out of responses");
    }
    const response = this.responses[this.index++];

    // 如果是工具调用，yield ToolCallStart + ToolCallDelta + Completed
    if (response.isToolCall) {
      for (const ref of response.toolCalls) {
        yield toolCallStart(ref.id, ref.name);
        yield toolCallDelta(ref.id, JSON.stringify(ref.args));
      }
      yield completed(response.inputTokens, response.outputTokens, response.reasoningTokens);
      return;
    }

    // 文本响应：yield TextDelta + Completed
    if (response.text) {
      yield textDelta(response.text);
    }
    yield completed(response.inputTokens, response.outputTokens, response.reasoningTokens);
  }

  /** 重置索引（测试用） */
  reset(): void {
    this.index = 0;
  }
}
