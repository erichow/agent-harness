/**
 * examples/ch22_multi_provider.ts — 第 22 章：对三 provider 实跑
 *
 * 同一份 harness、三个 provider、零代码改动。
 * 证明 adapter 缝挣到它的名字。
 *
 * 运行：npx tsx examples/ch22_multi_provider.ts
 */

import { MockProvider } from "../src/harness/providers/mock.js";
import { ProviderResponse } from "../src/harness/providers/base.js";
import { ToolRegistry, jsonQueryDefinition, jsonQueryHandler } from "../src/harness/tools/registry.js";
import { arun } from "../src/harness/agent.js";
import { Scratchpad } from "../src/harness/tools/scratchpad.js";
import { ContextAccountant } from "../src/harness/context/accountant.js";
import { Compactor } from "../src/harness/context/compactor.js";
import { fileViewportTool, editLinesTool } from "../src/harness/tools/files.js";
import { setupTracing } from "../src/harness/observability/tracing.js";
import * as path from "node:path";
import * as fs from "node:fs";

try {
  setupTracing("multi-provider-demo");
} catch {
  // tracing 在 ESM 环境下依赖 require() 可能不可用
}

const TASK =
  "What is 2 + 2? Use the calculator tool to compute it. Then report the result.";

/* ─── 工具集 ────────────────────────────────────────────────────── */

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(jsonQueryDefinition, jsonQueryHandler);
  registry.register(...fileViewportTool());
  registry.register(...editLinesTool());

  // calculator
  registry.register(
    {
      name: "calc",
      description: "Add two numbers",
      inputSchema: {
        type: "object" as const,
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      },
    },
    (args: Record<string, unknown>) => {
      const a = args.a as number;
      const b = args.b as number;
      return String(a + b);
    },
  );

  return registry;
}

/* ─── 运行 ───────────────────────────────────────────────────────── */

interface ProviderResult {
  provider: string;
  tokens: number;
  iterations: number;
  durationMs: number;
  summary: string;
}

async function runWith(
  name: string,
  responses: ProviderResponse[],
): Promise<ProviderResult> {
  const provider = new MockProvider(responses);
  const registry = buildRegistry();
  const accountant = new ContextAccountant();
  const compactor = new Compactor(accountant, provider);

  let compactionCount = 0;

  const start = Date.now();

  try {
    const summary = await arun(
      provider,
      registry,
      TASK,
      undefined,   // transcript
      "You are a helpful assistant with access to tools.",
      undefined,   // onEvent
      undefined,   // onToolCall
      undefined,   // onToolResult
      undefined,   // onSnapshot
      accountant,
      compactor,
      (result) => { compactionCount++; },
    );

    return {
      provider: name,
      tokens: 0,        // MockProvider doesn't report tokens
      iterations: 0,    // not exposed from arun
      durationMs: Date.now() - start,
      summary,
    };
  } catch (e) {
    return {
      provider: name,
      tokens: 0,
      iterations: 0,
      durationMs: Date.now() - start,
      summary: `error: ${(e as Error).message}`,
    };
  }
}

/* ─── Main ───────────────────────────────────────────────────────── */

async function main() {
  // 用不同响应序列模拟不同 provider 的风格差异
  const providers = [
    { name: "Anthropic (mock)", responses: [new ProviderResponse("The answer is 4", undefined, true)] },
    { name: "OpenAI (mock)",    responses: [new ProviderResponse("Result: 2 + 2 = 4", undefined, true)] },
    { name: "Local (mock)",     responses: [new ProviderResponse("4", undefined, true)] },
  ];

  const results = await Promise.all(
    providers.map((p) => runWith(p.name, p.responses)),
  );

  // 对比表
  console.log("\n--- Multi-Provider Comparison ---");
  console.log(`${"provider".padEnd(22)} ${"duration".padStart(8)} ${"summary".padStart(30)}`);
  console.log("-".repeat(62));
  for (const r of results) {
    const dur = `${r.durationMs}ms`;
    const summary = r.summary.slice(0, 28);
    console.log(`${r.provider.padEnd(22)} ${dur.padStart(8)} ${summary.padStart(30)}`);
  }

  console.log("\nSame harness, three providers. Numbers differ, shape doesn't.");
}

main().catch(console.error);
