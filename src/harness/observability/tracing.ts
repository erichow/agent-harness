/**
 * observability/tracing.ts — 第 18 章：可观测性
 *
 * 薄 instrumentation 层，封装 OpenTelemetry 打点细节。
 *
 * 设计目标：
 *   1. 不把 tracer.startActiveSpan 散落到 harness 各处
 *   2. SessionContext 作为关联锚——session_id / task_id / agent_id
 *   3. setupTracing() 幂等——可在已 instrumented 进程中安全复用
 *   4. span() 函数式 wrapper——一致处理错误、属性、生命周期
 */

import { AsyncLocalStorage } from "node:async_hooks";

/* ─── SessionContext ─────────────────────────────────────────────── */

/**
 * 每条 span 的关联锚。
 *
 * - `sessionId` — 一次 agent.run 调用（一个用户请求）
 * - `taskId`   — 更高层级的任务标识（可选，用于关联多个 session）
 * - `agentId`  — 哪个 agent 产生了这条 span（root / sub-xxx）
 *
 * Sub-agent 继承 parent 的 sessionId + taskId，改变 agentId。
 * 下游 GROUP BY agentId 就得 per-agent 成本归因。
 */
export interface SessionContext {
  sessionId: string;
  taskId: string;
  agentId: string;
}

/* ─── 全局状态 + AsyncLocalStorage ─────────────────────────────── */

let initialized = false;

const als = new AsyncLocalStorage<SessionContext>();

/**
 * 获取当前 async 上下文中的 SessionContext。
 * 在 span() 外部调时返回 null（测环境、CLI 脚本等）。
 */
export function getSessionContext(): SessionContext | null {
  return als.getStore() ?? null;
}

/**
 * 在指定 SessionContext 下执行 fn。
 * 所有嵌套 span() 调用都能通过 getSessionContext() 拿到此 context。
 */
export function runWithContext<T>(ctx: SessionContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/**
 * 从 parent context 派生 sub-agent context。
 * 保留 sessionId + taskId，替换 agentId。
 */
export function subagentContext(parent: SessionContext, agentId: string): SessionContext {
  return { ...parent, agentId };
}

/* ─── setupTracing — 一次性初始化 ────────────────────────────────── */

/**
 * OpenTelemetry SDK 初始化（幂等）。
 *
 * @param serviceName  — 在 trace 中标记服务名，默认 "agent-harness"
 * @param otlpEndpoint — 可选，指向 OTLP 兼容后端（Jaeger / Langfuse / Datadog 等）
 * @param apiKey       — 可选的 bearer token / API key
 *
 * 不传 otlpEndpoint 时默认使用 ConsoleSpanExporter（开发模式）。
 *
 * 幂等保证：重复调用是 no-op。当 harness 作为库嵌入
 * 已 instrumented 的进程（CI runner、web 后端）时关键。
 */
export function setupTracing(
  serviceName = "agent-harness",
  otlpEndpoint?: string,
  apiKey?: string,
): void {
  if (initialized) return;
  initialized = true;

  // 动态导入避免未安装时的启动崩溃
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resource } = require("@opentelemetry/resources");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    SemanticResourceAttributes,
  } = require("@opentelemetry/semantic-conventions");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    ConsoleSpanExporter,
    BatchSpanProcessor,
  } = require("@opentelemetry/sdk-trace-base");

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  });

  const provider = new NodeTracerProvider({ resource });

  if (otlpEndpoint) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
    const exporter = new OTLPTraceExporter({
      url: otlpEndpoint,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  } else {
    // 开发模式：控制台输出
    provider.addSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  provider.register();
}

/* ─── span() — 核心 instrumentation helper ────────────────────────── */

/**
 * 创建一个 OTel span 并在其中执行 fn。
 *
 * 自动附加当前 SessionContext（session_id / task_id / agent_id），
 * 支持自定义属性、错误状态设置、异常记录。
 *
 * @param name  — span 名称（如 "agent.run"、"gen_ai.completion"）
 * @param attrs — 附加 span 属性
 * @param fn    — 在 span 内执行的同步或异步函数
 * @returns fn 的返回值
 *
 * @example
 * ```ts
 * const result = span("tool.call", { "tool.name": "search" }, () => {
 *   return search(query);
 * });
 * ```
 */
export function span<T>(
  name: string,
  attrs: Record<string, string | number | boolean> = {},
  fn: () => T,
): T {
  const { trace } = require("@opentelemetry/api");
  const { SpanStatusCode } = require("@opentelemetry/api");
  const tracer = trace.getTracer("harness");

  return tracer.startActiveSpan(name, (span: any) => {
    // 自动附加 SessionContext
    const ctx = getSessionContext();
    if (ctx) {
      span.setAttribute("harness.session_id", ctx.sessionId);
      span.setAttribute("harness.task_id", ctx.taskId);
      span.setAttribute("harness.agent_id", ctx.agentId);
    }

    // 自定义属性
    for (const [k, v] of Object.entries(attrs)) {
      span.setAttribute(k, v);
    }

    try {
      const result = fn();
      if (result instanceof Promise) {
        return (result as Promise<T>).then(
          (val) => {
            span.end();
            return val;
          },
          (err) => {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(err),
            });
            span.recordException(err);
            span.end();
            throw err;
          },
        );
      }
      span.end();
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: String(err),
      });
      span.recordException(err as Error);
      span.end();
      throw err;
    }
  });
}

/* ─── 语义常量（GenAI Semantic Conventions 的子集） ───────────────── */

/**
 * GenAI 语义约定的常用属性名。
 * OTel 官方定义：https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export const GenAIAttributes = {
  SYSTEM: "gen_ai.system",
  INPUT_TOKENS: "gen_ai.usage.input_tokens",
  OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
} as const;

export const HarnessAttributes = {
  SESSION_ID: "harness.session_id",
  TASK_ID: "harness.task_id",
  AGENT_ID: "harness.agent_id",
  FINAL_ITERATION: "harness.final_iteration",
  INITIAL_USER_MESSAGE_LEN: "harness.initial_user_message_len",
  CONTEXT_UTILIZATION: "harness.context_utilization",
} as const;
