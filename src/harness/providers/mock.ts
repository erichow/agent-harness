/**
 * MockProvider — 脚本化的假 Provider，用于教学和测试
 *
 * 第 3 章：用新 ProviderResponse 形状（无 kind 字段）
 *
 * 离线、确定性、零成本。按固定顺序逐条返回预设的响应。
 */
import type { Transcript } from "../messages.js";
import { ProviderResponse } from "./base.js";
import type { Provider } from "./base.js";

export class MockProvider implements Provider {
  name = "mock";

  private responses: ProviderResponse[];
  private index: number;

  constructor(responses: ProviderResponse[]) {
    this.responses = [...responses];
    this.index = 0;
  }

  complete(
    _transcript: Transcript,
    _tools: Record<string, unknown>[],
  ): ProviderResponse {
    if (this.index >= this.responses.length) {
      throw new Error("mock ran out of responses");
    }
    return this.responses[this.index++];
  }
}
