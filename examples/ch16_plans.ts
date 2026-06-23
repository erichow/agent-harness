/**
 * 第 16 章 Plans 示例 — 结构化计划与完成验证
 *
 * 对应设计文档「ch16-plans — 结构化计划与完成验证」
 *
 * 设计要点（LLM-Modulo 框架）：
 *   1. 模型提议 plan，harness 验证完成
 *   2. Step 必须带 evidence 才能 mark done
 *   3. Plan 必须所有 postcondition satisfied 才能 declare final
 *   4. 4 个工具：plan_create / plan_show / step_update / postcondition_verify
 *
 * 运行方式：
 *   npx tsx examples/ch16_plans.ts
 */

import { Plan, createStep, createPostcondition, StepStatus } from "../src/harness/plans/model.js";
import { PlanHolder, createPlanTools } from "../src/harness/plans/tools.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";

async function main() {
  console.log("━━━ ch16: 结构化计划 ━━━\n");

  // 1. Plan 数据模型
  console.log("─ 1. 创建 Plan ──────────────────────");
  const plan = new Plan(
    "实现用户登录功能",
    [
      createStep("创建 LoginForm 组件"),
      createStep("实现表单验证逻辑"),
      createStep("对接登录 API"),
      createStep("添加错误处理"),
    ],
    [
      createPostcondition("用户能输入邮箱和密码"),
      createPostcondition("表单验证通过后才能提交"),
      createPostcondition("登录失败时显示错误提示"),
      createPostcondition("登录成功后跳转到首页"),
    ],
  );
  console.log(`   Plan ID: ${plan.id}`);
  console.log(`   目标: ${plan.objective}`);
  console.log(`   步骤数: ${plan.steps.length}`);
  console.log(`   Postcondition 数: ${plan.postconditions.length}`);
  console.log();

  // 2. 状态机演示
  console.log("─ 2. Step 状态转换 ──────────────────");
  const s1 = plan.steps[0];
  console.log(`   初始: ${s1.description} → ${s1.status}`);

  s1.status = StepStatus.InProgress;
  console.log(`   → InProgress: ${s1.status}`);

  s1.status = StepStatus.Done;
  s1.evidence = "LoginForm.tsx 已创建，包含邮箱和密码输入框";
  console.log(`   → Done: evidence="${s1.evidence}"`);
  console.log(`   isStepTerminal: ${s1.status === StepStatus.Done}`);
  console.log();

  // 3. PlanHolder + createPlanTools — 通过 registry 操作
  console.log("─ 3. PlanHolder + 工具集成 ───────────");
  const holder = new PlanHolder();
  const registry = new ToolRegistry();
  for (const [def, handler] of createPlanTools(holder)) {
    registry.register(def, handler);
  }

  // plan_create
  const createResult = registry.execute(
    "plan_create",
    {
      objective: "修复登录页面样式问题",
      steps: [
        "定位样式文件",
        "修改 CSS 变量",
        "验证预览效果",
        "提交 PR",
      ],
      postconditions: [
        "登录按钮居中显示",
        "错误提示颜色正确",
        "移动端适配正常",
      ],
    },
    "call-1",
  );
  console.log(`   plan_create → ${createResult.content}`);
  console.log();

  // plan_show
  const showResult = registry.execute("plan_show", {}, "call-2");
  console.log(`   plan_show →`);
  console.log(`   ${(showResult.content as string).split("\n").slice(0, 6).join("\n   ")}`);
  console.log();

  // step_update — mark 第一个 step done
  const updateResult = registry.execute(
    "step_update",
    {
      step_number: 1,
      status: "done",
      evidence: "已完成样式文件定位和修改",
    },
    "call-3",
  );
  console.log(`   step_update → ${updateResult.content}`);
  console.log();

  // 4. Postcondition 验证
  console.log("─ 4. Postcondition 验证 ──────────────");
  plan.postconditions[0].satisfied = true;
  plan.postconditions[0].evidence = "登录按钮已居中";
  plan.postconditions[1].satisfied = false;
  console.log(`   postcondition[0]: "${plan.postconditions[0].description}" → ${plan.postconditions[0].satisfied}`);

  const allDone = plan.postconditions.every((p) => p.satisfied);
  console.log(`   所有 postcondition 满足? ${allDone}`);
  console.log(`   isReadyToFinalize? ${plan.allPostconditionsSatisfied() && plan.allStepsTerminal()}`);
  console.log();

  // 5. Plan 渲染
  console.log("─ 5. Plan 可视化 ────────────────────");
  const rendered = plan.toRender();
  console.log(`   ${rendered}`);

  console.log("━━━ ✅ Plans 示例完成 ━━━");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
