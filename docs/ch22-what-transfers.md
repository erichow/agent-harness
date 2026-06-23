# ch22-what-transfers — 什么能迁移，下一步去哪

**commit:** （下一个）
**tag:** ch22-what-transfers

## 收束

前情：21 章累积工程。Harness 现在有 loop、transcript、三 provider adapter、带校验+循环检测的 tool registry、流式、async、permissions、MCP 集成、scratchpad、retrieval、压缩、sub-agents、结构化 plan、并行协调、可观测性、evals、成本控制、durable checkpointing。

**最后一章不是为了更多机器——机器已经做完。是为了退后一步看：**

1. 跑完整 harness 对三家 provider，证明 adapter 缝挣到它的名字
2. 点名 harness **不做**什么，每个缺口在哪里被填上
3. 用一份**选型 scorecard** 收束——下次评估框架时拿出来用

---

## ① 对三 provider 实跑

第 1 章承诺：**provider-agnostic 意味着核心 harness——loop、tools、registry、context 工程——对任何 `Provider` 都不改地 work。**

同一份代码，三个 provider：

```
provider          tokens  iters  compact    sec
Anthropic         6,412      4        0    7.1
OpenAI            6,980      5        0    8.4
Local / OSS       9,108      6        1   22.3
```

数字变，形状不变——这就是 adapter 缝挣到它的名字的样子。你的 agent 逻辑、tools、context 策略、evals——都跨 provider 可复用。

> 模型下线（会发生）、价格变（会发生）、特定厂商的能力 gap（会发生）——没有一个强迫 agent 改写。它们强迫的是**配置变更**。

```typescript
// examples/ch22_multi_provider.ts 结构
const providers = [
  new AnthropicProvider(),
  new OpenAIProvider(),
  ...(process.env.LOCAL_ENDPOINT
    ? [new LocalProvider({ baseUrl: process.env.LOCAL_ENDPOINT })]
    : []),
];

const results = await Promise.all(
  providers.map((p) => runWith(p, SAME_TASK))
);
// 打印对比表
```

## ② Harness 不做什么

诚实清单。每条都是刻意的停止——不是做不到，是本书选择了聚焦：

| 不做 | 原因 / 替代路径 |
|------|----------------|
| ✗ **Fine-tuning** | Toolformer 显示工具使用行为可学习；我们假设前沿模型够用 |
| ✗ **Tree search / best-of-N** | Tree of Thoughts、Self-Refine 等——对可验证答案有用，loop 层一章可加 |
| ✗ **Embedding 检索** | BM25 是 baseline；把 `DocumentIndex` 换成 embedding 版是 drop-in 升级 |
| ✗ **真正沙箱（Firecracker/gVisor）** | 定义了 `ToolSandbox` 接口，ship subprocess+allowlist；生产交给 E2B/Modal |
| ✗ **Voice / multimodal** | 纯文本进出；MCP 有图像资源类型但没穿过来 |
| ✗ **UI** | CLI streaming work；没有 TUI / web UI / IDE 扩展 |
| ✗ **Team 部署** | 全程单用户；`session_id` 穿线已支持但没正式化 |
| ✗ **学习路由** | ModelRouter 是规则版；生产路由常用学习分类器 |

> 每一条都是刻意的停止。本书目标是端到端可理解的 harness，不是包办一切的 harness。

## ③ 先决定：自建 vs 用框架

| 场景 | 推荐 |
|------|------|
| 🟢 团队 ≤ 3 人，POC 阶段，agent 只是小特性 | 用 **LangGraph / OpenAI Agents SDK** |
| 🟡 团队 4-10 人，产品 PMF，agent 是核心特性 | 用 **Claude Code SDK / Anthropic 官方支架** |
| 🔴 团队 ≥ 10 人，agent 就是产品，需 provider-agnostic | **自建**（投入 2-3 人月初始建造 + 持续维护） |
| ⚪ 问题有可预测结构 | 也许根本不需要 agent——用 **workflow** |

**3 个误区：**

- *"用框架 = 弱者选择"*——错。生产里能把 LangGraph 跑稳的团队已经少见
- *"自建 = 一次性投资"*——错。22 章的工程是持续投资
- *"自建后能完全 provider-agnostic"*——半对。替换成本降到配置级，但每个 provider 的微妙差异是真实工作量

## ④ Scorecard——下次评估框架时用

明天会有一个框架 ship 声称它超越 LangGraph / Agents SDK / Claude Code。本书的词汇就是让你诚实评估它的工具：

**Loop**：什么触发停？可插拔吗？能看见多大？
**消息**：类型化还是 dict？Transcript 是一等对象吗？
**工具**：schema 从类型推断？有校验和循环检测吗？20+ tools 时怎么处理？
**Context**：有自动压缩吗？先压什么？窗口当预算资源追踪？
**Sub-agents**：强制 compact summary？有 spawn 预算吗？
**权限**：有权限层吗？策略可组合？处理 trust-labeled 输入？
**成本**：硬预算 in-process？prompt caching 内建？per-agent 归因？
**可观测性**：发 OTel spans？标准 ID 跨调用关联？checkpoint？回归 harness？

> 多数项打分好的框架值得采用。打分差的框架是你会成长出来的工具——而这本书就是你最终自己会建的那个东西的提纲。

## ⑤ 我希望刚开始时知道的

1. **模型是容易的部分**——10% 时间在模型选择，90% 在周围的一切
2. **第一天就建 Provider 抽象**——一文件 adapter 是 10 分钟的工作，省你几个月
3. **类型胜过 dict，特别是消息**——下次 ship 到新 provider 时 shape 错就还回来了
4. **Context 才是真正战场**——你会把 compactor 重建 3 次；能跳到第三版就跳
5. **工具设计比模型选择重要**——中庸模型 + 好工具 > 旗舰模型 + 邋遢工具
6. **Evals 不可选**——小套件就位就会在有人说"我觉得变差了"时回本
7. **告警不是 enforcement**——$47K 教训；预算 cap 跑在自己路径里
8. **压缩可能静默失败**——compactor 丢了东西 agent 不会告诉你
9. **Trust 标签必要但不充分**——纵深防御：permission + trust + network allowlist + 监控
10. **先 ship 平庸版本**——精巧版晚点来，平庸版 ship + measure 永远是第一步

## ⑥ 进一步阅读

| 想深入 | 读这个 |
|--------|--------|
| Context 工程 | Anthropic *Effective Context Engineering for AI Agents* (2025.9) |
| Multi-agent | Anthropic *How We Built Our Multi-Agent Research System* |
| ACI / 工具设计 | SWE-agent 论文 (Yang et al. 2024) + mini-SWE-agent 代码 |
| 评估 harnesses | smolagents 源码 + mini-swe-agent + Claude Code 文档 |
| 保持当代 | Anthropic 工程博客 · OpenAI cookbook · Hamel Husain (evals) |

---

> **Model 是函数 · Agent 是循环 · Harness 是工程**
>
> *剩下的工作是你自己的 repo 里的*

## 参考

- 本书全部 22 章：从第 1 章 Agent 概念到第 21 章 Durable checkpointing
- 第 1 章 4-问诊断 → 决定你到底需不需要 agent
- 第 3 章 28 种失败模式 catalog → 每个设计决定的动机
- 第 22 章 scorecard → 评估下一个框架的工具
