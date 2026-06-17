/**
 * MockProvider — 脚本化的假 Provider，用于教学和测试
 *
 * 离线、确定性、零成本。按固定顺序逐条返回预设的响应。
 */
import type { Provider, ProviderResponse } from "./base.js";

export class MockProvider implements Provider {
  private responses: ProviderResponse[];
  private index: number;

  constructor(responses: ProviderResponse[]) {
    this.responses = [...responses];
    this.index = 0;
  }

  complete(
    _transcript: Record<string, unknown>[],
    _tools: Record<string, unknown>[],
  ): ProviderResponse {
    if (this.index >= this.responses.length) {
      throw new Error("mock ran out of responses");
    }
    const response = this.responses[this.index];
    this.index++;
    return response;
  }
}
