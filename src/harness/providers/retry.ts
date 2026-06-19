/**
 * retry — 指数退避 + jitter（第 5 章）
 *
 * 解决的问题：瞬时网络故障不该是致命错误。
 * 指数退避 + 随机 jitter 防止 thundering-herd。
 *
 * 设计来源：Marc Brooker 2015 AWS 博客
 * "Exponential Backoff And Jitter"
 */

/* ─── 可重试错误判断 ────────────────────────────────────────────── */

/**
 * 根据 HTTP 状态码判断是否应该重试。
 *
 * 重试策略：
 *   - 429 Too Many Requests — 限流，必须重试
 *   - 5xx Server Error — 临时故障，应该重试
 *   - 4xx Client Error（非 429）— 客户端问题，不重试
 *   - 网络错误（fetch 抛异常）— 应该重试
 */
export function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object") {
    // HTTP 状态码
    if ("status" in err && typeof (err as { status: unknown }).status === "number") {
      const status = (err as { status: number }).status;
      return status === 429 || status >= 500;
    }
    // 网络错误（fetch 超时、DNS 失败等）
    if (err instanceof TypeError && "message" in err) {
      return true;
    }
  }
  return false;
}

/* ─── 退避计算 ──────────────────────────────────────────────────── */

/**
 * 计算第 attempt 次重试的退避延迟（毫秒）。
 *
 * 公式：
 *   baseDelay * 2^attempt + jitter
 *
 * 其中 jitter 是 [0, baseDelay * 2^attempt] 范围的随机值，
 * 把重试摊到恢复窗口里。
 *
 * @param attempt - 当前重试次数（从 0 开始）
 * @param maxMs   - 最大延迟上限（默认 30_000ms = 30 秒）
 * @returns 等待毫秒数
 */
export function backoffDelay(attempt: number, maxMs = 30_000): number {
  const base = 1_000; // 1 秒
  const exponential = Math.min(base * Math.pow(2, attempt), maxMs);
  const jitter = Math.random() * exponential;
  return Math.min(exponential + jitter, maxMs);
}

/* ─── withRetry ──────────────────────────────────────────────────── */

export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 最大延迟上限（默认 30_000ms） */
  maxDelayMs?: number;
  /** 每次重试前的回调（调试用） */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * 用指数退避 + jitter 包裹一个异步操作。
 *
 * @param fn      - 要重试的异步函数
 * @param options - 重试配置
 * @returns fn 的返回值
 * @throws 所有重试都用完后抛出最后一次的错误
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => fetch("https://api.example.com/data"),
 *   { maxRetries: 3, onRetry: (n, ms, err) => console.warn(`retry ${n} in ${ms}ms`, err) },
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxRetries = 3, maxDelayMs = 30_000, onRetry } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err; // 最后一次或不可重试，直接抛
      }

      const delay = backoffDelay(attempt, maxDelayMs);
      if (onRetry) onRetry(attempt + 1, delay, err);

      await sleep(delay);
    }
  }

  throw lastError;
}

/* ─── 工具 ───────────────────────────────────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
