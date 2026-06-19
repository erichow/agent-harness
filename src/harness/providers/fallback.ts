/**
 * FallbackProvider — 透明的主备降级（第 5 章）
 *
 * 解决的问题：一个 provider 挂了，整个 agent 就停了。
 *
 * FallbackProvider 是一个透明的组合层——它实现 Provider 接口，
 * 优先调用 primary，仅当 primary 抛出某些状态码时才切换到 fallback。
 * loop 不知道也不关心自己调用的是一个复合 provider。
 */
import type { Transcript } from "../messages.js";
import { ProviderResponse } from "./base.js";
import type { Provider } from "./base.js";
import type { StreamEvent } from "./events.js";

export class FallbackProvider implements Provider {
  name = "fallback";

  constructor(
    /** 主 provider */
    readonly primary: Provider,
    /** 备 provider */
    readonly fallback: Provider,
    /** 触发降级的状态码（默认 429, 502, 503, 504） */
    readonly fallbackOnStatus: number[] = [429, 502, 503, 504],
  ) {
    this.name = `fallback(${primary.name}→${fallback.name})`;
  }

  /**
   * 同步 complete — 先试 primary，失败后按状态码降级到 fallback。
   */
  complete(
    transcript: Transcript,
    tools: Record<string, unknown>[],
  ): ProviderResponse {
    try {
      return this.primary.complete(transcript, tools);
    } catch (err) {
      if (this.fallback && this.shouldFallback(err)) {
        return this.fallback.complete(transcript, tools);
      }
      throw err;
    }
  }

  /**
   * 异步流式 — 先试 primary 的 astream，失败后降级到 fallback。
   */
  async *astream(
    transcript: Transcript,
    tools: Record<string, unknown>[],
  ): AsyncGenerator<StreamEvent> {
    try {
      yield* this.primary.astream(transcript, tools);
    } catch (err) {
      if (this.fallback && this.shouldFallback(err)) {
        yield* this.fallback.astream(transcript, tools);
      } else {
        throw err;
      }
    }
  }

  private shouldFallback(err: unknown): boolean {
    if (err && typeof err === "object" && "status" in err) {
      const status = (err as { status: number }).status;
      return this.fallbackOnStatus.includes(status);
    }
    return false;
  }
}
