/**
 * Plan 工具（第 16 章）
 *
 * 4 个工具让 agent 操作 Plan：
 *   - plan_create — 创建/替换 plan
 *   - plan_show — 显示当前 plan 状态
 *   - step_update — 更新 step 状态（done 必须带 evidence）
 *   - postcondition_verify — 验证 postcondition（必须带 evidence）
 */
import type { ToolDefinition, ToolHandler } from "../tools/registry.js";
import { Plan, createStep, createPostcondition, StepStatus } from "./model.js";

/* ─── PlanHolder ─────────────────────────────────────────────────── */

/**
 * 包装可变 Plan 的引用。
 * 工具通过这个共享引用来修改 plan 状态。
 */
export class PlanHolder {
  plan: Plan | null = null;

  /** 获取当前 plan，不存在则抛错 */
  require(): Plan {
    if (!this.plan) {
      throw new Error("no active plan");
    }
    return this.plan;
  }
}

/* ─── Plan 工具工厂 ─────────────────────────────────────────────── */

/**
 * 创建 4 个 plan 操作工具。
 * 返回 [ToolDefinition, ToolHandler][] 数组。
 */
export function createPlanTools(holder: PlanHolder): Array<[ToolDefinition, ToolHandler]> {
  /* ─── plan_create ──────────────────────────────────────────── */

  const createDef: ToolDefinition = {
    name: "plan_create",
    description:
      "Create or replace the plan for this session. " +
      "objective: one-sentence description of what you want to accomplish. " +
      "steps: ordered list of actionable step descriptions. " +
      "postconditions: conditions that must be true when the task is done. " +
      "Call this once at the start of any non-trivial task, before beginning work. " +
      "If the plan is wrong mid-task, call this again to replace it.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "One-sentence objective" },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of actionable step descriptions",
        },
        postconditions: {
          type: "array",
          items: { type: "string" },
          description: "Conditions that must be true when done",
        },
      },
      required: ["objective", "steps", "postconditions"],
    },
  };

  const createHandler: ToolHandler = (args) => {
    const objective = String(args.objective ?? "");
    const steps = (args.steps as string[]) ?? [];
    const postconditions = (args.postconditions as string[]) ?? [];

    if (!objective.trim()) return "error: objective is required";
    if (steps.length === 0) return "error: at least one step is required";
    if (postconditions.length === 0) return "error: at least one postcondition is required";

    holder.plan = new Plan(
      objective,
      steps.map((d) => createStep(d)),
      postconditions.map((d) => createPostcondition(d)),
    );

    return `plan created with ${steps.length} steps and ${postconditions.length} postconditions`;
  };

  /* ─── plan_show ────────────────────────────────────────────── */

  const showDef: ToolDefinition = {
    name: "plan_show",
    description:
      "Display the current plan with status. " +
      "Shows steps with [ ] [.] [x] [!] markers and evidence. " +
      "Shows postconditions with [ ] [x] markers. " +
      "Call this after a long tool sequence or compaction to re-orient yourself.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  };

  const showHandler: ToolHandler = (_args) => {
    try {
      return holder.require().toRender();
    } catch {
      return "no active plan";
    }
  };

  /* ─── step_update ──────────────────────────────────────────── */

  const stepDef: ToolDefinition = {
    name: "step_update",
    description:
      "Update a step's status. " +
      "step_number: 1-based step index. " +
      'status: one of "pending", "in_progress", "done", "blocked". ' +
      "evidence: required for 'done'. One sentence proving completion. " +
      "notes: optional additional context.",
    inputSchema: {
      type: "object",
      properties: {
        step_number: { type: "number", description: "1-based step index" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "done", "blocked"],
          description: "New status",
        },
        evidence: { type: "string", description: "Evidence for 'done' (required)" },
        notes: { type: "string", description: "Optional notes" },
      },
      required: ["step_number", "status"],
    },
  };

  const stepHandler: ToolHandler = (args) => {
    const plan = holder.plan;
    if (!plan) return "error: no active plan";

    const stepNum = Number(args.step_number);
    if (!Number.isFinite(stepNum) || stepNum < 1 || stepNum > plan.steps.length) {
      return `error: step_number ${stepNum} out of range (1..${plan.steps.length})`;
    }

    const statusStr = String(args.status ?? "");
    const statusMap: Record<string, StepStatus> = {
      pending: StepStatus.Pending,
      in_progress: StepStatus.InProgress,
      done: StepStatus.Done,
      blocked: StepStatus.Blocked,
    };
    const newStatus = statusMap[statusStr];
    if (!newStatus) {
      return `error: invalid status '${statusStr}'; use pending/in_progress/done/blocked`;
    }

    if (newStatus === StepStatus.Done && !args.evidence) {
      return "error: marking a step 'done' requires evidence. Describe what proved the step complete.";
    }

    const idx = stepNum - 1;
    const old = plan.steps[idx];
    plan.steps[idx] = {
      id: old.id,
      description: old.description,
      status: newStatus,
      evidence: args.evidence ? String(args.evidence) : undefined,
      notes: args.notes ? String(args.notes) : undefined,
    };

    return `step ${stepNum} → ${statusStr}`;
  };

  /* ─── postcondition_verify ─────────────────────────────────── */

  const pcDef: ToolDefinition = {
    name: "postcondition_verify",
    description:
      "Mark a postcondition as verified. " +
      "postcondition_number: 1-based index. " +
      "evidence: required. Concrete proof the postcondition holds. " +
      "This is what the harness checks before letting you declare the task complete.",
    inputSchema: {
      type: "object",
      properties: {
        postcondition_number: { type: "number", description: "1-based index" },
        evidence: { type: "string", description: "Proof the postcondition holds (required)" },
      },
      required: ["postcondition_number", "evidence"],
    },
  };

  const pcHandler: ToolHandler = (args) => {
    const plan = holder.plan;
    if (!plan) return "error: no active plan";

    const pcNum = Number(args.postcondition_number);
    if (!Number.isFinite(pcNum) || pcNum < 1 || pcNum > plan.postconditions.length) {
      return `error: postcondition_number out of range`;
    }

    if (!args.evidence || String(args.evidence).trim() === "") {
      return "error: evidence is required to verify a postcondition";
    }

    const idx = pcNum - 1;
    plan.postconditions[idx] = {
      ...plan.postconditions[idx],
      satisfied: true,
      evidence: String(args.evidence),
    };

    return `postcondition ${pcNum} verified`;
  };

  return [
    [createDef, createHandler],
    [showDef, showHandler],
    [stepDef, stepHandler],
    [pcDef, pcHandler],
  ];
}
