/**
 * Agent 循环 — 第 12 章（selector-aware 版）
 *
 * 相比第 8 章的变化：
 *   1. arun 接受 ToolCatalog | ToolRegistry 双模式
 *   2. ToolCatalog 模式：每回合动态选取 top-K 工具
 *   3. + pinnedTools / toolsPerTurn 参数
 *   4. + discovery 工具自动注册
 *
 * 向后兼容：传入 ToolRegistry 则行为不变。
 */
import type { Provider } from "./providers/base.js";
import { ProviderResponse, accumulate } from "./providers/base.js";
import type { ToolRegistry as ToolRegistryType } from "./tools/registry.js";
import { ToolRegistry } from "./tools/registry.js";
import { Message, Transcript, toolCallBlock, toolResultBlock } from "./messages.js";
import type { Block, ToolCallBlock, ToolResultBlock } from "./messages.js";
import type { StreamEvent } from "./providers/events.js";
import { isTextDelta } from "./providers/events.js";
import { ContextAccountant } from "./context/accountant.js";
import type { ContextSnapshot } from "./context/accountant.js";
import { Compactor } from "./context/compactor.js";
import type { CompactionResult } from "./context/compactor.js";
import { ToolCatalog, queryFromTranscript, createDiscoveryEntry } from "./tools/selector.js";
import type { CatalogEntry } from "./tools/selector.js";

export const MAX_ITERATIONS = 20;

/* ─── 回调类型 ───────────────────────────────────────────────────── */

export type OnEvent = (event: StreamEvent) => void;
export type OnSnapshot = (snapshot: ContextSnapshot) => void;
export type OnCompaction = (result: CompactionResult) => void;

/* ─── arun — async loop ──────────────────────────────────────────── */

/**
 * 运行 agent 循环（async 版，第 12 章：selector-aware）。
 *
 * @param provider     - 模型供应方
 * @param catalogOrReg - ToolCatalog（动态选择）或 ToolRegistry（向后兼容）
 * @param userMessage  - 用户的起始消息
 * @param transcript   - 可选的已有 transcript
 * @param system       - 可选的系统 prompt
 * @param onEvent      - 每收到一个 StreamEvent 的回调
 * @param onToolCall   - 工具调用前的回调
 * @param onToolResult - 工具执行完毕的回调
 * @param onSnapshot   - 每回合 snapshot 后的回调
 * @param accountant   - 上下文记账员
 * @param compactor    - 压缩协调者
 * @param onCompaction - 压缩完成后的回调
 * @param pinnedTools  - 始终包含的工具名（仅 catalog 模式，默认含 list_available_tools）
 * @param toolsPerTurn - 每回合工具数（仅 catalog 模式，默认 7）
 * @returns 模型的最终回答
 */
export async function arun(
  provider: Provider,
  catalogOrReg: ToolCatalog | ToolRegistryType,
  userMessage: string,
  transcript?: Transcript,
  system?: string,
  onEvent?: OnEvent,
  onToolCall?: (call: ToolCallBlock) => void,
  onToolResult?: (result: ToolResultBlock) => void,
  onSnapshot?: OnSnapshot,
  accountant?: ContextAccountant,
  compactor?: Compactor,
  onCompaction?: OnCompaction,
  pinnedTools?: string[],
  toolsPerTurn?: number,
): Promise<string> {
  if (!transcript) {
    transcript = new Transcript(system);
  }
  transcript.append(Message.userText(userMessage));

  const ctxAccountant = accountant ?? new ContextAccountant();
  const ctxCompactor = compactor ?? new Compactor(ctxAccountant, provider);

  // 判断模式
  const isCatalogMode = catalogOrReg instanceof ToolCatalog;
  const catalog: ToolCatalog | null = isCatalogMode
    ? (catalogOrReg as ToolCatalog)
    : null;
  const staticRegistry: ToolRegistryType | null = isCatalogMode
    ? null
    : (catalogOrReg as ToolRegistryType);

  // catalog 模式：自动钉住 discovery 工具
  const effectivePinned = new Set(pinnedTools ?? []);
  if (catalog) {
    effectivePinned.add("list_available_tools");
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // 第 12 章：每回合选取工具
    const turnRegistry = _resolveTurnRegistry(
      catalog, staticRegistry, transcript, effectivePinned, toolsPerTurn,
    );

    // 第 7 章：每 turn 前 snapshot
    const snapshot = ctxAccountant.snapshot(transcript, turnRegistry.getSchemas());
    if (onSnapshot) onSnapshot(snapshot);

    if (snapshot.state === "red") {
      const result = await ctxCompactor.compactIfNeeded(
        transcript,
        turnRegistry.getSchemas(),
      );
      if (onCompaction) onCompaction(result);
      if (onSnapshot) {
        onSnapshot(ctxAccountant.snapshot(transcript, turnRegistry.getSchemas()));
      }
    }

    const partialText: string[] = [];
    let response: ProviderResponse;

    try {
      response = await oneTurn(provider, turnRegistry, transcript, partialText, onEvent);
    } catch (err) {
      if (isCancelledError(err)) {
        if (partialText.length > 0) {
          transcript.append(Message.assistantText(
            partialText.join("") + " [interrupted]",
          ));
        }
        throw err;
      }
      throw err;
    }

    if (response.isFinal) {
      transcript.append(Message.fromAssistantResponse(response));
      return response.text ?? "";
    }

    transcript.append(Message.fromAssistantResponse(response));

    // 逐个派发工具调用
    for (const ref of response.toolCalls) {
      const call = toolCallBlock(ref.id, ref.name, ref.args);
      if (onToolCall) onToolCall(call);

      // catalog 模式：如果工具不在 turnRegistry 里，尝试从 catalog 派发
      const result = _dispatchWithFallback(ref.name, ref.args, ref.id, turnRegistry, catalog);
      const resultBlock = toolResultBlock(ref.id, result.content, result.isError);
      transcript.append(Message.toolResult(resultBlock));
      if (onToolResult) onToolResult(resultBlock);
    }
  }

  throw new Error(
    `agent did not finish in ${MAX_ITERATIONS} iterations`,
  );
}

/* ─── 工具注册解析 ───────────────────────────────────────────────── */

/**
 * 解析本回合的工具注册表。
 * - catalog 模式：select 后创建临时 registry
 * - registry 模式：直接返回原始 registry
 */
function _resolveTurnRegistry(
  catalog: ToolCatalog | null,
  staticRegistry: ToolRegistryType | null,
  transcript: Transcript,
  pinnedTools: Set<string>,
  toolsPerTurn: number | undefined,
): ToolRegistry {
  if (catalog) {
    const query = queryFromTranscript(transcript);
    const selected = catalog.select(query, toolsPerTurn ?? 7, pinnedTools);
    const reg = new ToolRegistry();
    for (const entry of selected) {
      reg.register(entry.definition, entry.handler);
    }
    return reg;
  }
  return staticRegistry!;
}

/* ─── 工具派发（含 fallback） ───────────────────────────────────── */

/**
 * 派发工具调用。
 * - 优先用 turnRegistry
 * - catalog 模式：如果 turnRegistry 没有该工具，从 catalog 查找
 *   这是 try-fail-retry 机制——模型调了没被选中的工具时自动恢复
 */
function _dispatchWithFallback(
  name: string,
  args: Record<string, unknown>,
  callId: string,
  turnRegistry: ToolRegistry,
  catalog: ToolCatalog | null,
): { content: string; isError: boolean } {
  // 先在 turnRegistry 中执行
  if (turnRegistry.has(name)) {
    const result = turnRegistry.execute(name, args, callId);
    return { content: result.content, isError: result.isError };
  }

  // catalog 模式：尝试从 catalog 查找 handler
  if (catalog) {
    const entry = catalog.get(name);
    if (entry) {
      try {
        const content = String(entry.handler(args));
        return { content, isError: false };
      } catch (e) {
        return {
          content: `${name} raised ${(e as Error).constructor.name}: ${(e as Error).message}`,
          isError: true,
        };
      }
    }
  }

  // 完全找不到
  return {
    content: `unknown tool: ${name}`,
    isError: true,
  };
}

/* ─── oneTurn — 一次 provider 交互 ────────────────────────────────── */

async function oneTurn(
  provider: Provider,
  registry: ToolRegistryType,
  transcript: Transcript,
  partialText: string[],
  onEvent?: OnEvent,
): Promise<ProviderResponse> {
  const toolSchemas = registry.getSchemas();
  const stream = provider.astream(transcript, toolSchemas);

  async function* forward(): AsyncGenerator<StreamEvent> {
    for await (const event of stream) {
      if (onEvent) onEvent(event);
      if (isTextDelta(event)) {
        partialText.push(event.text);
      }
      yield event;
    }
  }

  return accumulate(forward());
}

/* ─── 中断判断 ────────────────────────────────────────────────────── */

function isCancelledError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
     err.name === "CancelledError" ||
     (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError"))
  );
}

/* ─── run — 同步入口 ─────────────────────────────────────────────── */

/**
 * 同步 run() — 第 4 章及之前的脚本和测试仍然使用此方法。
 *
 * 使用同步 Provider.complete() 路径，不涉及流式事件。
 * 第 12 章的 selector 模式仅在 arun() 中可用。
 */
export function run(
  provider: Provider,
  registry: ToolRegistry,
  userMessage: string,
  system?: string,
): string {
  const transcript = new Transcript(system);
  transcript.append(Message.userText(userMessage));

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const toolSchemas = registry.getSchemas();
    const response = provider.complete(transcript, toolSchemas);

    if (response.isFinal) {
      transcript.append(Message.fromAssistantResponse(response));
      return response.text ?? "";
    }

    if (response.isToolCall) {
      transcript.append(Message.fromAssistantResponse(response));

      for (const ref of response.toolCalls) {
        const block = registry.execute(ref.name, ref.args, ref.id);
        transcript.append(Message.toolResult(block));
      }
      continue;
    }

    throw new Error(`unexpected response: no text and no tool calls`);
  }

  throw new Error(
    `agent did not finish in ${MAX_ITERATIONS} iterations`,
  );
}
