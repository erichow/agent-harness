# ch07-context-window — 上下文窗口是一种资源

**commit:** （下一个）
**tag:** ch07-context-window

---

> **一句话：构建 ContextAccountant，按组件追踪 token 用量——system / tools / history / retrieved / headroom——为第 8-11 章的压缩、scratchpad、检索决策提供数据基础。**

---

## 解决了什么

ch06 的 4 道闸门让 registry 安全了。但 **第 2 章那张 5-break 表还有最后一个没关**——Break 5：*一个返回 200KB JSON 的工具，第 4 个回合还是会毒死 loop。*

上下文窗口是 agent 工程里被误解最严重的资源。三个直觉都是错的：

| 直觉 | 现实 |
|------|------|
| 大小固定 | 模型性能在远未撞顶之前就开始连续下降 |
| 消耗线性 | tool 结果、检索文档、过往回合的 token/价值比完全不同 |
| 满了显而易见 | 模型会静默失败——迷失在中间、编造事实 |

三项关键研究：

- **Chroma 2025 · Context Rot** — 18 个 SOTA 模型上，即便输入只是窗口的 10%，性能也连续下降
- **Liu 2023 · Lost in the Middle** — 检索准确率是 U 形曲线：中间的内容明显被忽视
- **Hsieh 2024 · RULER** — 每个模型的有效长度都比标称短 4-8×

---

## 新增了什么

### 7.1 — ContextBudget

```typescript
export class ContextBudget {
  constructor(
    readonly windowSize: number = 200_000,
    readonly headroom: number = 4096,
    readonly yellowThreshold: number = 0.60,
    readonly redThreshold: number = 0.80,
  ) {}

  get usable(): number {
    return this.windowSize - this.headroom;
  }
}
```

阈值经验法则：

| 状态 | 区间 | 行动 |
|------|------|------|
| 🟢 green | ≤ 60% | 无须动作 |
| 🟡 yellow | 60–80% | 考虑压缩 |
| 🔴 red | > 80% | 立即压缩 |

### 7.2 — ContextSnapshot

某一时刻的上下文快照，按 5 类组件拆分：

- **system** — 系统提示词（整 session 稳定）
- **tools** — tool schemas（由 provider 渲染到 prompt）
- **history** — 对话历史（user / assistant / tool 结果）
- **retrieved** — 为当前 turn 检索的外部内容（第 10 章用）
- **headroom** — 预留给模型响应的空间

### 7.3 — ContextAccountant

```typescript
export class ContextAccountant {
  readonly budget: ContextBudget;

  snapshot(
    transcript: Transcript,
    toolSchemas?: Record<string, unknown>[],
    retrieved?: string[],
  ): ContextSnapshot { /* ... */ }
}
```

**纯测量，不改任何数据。** 只回答一个问题：*"给你这份 transcript 和这些工具，我在花你 usable 窗口的多少，按组件怎么拆分？"*

Token 估算方法：`charCount / 4`（对英文约 4 字符/token，中文算 2 字符/token）。不需要额外依赖，偏差在预算决策中可接受。Provider 返回的 `input_tokens` 用于事后对账。

### 7.4 — Loop 集成

arun() 新增两个参数：

```typescript
export async function arun(
  // ... 原有参数 ...
  onSnapshot?: (snapshot: ContextSnapshot) => void,
  accountant?: ContextAccountant,
): Promise<string>
```

每 turn 前执行：

```typescript
const snapshot = ctxAccountant.snapshot(transcript, registry.getSchemas());
if (onSnapshot) onSnapshot(snapshot);
if (snapshot.state === "red") {
  // 第 8 章：compactor 塞在这里。目前仅观察。
}
```

`onSnapshot` 每回合触发一次——CLI/TUI 可用于显示实时上下文用量；生产 harness 喂给可观测性 pipeline。

---

## 架构变化

```
agent.ts (arun)
  │
  ├─ 每 turn 前: accountant.snapshot()
  │     ├─ onSnapshot(snapshot) → UI / OTel
  │     └─ state === "red" → 第 8 章 compactor
  │
  └─ 原有逻辑: oneTurn() → dispatch → next turn
                    │
         context/accountant.ts
           ├─ ContextBudget (window_size, headroom, thresholds)
           ├─ ContextSnapshot (totals, utilization, state)
           └─ ContextAccountant (snapshot, _countText, _countBlocks)
```

## 测试覆盖

```
ch07_accountant.test.ts — 18 tests
├─ ContextBudget (4)
│  ├─ defaults
│  ├─ usable = windowSize - headroom
│  ├─ custom thresholds
│  └─ zero usable (defensive)
├─ ContextSnapshot (5)
│  ├─ totalUsed excludes headroom
│  ├─ utilization
│  ├─ green / yellow / red state
│  └─ defensive zero
├─ ContextAccountant: text counting (2)
│  ├─ empty = 0
│  └─ longer = more
├─ ContextAccountant: message counting (2)
│  ├─ counts history messages
│  └─ counts tool_call + tool_result blocks
├─ ContextAccountant: snapshot (2)
│  ├─ 5 components
│  └─ snapshot changes as transcript grows
└─ agent integration (3)
   ├─ onSnapshot fires each turn
   ├─ multi-turn fires each iteration
   └─ custom accountant forwarded
```

---

## 一句话

> ch07 把上下文窗口从"看不见的黑箱"变成"可测量的预算"——Accountant 只测量不修改，`onSnapshot` 给 UI 和可观测性消费，red state 的钩子留给第 8 章。**填窗口的不是用户，是工具输出。**
