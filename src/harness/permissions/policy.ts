/**
 * 权限策略函数（第 14 章）
 *
 * 策略是 PermissionRequest → PermissionOutcome 的函数。
 * 3 个原子策略 + 1 个组合子。
 */
import * as path from "node:path";
import type { Decision, PermissionRequest, PermissionOutcome } from "./model.js";

/* ─── Policy 类型 ────────────────────────────────────────────────── */

export type Policy = (req: PermissionRequest) => PermissionOutcome;

/* ─── 原子策略 ────────────────────────────────────────────────── */

/** 全部允许 */
export function allowAll(): Policy {
  return () => ({ decision: "allow", reason: "allow-all policy" });
}

/** 全部拒绝 */
export function denyAll(): Policy {
  return () => ({ decision: "deny", reason: "deny-all policy" });
}

/**
 * 根据工具声明的 side effects 决定权限。
 * 最严格的决策赢：deny > ask > allow
 *
 * @param read    只读操作（默认 allow）
 * @param write   文件写入（默认 ask）
 * @param network 网络访问（默认 ask）
 * @param mutate  状态变更（默认 deny）
 */
export function bySideEffect(
  read: Decision = "allow",
  write: Decision = "ask",
  network: Decision = "ask",
  mutate: Decision = "deny",
): Policy {
  const precedence: Record<Decision, number> = { deny: 0, ask: 1, allow: 2 };

  return (req: PermissionRequest): PermissionOutcome => {
    const decisions: Array<{ decision: Decision; label: string }> = [];

    // 注意：决策按标签匹配，但 permission_request 的 sideEffects 是字符串数组
    for (const se of req.sideEffects) {
      if (se === "read") decisions.push({ decision: read, label: "read" });
      if (se === "write") decisions.push({ decision: write, label: "write" });
      if (se === "network") decisions.push({ decision: network, label: "network" });
      if (se === "mutate") decisions.push({ decision: mutate, label: "mutate" });
    }

    if (decisions.length === 0) {
      return { decision: "allow", reason: "no declared side effects" };
    }

    // 最严格赢
    const winner = decisions.reduce((a, b) =>
      precedence[a.decision] <= precedence[b.decision] ? a : b,
    );

    return {
      decision: winner.decision,
      reason: `${winner.label} side effect → ${winner.decision}`,
    };
  };
}

/**
 * 文件系统路径白名单。
 * 只对 read_file_viewport, edit_lines, read_file, write_file 生效。
 * 路径先 resolve() 再检查，防止 path traversal。
 *
 * @param allowedDirs - 允许的目录列表
 */
export function pathAllowlist(allowedDirs: string[]): Policy {
  const allowed = allowedDirs.map((d) => path.resolve(d));
  const fsTools = new Set(["read_file_viewport", "edit_lines", "read_file", "write_file"]);

  return (req: PermissionRequest): PermissionOutcome => {
    if (!fsTools.has(req.toolName)) {
      return { decision: "allow", reason: "not a filesystem tool" };
    }

    const pathArg = req.args["path"];
    if (!pathArg || typeof pathArg !== "string") {
      return { decision: "deny", reason: "no path argument" };
    }

    let target: string;
    try {
      target = path.resolve(pathArg);
    } catch {
      return { decision: "deny", reason: `bad path: ${pathArg}` };
    }

    for (const root of allowed) {
      if (target === root || target.startsWith(root + path.sep) || target.startsWith(root + "/")) {
        return { decision: "allow", reason: `path under ${root}` };
      }
    }

    return {
      decision: "deny",
      reason: `path ${target} not under any of: [${allowed.join(", ")}]`,
    };
  };
}

/* ─── 组合子 ────────────────────────────────────────────────────── */

/**
 * 组合多个策略。Left-to-right，第一个非 allow 赢。
 * 全部 allow 则最终 allow。
 */
export function compose(...policies: Policy[]): Policy {
  return (req: PermissionRequest): PermissionOutcome => {
    for (const p of policies) {
      const outcome = p(req);
      if (outcome.decision !== "allow") {
        return outcome;
      }
    }
    return { decision: "allow", reason: "all policies allowed" };
  };
}
