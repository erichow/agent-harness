# agent-harness 源码阅读路线图

## 整体结构

```
src/
├── harness/       ← 核心引擎（消息→循环→工具→安全→可观测性）
├── config/        ← 配置系统（第 28 章）
└── cli/           ← CLI 应用入口（第 29 章）
```

---

## 第一阶段：核心抽象（必须理解，否则后面看不懂）

这 4 个文件定义了整个 harness 的**词汇表**——所有其他代码都建立在它们之上。

```
顺序  文件                            章节    核心概念
───  ─────────────────────────────── ────   ──────────────────
 1   src/harness/messages.ts          ch03   Block / Message / Transcript
 2   src/harness/providers/events.ts  ch05   StreamEvent 5 种事件
 3   src/harness/providers/base.ts    ch03   Provider 协议 / ProviderResponse
 4   src/harness/tools/registry.ts    ch04   ToolDefinition / ToolRegistry
```

**关键理解：**
- Block 是 4 种联合类型（text / tool_call / tool_result / reasoning）
- Message = role + Block[]，Transcript = Message 容器
- Provider 是结构接口——只要实现了 `astream()` 就算
- ToolRegistry 把 schema 和 handler 绑在一起

---

## 第二阶段：Agent 循环（主线剧情）

看完核心抽象后，直接看主循环——这是整个 harness 的"心脏"。

```
顺序  文件                                章节    核心概念
───  ─────────────────────────────────── ────   ──────────────────
 5   src/harness/agent.ts                ch12   arun() 主循环
 6   src/harness/providers/mock.ts       ch03   MockProvider
 7   examples/ch04_calculator.ts          ch04   跑起来的第一个例子
```

**怎么读 `agent.ts`：**
1. `arun()` 是 async 函数，一个 for 循环跑最多 20 轮
2. 每轮：选工具 → snapshot → 调 provider → 处理响应 → 派发工具调用
3. 如果是文本回答 → 结束；如果是工具调用 → 执行 → 继续下一轮
4. 阅读时先看主循环结构，再深入 `_resolveTurnRegistry()` 和 `oneTurn()`

---

## 第三阶段：安全层（6 道闸门）

这些是插在 `execute()` 和 `executeAsync()` 里的安全机制，按重要性排序：

```
顺序  文件                                章节    核心概念
───  ─────────────────────────────────── ────   ──────────────────
 8   src/harness/tools/validation.ts     ch06   JSON Schema 校验
 9   src/harness/permissions/model.ts    ch14   Decision / PermissionRequest
10   src/harness/permissions/policy.ts   ch14   allowAll / bySideEffect / compose
11   src/harness/permissions/manager.ts  ch14   PermissionManager（策略+人 in loop）
12   src/harness/permissions/trust.ts    ch14   wrapIfUntrusted（防注入）
```

**要点：** 第 6 章的校验插在 `execute()` 的 4 道闸门里，第 14 章的权限插在 `executeAsync()` 的 5 道闸门里。这些都在 `registry.ts` 的 `execute()` 和 `executeAsync()` 中串联。

---

## 第四阶段：上下文管理（第 7-9 章）

上下文窗口是 agent 最稀缺的资源——这些代码管理它：

```
顺序  文件                                章节    核心概念
───  ─────────────────────────────────── ────   ──────────────────
13   src/harness/context/accountant.ts   ch07   ContextBudget / ContextSnapshot
14   src/harness/context/masking.ts      ch08   遮蔽旧 tool_result
15   src/harness/context/summarizer.ts   ch08   LLM 摘要前缀
16   src/harness/context/compactor.ts    ch08   压缩协调者（先 Mask 后 Summary）
```

**阅读顺序：** 先看 accountant（怎么记账），再看 masking（便宜的杠杆），再看 summarizer（贵的杠杆），最后看 compactor（怎么决策）。

---

## 第五阶段：工具生态（第 9-13, 23-27 章）

这些是 agent 能调用的实际工具——从简单到复杂：

```
顺序  文件                                章节    工具
───  ─────────────────────────────────── ────   ──────────────────
17   src/harness/tools/scratchpad.ts     ch09   持久化 KV 存储
18   src/harness/tools/retrieval.ts      ch10   search_docs 检索
19   src/harness/tools/files.ts          ch11   read_file_viewport / edit_lines
20   src/harness/tools/selector.ts       ch12   ToolCatalog 动态工具选择器
21   src/harness/mcp/client.ts           ch13   MCP 客户端（JSON-RPC over stdio）
22   src/harness/mcp/tools.ts            ch13   MCP 工具包装器
23   src/harness/tools/git.ts            ch23   8 个 git 工具
24   src/harness/tools/terminal.ts       ch24   5 道安全防线的终端执行
25   src/harness/tools/lsp.ts            ch25   LSP 代码智能（6 个工具）
26   src/harness/tools/code_analysis.ts  ch26   AST/依赖/复杂度/安全扫描
27   src/harness/tools/extended_filesystem.ts  ch27  创建/删除/搜索/元信息
28   src/harness/tools/ui.ts             ch30   UI 交互工具
```

**关键：** 第 12 章 `ToolCatalog` 解决"工具悬崖"问题——工具超过 20 个时模型选择准确率塌陷，所以每回合只选 top-K 工具。

---

## 第六阶段：质量和可靠性（第 16-21 章）

```
顺序  文件                                章节    核心概念
───  ─────────────────────────────────── ────   ──────────────────
29   src/harness/plans/model.ts          ch16   Plan / Step / Postcondition
30   src/harness/plans/tools.ts          ch16   plan_create / step_update 等 4 工具
31   src/harness/observability/tracing.ts ch18   OpenTelemetry
32   src/harness/evals/case.ts           ch19   EvalCase / EvalResult
33   src/harness/evals/judge.ts          ch19   LLM-as-Judge
34   src/harness/evals/runner.ts         ch19   EvalRunner
35   src/harness/evals/stability.ts      ch19   稳定性测试
36   src/harness/evals/from_trace.ts     ch19   生产 trace → 回归用例
37   src/harness/cost/enforcer.ts        ch20   BudgetEnforcer
38   src/harness/cost/router.ts          ch20   ModelRouter（经济/中/高端）
39   src/harness/checkpoint/store.ts     ch21   Checkpointer
40   src/harness/checkpoint/serde.ts     ch21   序列化/反序列化
41   src/harness/checkpoint/resume.ts    ch21   Resume 逻辑
```

---

## 第七阶段：配置和 CLI（第 28-29 章）

读完核心引擎后，看怎么把它包成一个可运行的 CLI 工具：

```
顺序  文件                                章节    核心概念
───  ─────────────────────────────────── ────   ──────────────────
42   src/config/config.ts                ch28   AgentConfig / 验证
43   src/config/discovery.ts             ch28   配置文件发现
44   src/config/loader.ts                ch28   多层覆盖加载
45   src/config/factory.ts               ch28   createAgentFromConfig
46   src/cli/main.ts                     ch29   CLI 参数解析 + REPL 循环
```

**`main.ts` 的流程：**
1. `parseArgs()` 解析 CLI 参数
2. `discoverConfigFile()` 找 YAML 配置文件
3. `loadConfig()` 合并默认值 + env + YAML + CLI 参数
4. `createAgentFromConfig()` 构建所有运行时组件
5. `runCLI()` → 单轮模式或交互式 REPL

---

## 一张图的总览

```
                    ┌─ main.ts (CLI 入口)
                    │
                    ├─ config/ (配置加载)
                    │
               ┌────┴──────────────────────────┐
               │         agent.ts (主循环)       │
               │  arun() → 选工具 → 调模型 →     │
               │  处理响应 → 派发 → 循环          │
               └────┬──────────────────────────┘
                    │
      ┌─────────────┼─────────────┬──────────────┐
      │             │             │              │
   messages.ts   providers/    tools/        context/
   (数据类型)    (模型适配)    (工具注册)    (窗口管理)
                   │             │
                events.ts    registry.ts    permissions/
                base.ts      validation    (安全层)
                mock.ts      selector
                deepseek.ts  files/git/    checkpoint/
                fallback.ts  terminal/    (持久化)
                retry.ts     lsp/code/
                             mcp/         cost/
                                          (成本控制)
```

---

## 建议阅读策略

1. **跟着章节号走**：ch03 → ch04 → ch05 → ... 是最自然的顺序，每章在前一章基础上加新能力
2. **先看文档再看代码**：`docs/chXX-*.md` 里解释了设计动机，读完再看代码事半功倍
3. **善用 example**：`examples/` 目录下有各章的可运行示例（`npx tsx examples/chXX_*.ts`）
4. **跳过不感兴趣的部分**：不想研究 git 集成？跳过 ch23（`tools/git.ts`）不影响对主循环的理解
