/**
 * 第 14 章测试 — 权限系统 + Trust Label
 *
 * 覆盖：
 *   PermissionManager:
 *     1. allow/deny/ask 决策
 *     2. session 缓存
 *     3. human prompt 集成
 *
 *   策略函数:
 *     4. allowAll / denyAll
 *     5. bySideEffect — 严格决策优先级
 *     6. pathAllowlist — path traversal 防御
 *     7. compose — 左到右组合
 *
 *   Trust label:
 *     8. wrapIfUntrusted 包装 network 工具输出
 *     9. 非 network 工具不变
 *
 *   Registry 集成:
 *     10. executeAsync 拒绝权限不足的工具
 *     11. executeAsync trust label 包装
 */
import { describe, it, expect } from "vitest";
import { PermissionManager } from "../src/harness/permissions/manager.js";
import { allowAll, denyAll, bySideEffect, pathAllowlist, compose } from "../src/harness/permissions/policy.js";
import type { Policy } from "../src/harness/permissions/policy.js";
import { wrapIfUntrusted } from "../src/harness/permissions/trust.js";
import { ToolRegistry } from "../src/harness/tools/registry.js";
import type { AsyncToolHandler } from "../src/harness/tools/registry.js";

/* ─── PermissionManager ──────────────────────────────────────────── */

describe("PermissionManager", () => {
  it("allows when policy says allow", async () => {
    const pm = new PermissionManager(allowAll());
    const outcome = await pm.check("test_tool", {}, []);
    expect(outcome.decision).toBe("allow");
    expect(outcome.reason).toContain("allow-all");
  });

  it("denies when policy says deny", async () => {
    const pm = new PermissionManager(denyAll());
    const outcome = await pm.check("test_tool", {}, []);
    expect(outcome.decision).toBe("deny");
    expect(outcome.reason).toContain("deny-all");
  });

  it("ask upgrades to human decision (auto-allow)", async () => {
    // 使用 autoAllowPrompt（测试用）
    const { autoAllowPrompt } = await import("../src/harness/permissions/manager.js");
    const policy: Policy = () => ({ decision: "ask", reason: "test ask" });
    const pm = new PermissionManager(policy, autoAllowPrompt);

    const outcome = await pm.check("test_tool", {}, ["network"]);
    expect(outcome.decision).toBe("allow");
    expect(outcome.reason).toContain("human said allow");
  });

  it("caches session- level approvals", async () => {
    const { autoAllowPrompt } = await import("../src/harness/permissions/manager.js");
    let callCount = 0;
    const trackingPolicy: Policy = () => {
      callCount++;
      return { decision: "ask", reason: "needs approval" };
    };
    const pm = new PermissionManager(trackingPolicy, autoAllowPrompt);

    // 第一次调用：ask → human allow → 缓存
    await pm.check("tool_a", { x: "1" }, []);
    expect(callCount).toBe(1);

    // 第二次完全相同：缓存命中
    await pm.check("tool_a", { x: "1" }, []);
    expect(callCount).toBe(1); // 策略没再跑

    // 不同参数：不命中缓存
    await pm.check("tool_a", { x: "2" }, []);
    expect(callCount).toBe(2);
  });

  it("clearCache resets session approvals", async () => {
    const { autoAllowPrompt } = await import("../src/harness/permissions/manager.js");
    let callCount = 0;
    const trackingPolicy: Policy = () => {
      callCount++;
      return { decision: "ask", reason: "needs approval" };
    };
    const pm = new PermissionManager(trackingPolicy, autoAllowPrompt);

    await pm.check("tool_a", { x: "1" }, []);
    expect(callCount).toBe(1);

    pm.clearCache();

    // 清除缓存后重新检查策略
    await pm.check("tool_a", { x: "1" }, []);
    expect(callCount).toBe(2);
  });
});

/* ─── 策略函数 ────────────────────────────────────────────────── */

describe("policy functions", () => {
  it("allowAll allows everything", () => {
    const p = allowAll();
    expect(p({ toolName: "bash", args: {}, sideEffects: ["mutate"] }).decision).toBe("allow");
    expect(p({ toolName: "any", args: {}, sideEffects: [] }).decision).toBe("allow");
  });

  it("denyAll denies everything", () => {
    const p = denyAll();
    expect(p({ toolName: "calc", args: {}, sideEffects: [] }).decision).toBe("deny");
  });

  describe("bySideEffect", () => {
    it("allows read-only tools by default", () => {
      const p = bySideEffect();
      expect(p({ toolName: "read", args: {}, sideEffects: ["read"] }).decision).toBe("allow");
    });

    it("asks for write by default", () => {
      const p = bySideEffect();
      expect(p({ toolName: "write", args: {}, sideEffects: ["write"] }).decision).toBe("ask");
    });

    it("asks for network by default", () => {
      const p = bySideEffect();
      expect(p({ toolName: "http", args: {}, sideEffects: ["network"] }).decision).toBe("ask");
    });

    it("denies mutate by default", () => {
      const p = bySideEffect();
      expect(p({ toolName: "mutation", args: {}, sideEffects: ["mutate"] }).decision).toBe("deny");
    });

    it("uses strictest decision when multiple side effects", () => {
      const p = bySideEffect("allow", "ask", "deny", "deny");
      // deny (from network) wins over allow (from read)
      const result = p({
        toolName: "mcp_tool",
        args: {},
        sideEffects: ["read", "network"],
      });
      expect(result.decision).toBe("deny");
    });

    it("allows tools with no side effects", () => {
      const p = bySideEffect();
      expect(p({ toolName: "calc", args: {}, sideEffects: [] }).decision).toBe("allow");
    });
  });

  describe("pathAllowlist", () => {
    it("allows paths under allowed directory", () => {
      const p = pathAllowlist(["/workspace"]);
      const result = p({
        toolName: "read_file_viewport",
        args: { path: "/workspace/src/main.ts" },
        sideEffects: ["read"],
      });
      expect(result.decision).toBe("allow");
    });

    it("denies paths outside allowed directory", () => {
      const p = pathAllowlist(["/workspace"]);
      const result = p({
        toolName: "read_file_viewport",
        args: { path: "/etc/passwd" },
        sideEffects: ["read"],
      });
      expect(result.decision).toBe("deny");
    });

    it("resolves path traversal before checking", () => {
      const p = pathAllowlist(["/workspace"]);
      // /etc/../workspace/../workspace/src/main.ts → /workspace/src/main.ts
      const result = p({
        toolName: "read_file_viewport",
        args: { path: "/etc/../workspace/src/main.ts" },
        sideEffects: ["read"],
      });
      expect(result.decision).toBe("allow");
    });

    it("denies traversal attempts to /etc/passwd", () => {
      const p = pathAllowlist(["/workspace"]);
      const result = p({
        toolName: "read_file_viewport",
        args: { path: "/workspace/../../etc/passwd" },
        sideEffects: ["read"],
      });
      expect(result.decision).toBe("deny");
    });

    it("allows non-filesystem tools", () => {
      const p = pathAllowlist(["/workspace"]);
      const result = p({
        toolName: "calc",
        args: {},
        sideEffects: [],
      });
      expect(result.decision).toBe("allow");
    });

    it("denies when no path argument", () => {
      const p = pathAllowlist(["/workspace"]);
      const result = p({
        toolName: "read_file_viewport",
        args: {},
        sideEffects: ["read"],
      });
      expect(result.decision).toBe("deny");
    });
  });

  describe("compose", () => {
    it("left-to-right, first non-allow wins", () => {
      const denyCalc: Policy = (req) =>
        req.toolName === "calc"
          ? { decision: "deny", reason: "calc not allowed" }
          : { decision: "allow", reason: "" };

      const p = compose(allowAll(), denyCalc, denyAll());

      // denyCalc catches calc
      expect(p({ toolName: "calc", args: {}, sideEffects: [] }).decision).toBe("deny");

      // denyCalc doesn't catch read → denyAll does
      expect(p({ toolName: "read", args: {}, sideEffects: ["read"] }).decision).toBe("deny");
    });

    it("allows when all policies allow", () => {
      const p = compose(allowAll(), allowAll());
      expect(p({ toolName: "any", args: {}, sideEffects: [] }).decision).toBe("allow");
    });
  });
});

/* ─── Trust Label ────────────────────────────────────────────────── */

describe("wrapIfUntrusted", () => {
  it("wraps network tool output in untrusted_content", () => {
    const result = wrapIfUntrusted("fetch_url", ["network"], "page content");
    expect(result).toContain("<untrusted_content");
    expect(result).toContain("fetch_url");
    expect(result).toContain("page content");
    expect(result).toContain("</untrusted_content>");
  });

  it("does not wrap non-network tool output", () => {
    const result = wrapIfUntrusted("calc", ["read"], "42");
    expect(result).toBe("42");
    expect(result).not.toContain("untrusted_content");
  });

  it("wraps when tool has both read and network", () => {
    const result = wrapIfUntrusted("hybrid", ["read", "network"], "data");
    expect(result).toContain("<untrusted_content");
  });
});

/* ─── Registry 集成 ──────────────────────────────────────────────── */

describe("Registry permission integration", () => {
  it("executeAsync rejects permission denied tools", async () => {
    const registry = new ToolRegistry();
    registry.aregister(
      {
        name: "dangerous",
        description: "A dangerous tool",
        inputSchema: { type: "object", properties: {} },
      },
      async () => "should not run",
    );

    // 设置 deny-all 权限管理器
    const { autoAllowPrompt } = await import("../src/harness/permissions/manager.js");
    registry.permissionManager = new PermissionManager(denyAll(), autoAllowPrompt);

    const result = await registry.executeAsync("dangerous", {}, "call-1");

    expect(result.isError).toBe(true);
    expect(result.content).toContain("permission denied");
  });

  it("executeAsync allows permitted tools", async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "safe_tool",
        description: "A safe tool",
        inputSchema: { type: "object", properties: {} },
      },
      () => "safe result",
    );

    registry.permissionManager = new PermissionManager(allowAll());

    const result = await registry.executeAsync("safe_tool", {}, "call-1");

    expect(result.isError).toBe(false);
    expect(result.content).toBe("safe result");
  });

  it("executeAsync wraps MCP tool output with trust label", async () => {
    const registry = new ToolRegistry();
    registry.aregister(
      {
        name: "mcp__server__fetch",
        description: "MCP fetch tool",
        inputSchema: { type: "object", properties: {} },
      },
      async () => "external data",
    );

    // 没有权限管理器（跳过权限闸）
    const result = await registry.executeAsync("mcp__server__fetch", {}, "call-1");

    expect(result.isError).toBe(false);
    // MCP 工具输出被 trust label 包装
    expect(result.content).toContain("<untrusted_content");
    expect(result.content).toContain("mcp__server__fetch");
    expect(result.content).toContain("external data");
  });

  it("executeAsync does NOT wrap non-network tool output", async () => {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: "calc",
        description: "Calculator",
        inputSchema: { type: "object", properties: {} },
      },
      () => "42",
    );

    const result = await registry.executeAsync("calc", {}, "call-1");

    expect(result.isError).toBe(false);
    expect(result.content).toBe("42");
    expect(result.content).not.toContain("untrusted_content");
  });
});
