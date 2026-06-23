/**
 * evals/case.ts — 第 19 章：评测数据类型
 *
 * EvalCase 定义一次评测：输入 + 约束 + 验证逻辑。
 * EvalResult 记录一次评测执行的结果。
 */

/* ─── EvalCase ────────────────────────────────────────────────────── */

/**
 * 单条黄金轨迹测试。
 *
 * 设计原则：故意简单。生产 eval 框架（Braintrust、LangSmith）
 * 有更丰富结构——scorer 函数、数据集版本化、实验追踪。
 * 本书不复制那些；接口留余地集成它们。
 */
export interface EvalCase {
  /** 唯一标识 */
  id: string;

  /** 人类可读描述 */
  description: string;

  /** 用户输入 */
  userMessage: string;

  /** 可选系统 prompt */
  system?: string;

  /** 必须被调的工具（任意顺序） */
  requiredTools?: string[];

  /** 禁止调用的工具 */
  forbiddenTools?: string[];

  /** 答案验证函数——确定性检查 */
  checkAnswer?: (answer: string) => boolean;

  /** total tokens 上限 */
  maxTokens?: number;

  /** iterations 上限 */
  maxIterations?: number;
}

/* ─── EvalResult ──────────────────────────────────────────────────── */

export interface EvalResult {
  caseId: string;
  passed: boolean;
  failures: string[];
  finalAnswer: string;
  tokensUsed: number;
  iterationsUsed: number;
  durationMs: number;
}

/* ─── StabilityReport ────────────────────────────────────────────── */

export interface StabilityReport {
  caseId: string;
  passRate: string;       // "7/10"
  perRun: string[];       // ["✓","✗","✓",...]
  avgTokens: number;
  avgDuration: number;
}
