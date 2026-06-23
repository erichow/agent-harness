/**
 * evals/judge.ts — 第 19 章：LLM-as-Judge
 *
 * 对 checkAnswer 是主观的任务（"总结这文章"），
 * 用另一个 LLM 当 judge。
 */

import type { Provider } from "../providers/base.js";
import { Transcript, Message } from "../messages.js";

export interface JudgeOptions {
  /** 评判标准，如 "accuracy, completeness, relevance" */
  criteria?: string;

  /** 可选的参考答案 */
  referenceAnswer?: string;
}

/**
 * 用 LLM 评判候选答案。
 *
 * @param judgeProvider — 用于评判的 provider（建议与被测不同 provider 避免 judge bias）
 * @param question      — 原始问题
 * @param candidateAnswer — 被测 agent 的回答
 * @param options       — 可选参数
 * @returns PASS 或 FAIL
 *
 * **Caveats：**
 * 1. Judge bias：同 provider judge 自己的输出会有共同盲点——最佳实践用不同 provider
 * 2. Judge ceiling：judge 不能可靠超出它在底层任务上的能力上限
 */
export async function judge(
  judgeProvider: Provider,
  question: string,
  candidateAnswer: string,
  options: JudgeOptions = {},
): Promise<boolean> {
  const transcript = new Transcript(
    "You are a strict evaluator. Given a question and a candidate answer, " +
    "judge whether the answer is correct by the criteria provided. " +
    "Reply with only 'PASS' or 'FAIL' followed by a one-sentence reason.",
  );

  let user = `Question: ${question}\n\nCandidate answer: ${candidateAnswer}\n\n`;

  if (options.referenceAnswer) {
    user += `Reference answer for comparison: ${options.referenceAnswer}\n\n`;
  }

  user += `Criteria: ${options.criteria ?? "accuracy, completeness, relevance"}`;

  transcript.append(Message.userText(user));

  const response = await judgeProvider.complete(transcript, []);
  const text = response.text ?? "";
  return text.trim().toUpperCase().startsWith("PASS");
}
