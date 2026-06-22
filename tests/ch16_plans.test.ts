/**
 * 第 16 章测试 — 结构化计划与完成验证
 *
 * 覆盖：
 *   1. Plan 数据模型 — 创建、状态、渲染
 *   2. Step 状态机 — pending → in_progress → done
 *   3. isReadyToFinalize — 所有 step terminal + postcondition satisfied
 *   4. Plan 工具 — plan_create, plan_show, step_update, postcondition_verify
 *   5. Evidence 要求 — done 必须有非空 evidence
 *   6. step_number 边界检查
 *   7. 通过 registry 集成
 *   8. PlanHolder require 错误
 */
import { describe, it, expect } from "vitest";
import { Plan, createStep, createPostcondition, StepStatus, isStepTerminal } from "../src/harness/plans/model.js";
import type { Step, Postcondition } from "../src/harness/plans/model.js";
import { PlanHolder, createPlanTools } from "../src/harness/plans/tools.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

/* ─── Plan 数据模型 ──────────────────────────────────────────────── */

describe("Plan data model", () => {
  it("creates a plan with steps and postconditions", () => {
    const steps = [
      createStep("Read config file"),
      createStep("Find error pattern"),
    ];
    const pcs = [
      createPostcondition("Config file contents reported"),
      createPostcondition("Error pattern identified"),
    ];

    const plan = new Plan("Debug config", steps, pcs);

    expect(plan.objective).toBe("Debug config");
    expect(plan.steps).toHaveLength(2);
    expect(plan.postconditions).toHaveLength(2);
    expect(plan.id).toMatch(/^plan_/);
    expect(plan.createdAt).toBeInstanceOf(Date);
  });

  it("starts with all steps pending", () => {
    const plan = new Plan("Test", [createStep("Step 1"), createStep("Step 2")], [createPostcondition("Done")]);

    for (const step of plan.steps) {
      expect(step.status).toBe(StepStatus.Pending);
    }
  });

  it("isStepTerminal returns true for done and blocked", () => {
    expect(isStepTerminal({ id: "1", description: "x", status: StepStatus.Done })).toBe(true);
    expect(isStepTerminal({ id: "2", description: "x", status: StepStatus.Blocked })).toBe(true);
    expect(isStepTerminal({ id: "3", description: "x", status: StepStatus.Pending })).toBe(false);
    expect(isStepTerminal({ id: "4", description: "x", status: StepStatus.InProgress })).toBe(false);
  });

  it("allStepsTerminal returns true only when all are done or blocked", () => {
    const plan = new Plan("Test", [createStep("S1"), createStep("S2")], [createPostcondition("PC")]);
    expect(plan.allStepsTerminal()).toBe(false);

    plan.steps[0].status = StepStatus.Done;
    expect(plan.allStepsTerminal()).toBe(false);

    plan.steps[1].status = StepStatus.Blocked;
    expect(plan.allStepsTerminal()).toBe(true);
  });

  it("allPostconditionsSatisfied returns true only when all satisfied", () => {
    const plan = new Plan("Test", [createStep("S1")], [
      createPostcondition("PC1"),
      createPostcondition("PC2"),
    ]);
    expect(plan.allPostconditionsSatisfied()).toBe(false);

    plan.postconditions[0].satisfied = true;
    expect(plan.allPostconditionsSatisfied()).toBe(false);

    plan.postconditions[1].satisfied = true;
    expect(plan.allPostconditionsSatisfied()).toBe(true);
  });

  it("isReadyToFinalize requires both allStepsTerminal and allPostconditionsSatisfied", () => {
    const plan = new Plan("Test", [createStep("S1")], [createPostcondition("PC")]);
    expect(plan.isReadyToFinalize()).toBe(false);

    plan.steps[0].status = StepStatus.Done;
    expect(plan.isReadyToFinalize()).toBe(false);

    plan.postconditions[0].satisfied = true;
    expect(plan.isReadyToFinalize()).toBe(true);
  });

  it("toRender produces human-readable output", () => {
    const plan = new Plan("Verify three files", [
      createStep("Check hostname"),
      createStep("Check os-release"),
    ], [
      createPostcondition("All files reported"),
    ]);

    const rendered = plan.toRender();
    expect(rendered).toContain("Plan: Verify three files");
    expect(rendered).toContain("[ ] Check hostname");
    expect(rendered).toContain("[ ] Check os-release");
    expect(rendered).toContain("[ ] All files reported");

    // Mark step1 done with evidence
    plan.steps[0].status = StepStatus.Done;
    plan.steps[0].evidence = "found /etc/hostname via bash";
    plan.postconditions[0].satisfied = true;
    plan.postconditions[0].evidence = "all three checked";

    const rendered2 = plan.toRender();
    expect(rendered2).toContain("[x] Check hostname");
    expect(rendered2).toContain("evidence: found /etc/hostname");
    expect(rendered2).toContain("[x] All files reported");
  });
});

/* ─── PlanHolder ─────────────────────────────────────────────────── */

describe("PlanHolder", () => {
  it("starts with null plan", () => {
    const holder = new PlanHolder();
    expect(holder.plan).toBeNull();
  });

  it("require throws when no plan", () => {
    const holder = new PlanHolder();
    expect(() => holder.require()).toThrow("no active plan");
  });

  it("require returns plan when set", () => {
    const holder = new PlanHolder();
    const plan = new Plan("Test", [createStep("S1")], [createPostcondition("PC")]);
    holder.plan = plan;
    expect(holder.require()).toBe(plan);
  });
});

/* ─── Plan 工具 ──────────────────────────────────────────────────── */

describe("Plan tools", () => {
  it("plan_create creates a plan", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);
    const [def, handler] = tools[0];

    expect(def.name).toBe("plan_create");

    const result = handler({
      objective: "Debug config",
      steps: ["Read file", "Find errors"],
      postconditions: ["File read", "Errors found"],
    });

    expect(result).toContain("2 steps");
    expect(result).toContain("2 postconditions");
    expect(holder.plan).not.toBeNull();
    expect(holder.plan!.steps).toHaveLength(2);
  });

  it("plan_create rejects empty objective", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);
    const result = tools[0][1]({ objective: "", steps: ["X"], postconditions: ["Y"] });
    expect(result).toContain("objective is required");
  });

  it("plan_show returns current plan", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);

    tools[0][1]({ objective: "Test", steps: ["S1"], postconditions: ["PC"] });
    const shown = tools[1][1]({});

    expect(shown).toContain("Plan: Test");
    expect(shown).toContain("[ ] S1");
  });

  it("plan_show returns 'no active plan' when null", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);
    expect(tools[1][1]({})).toBe("no active plan");
  });

  it("step_update changes step status", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);

    tools[0][1]({ objective: "X", steps: ["S1", "S2"], postconditions: ["PC"] });
    const result = tools[2][1]({ step_number: 1, status: "done", evidence: "completed" });

    expect(result).toContain("step 1 → done");
    expect(holder.plan!.steps[0].status).toBe(StepStatus.Done);
    expect(holder.plan!.steps[0].evidence).toBe("completed");
  });

  it("step_update requires evidence for done", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);

    tools[0][1]({ objective: "X", steps: ["S1"], postconditions: ["PC"] });
    const result = tools[2][1]({ step_number: 1, status: "done" });

    expect(result).toContain("requires evidence");
  });

  it("step_update rejects out of range", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);

    tools[0][1]({ objective: "X", steps: ["S1"], postconditions: ["PC"] });
    expect(tools[2][1]({ step_number: 5, status: "done", evidence: "x" })).toContain("out of range");
    expect(tools[2][1]({ step_number: 0, status: "done", evidence: "x" })).toContain("out of range");
  });

  it("postcondition_verify marks postcondition satisfied", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);

    tools[0][1]({ objective: "X", steps: ["S1"], postconditions: ["PC1", "PC2"] });
    const result = tools[3][1]({ postcondition_number: 1, evidence: "confirmed" });

    expect(result).toContain("postcondition 1 verified");
    expect(holder.plan!.postconditions[0].satisfied).toBe(true);
    expect(holder.plan!.postconditions[0].evidence).toBe("confirmed");
    expect(holder.plan!.postconditions[1].satisfied).toBe(false);
  });

  it("postcondition_verify requires evidence", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);

    tools[0][1]({ objective: "X", steps: ["S1"], postconditions: ["PC"] });
    const result = tools[3][1]({ postcondition_number: 1, evidence: "" });

    expect(result).toContain("evidence is required");
  });

  it("all 4 tools work through the registry", () => {
    const holder = new PlanHolder();
    const tools = createPlanTools(holder);
    const registry = new ToolRegistry();

    for (const [def, handler] of tools) {
      registry.register(def, handler);
    }

    // plan_create
    const createResult = registry.execute("plan_create", {
      objective: "Debug",
      steps: ["Read logs", "Fix bug"],
      postconditions: ["Bug fixed"],
    }, "call-1");
    expect(createResult.isError).toBe(false);

    // plan_show
    const showResult = registry.execute("plan_show", {}, "call-2");
    expect(showResult.isError).toBe(false);
    expect(showResult.content).toContain("Debug");

    // step_update
    registry.execute("step_update", { step_number: 1, status: "done", evidence: "read logs" }, "call-3");
    registry.execute("step_update", { step_number: 2, status: "done", evidence: "fixed" }, "call-4");

    // postcondition_verify
    registry.execute("postcondition_verify", { postcondition_number: 1, evidence: "all tests pass" }, "call-5");

    // Plan should now be ready to finalize
    expect(holder.plan!.isReadyToFinalize()).toBe(true);
  });
});

/* ─── Finalization edge cases ────────────────────────────────────── */

describe("Finalization edge cases", () => {
  it("empty plan is not ready", () => {
    const plan = new Plan("Empty", [], []);
    expect(plan.allStepsTerminal()).toBe(false);
    expect(plan.allPostconditionsSatisfied()).toBe(false);
    expect(plan.isReadyToFinalize()).toBe(false);
  });

  it("blocked step with reason counts as terminal", () => {
    const plan = new Plan("Test", [
      { id: "s1", description: "Do X", status: StepStatus.Done },
      { id: "s2", description: "Do Y", status: StepStatus.Blocked, notes: "depends on external API" },
    ], [createPostcondition("Done")]);
    plan.postconditions[0].satisfied = true;

    expect(plan.isReadyToFinalize()).toBe(true);
  });
});
