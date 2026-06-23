/**
 * cost/enforcer.ts — 第 20 章：BudgetEnforcer
 *
 * 三件里最难的一件。一个跑飞的 loop 在内层生成成本，不是 turn 边界。
 * 在 turn 起点的 enforcement 检查不能停掉正在跑的 turn。
 *
 * 能 work 的模式：attach AbortController，让 halt() 同时 throw + abort。
 *   - throw：停掉本 session 的栈
 *   - abort()：把信号传到 Promise.all 的 sibling
 */

/* ─── BudgetExceeded ─────────────────────────────────────────────── */

export class BudgetExceeded extends Error {
  constructor(
    message: string,
    public readonly spentUsd: number,
    public readonly maxUsd: number,
  ) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

/* ─── BudgetEnforcer ─────────────────────────────────────────────── */

export class BudgetEnforcer {
  /** 当前已花费（USD） */
  spentUsd = 0;

  private _abortController?: AbortController;
  private _alerted = new Set<number>();

  /**
   * @param maxUsd          — 硬性 session 上限（USD）
   * @param alertThresholds — 告警阈值百分比（默认 50%、80%）
   * @param prices          — 价格表（model name → [input_rate, output_rate] per 1M tokens）
   */
  constructor(
    public readonly maxUsd: number,
    public readonly alertThresholds: number[] = [0.5, 0.8],
    private readonly prices: Record<string, [number, number]> = {
      "claude-sonnet-4-6": [3.0, 15.0],
      "claude-opus-4-6": [5.0, 25.0],
      "claude-haiku": [0.8, 4.0],
      "gpt-5": [1.25, 10.0],
      "gpt-5.2": [1.75, 14.0],
      "local": [0.0, 0.0],
      "stub": [0.0, 0.0],
    },
  ) {}

  /** 绑定 AbortController——halt() 时 cancel 主任务 */
  attachAbortController(ac: AbortController): void {
    this._abortController = ac;
  }

  /**
   * 每次 LLM 调用后记录成本。
   * 超限时 throw BudgetExceeded + abort() 传播信号。
   */
  record(inputTokens: number, outputTokens: number, model: string): void {
    const cost = this._calculatePrice(model, inputTokens, outputTokens);
    this.spentUsd += cost;

    // 告警阈值检查
    for (const threshold of this.alertThresholds) {
      if (this._alerted.has(threshold)) continue;
      if (this.spentUsd / this.maxUsd >= threshold) {
        this._alerted.add(threshold);
        console.warn(
          `[BUDGET] $${this.spentUsd.toFixed(2)} / $${this.maxUsd.toFixed(2)} ` +
          `(${(threshold * 100).toFixed(0)}% reached)`,
        );
      }
    }

    // 预算超限——halt
    if (this.spentUsd >= this.maxUsd) {
      this._halt();
    }
  }

  /**
   * 检查是否已超限（用于 arun 循环中的 turn 边界检查）。
   * 不 throw——只告诉调用方"该停掉了"。
   */
  isExceeded(): boolean {
    return this.spentUsd >= this.maxUsd;
  }

  /** 剩余预算 */
  remainingUsd(): number {
    return Math.max(0, this.maxUsd - this.spentUsd);
  }

  /* ─── 内部方法 ─────────────────────────────────────────────────── */

  private _halt(): never {
    if (this._abortController && !this._abortController.signal.aborted) {
      this._abortController.abort();
    }
    throw new BudgetExceeded(
      `session budget $${this.maxUsd.toFixed(2)} exceeded: $${this.spentUsd.toFixed(2)}`,
      this.spentUsd,
      this.maxUsd,
    );
  }

  private _calculatePrice(
    model: string,
    inToks: number,
    outToks: number,
  ): number {
    // 未知 model fallback：Opus tier——刻意安全选择，高报好过低报
    const [inRate, outRate] = this.prices[model] ?? [5.0, 25.0];
    return (inToks * inRate + outToks * outRate) / 1_000_000;
  }
}
