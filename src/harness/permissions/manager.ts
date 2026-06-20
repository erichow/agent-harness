/**
 * PermissionManager — 权限管理器（第 14 章）
 *
 * 集成策略 + 人 in loop 提示 + session 缓存。
 */
import type { Decision, PermissionRequest, PermissionOutcome, HumanPrompt } from "./model.js";
import type { Policy } from "./policy.js";

/**
 * 默认 CLI 提示函数（通过 stdout/stderr 交互）。
 * 生产部署应替换为更丰富的 UI。
 */
export const defaultCliPrompt: HumanPrompt = async (req: PermissionRequest): Promise<Decision> => {
  console.error(`\nPermission request:`);
  console.error(`  tool: ${req.toolName}`);
  console.error(`  args: ${JSON.stringify(req.args)}`);
  console.error(`  side effects: [${req.sideEffects.join(", ")}]`);

  // 在测试和无 tty 环境，默认 deny
  return "deny";
};

/**
 * 默认的人 in loop 提示：直接返回 "allow"。
 * 用于测试和非交互环境——生产请替换为真正的 human prompt。
 */
export const autoAllowPrompt: HumanPrompt = async () => "allow";

export class PermissionManager {
  readonly policy: Policy;
  readonly humanPrompt: HumanPrompt;
  private sessionApprovals: Set<string>;

  constructor(
    policy: Policy,
    humanPrompt: HumanPrompt = defaultCliPrompt,
  ) {
    this.policy = policy;
    this.humanPrompt = humanPrompt;
    this.sessionApprovals = new Set();
  }

  /**
   * 检查一次工具调用是否允许。
   *
   * 流程：
   *   1. session 缓存命中 → 直接 allow
   *   2. 跑策略
   *   3. ask → 升级给人
   *   4. 人批准 → 缓存到 session
   */
  async check(toolName: string, args: Record<string, unknown>, sideEffects: string[]): Promise<PermissionOutcome> {
    // 1. session 缓存
    const key = this._cacheKey(toolName, args);
    if (this.sessionApprovals.has(key)) {
      return { decision: "allow", reason: "previously approved this session" };
    }

    // 2. 跑策略
    const req: PermissionRequest = { toolName, args, sideEffects };
    const outcome = this.policy(req);

    // 3. ask → 升级给人
    if (outcome.decision === "ask") {
      const humanDecision = await this.humanPrompt(req);
      const result: PermissionOutcome = {
        decision: humanDecision,
        reason: `human said ${humanDecision}`,
        rememberForSession: humanDecision === "allow",
      };

      if (humanDecision === "allow") {
        this.sessionApprovals.add(key);
      }

      return result;
    }

    return outcome;
  }

  /** 生成缓存 key——精确的 (toolName, args) */
  private _cacheKey(toolName: string, args: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(args, Object.keys(args).sort())}`;
  }

  /** 清除 session 缓存 */
  clearCache(): void {
    this.sessionApprovals.clear();
  }
}
