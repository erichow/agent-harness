/**
 * Plan 数据模型（第 16 章：结构化计划与完成验证）
 *
 * 基于 Kambhampati 2024 "LLM-Modulo" 框架：
 * 模型不能 self-certify 完成，harness 是外部 verifier。
 *
 * Plan 是一个 harness 强制的结构化对象：
 *   - Step 必须带 evidence 才能 mark done
 *   - Plan 必须所有 postcondition satisfied 才能 declare final
 *   - Harness 在 final 之前检查，model 不能自证
 */
import { randomUUID } from "node:crypto";

/* ─── StepStatus ─────────────────────────────────────────────────── */

export enum StepStatus {
  Pending = "pending",
  InProgress = "in_progress",
  Done = "done",
  Blocked = "blocked",
}

/* ─── Step ───────────────────────────────────────────────────────── */

export interface Step {
  id: string;
  description: string;
  status: StepStatus;
  /** 什么证明了 step 完成（done 时必须非空） */
  evidence?: string;
  notes?: string;
}

/** 创建一个新的 Step */
export function createStep(description: string, id?: string): Step {
  return {
    id: id ?? `s${randomUUID().slice(0, 8)}`,
    description,
    status: StepStatus.Pending,
  };
}

/** Step 是否处于终态（done 或 blocked） */
export function isStepTerminal(step: Step): boolean {
  return step.status === StepStatus.Done || step.status === StepStatus.Blocked;
}

/* ─── Postcondition ──────────────────────────────────────────────── */

export interface Postcondition {
  description: string;
  satisfied: boolean;
  evidence?: string;
}

/** 创建一个新的 Postcondition */
export function createPostcondition(description: string): Postcondition {
  return { description, satisfied: false };
}

/* ─── Plan ───────────────────────────────────────────────────────── */

export class Plan {
  readonly id: string;
  readonly objective: string;
  readonly steps: Step[];
  readonly postconditions: Postcondition[];
  readonly createdAt: Date;

  constructor(
    objective: string,
    steps: Step[],
    postconditions: Postcondition[],
    id?: string,
  ) {
    this.id = id ?? `plan_${randomUUID().slice(0, 8)}`;
    this.objective = objective;
    this.steps = steps;
    this.postconditions = postconditions;
    this.createdAt = new Date();
  }

  /** 所有 step 是否都在终态 */
  allStepsTerminal(): boolean {
    return this.steps.length > 0 && this.steps.every(isStepTerminal);
  }

  /** 所有 postcondition 是否都 satisfied */
  allPostconditionsSatisfied(): boolean {
    return this.postconditions.length > 0 && this.postconditions.every((pc) => pc.satisfied);
  }

  /** Plan 是否满足 finalize 条件 */
  isReadyToFinalize(): boolean {
    return this.allStepsTerminal() && this.allPostconditionsSatisfied();
  }

  /** 渲染为模型可读的字符串 */
  toRender(): string {
    const lines: string[] = [`# Plan: ${this.objective}\n`];

    lines.push("## Steps");
    for (let i = 0; i < this.steps.length; i++) {
      const s = this.steps[i];
      const mark: Record<string, string> = {
        pending: "[ ]",
        in_progress: "[.]",
        done: "[x]",
        blocked: "[!]",
      };
      lines.push(`${i + 1}. ${mark[s.status] || "[ ]"} ${s.description}`);
      if (s.evidence) lines.push(`   evidence: ${s.evidence}`);
      if (s.notes) lines.push(`   notes: ${s.notes}`);
    }

    lines.push("\n## Postconditions");
    for (let i = 0; i < this.postconditions.length; i++) {
      const pc = this.postconditions[i];
      const mark = pc.satisfied ? "[x]" : "[ ]";
      lines.push(`${i + 1}. ${mark} ${pc.description}`);
      if (pc.evidence) lines.push(`   evidence: ${pc.evidence}`);
    }

    return lines.join("\n");
  }
}
