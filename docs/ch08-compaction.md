# ch08-compaction — 压缩

**commit:** （下一个）
**tag:** ch08-compaction

---

> **一句话：两层压缩——先 mask 旧 tool_result（可逆·精确·免费），不够再 summarize 前缀（有损·贵·必要时才上）——把 transcript 缩小，又不伤工具调用记录。**

---

## 解决了什么

ch07 的 accountant 能看见上下文窗口进入 red 状态，但 red 分支只有一个 `pass`——**transcript 持续增长直到 provider 拒收**。

Compaction 是本书第一个正确答案不明显、设计空间真正有争议的子系统。生产系统各有各的解法：

| 系统 | 做法 |
|------|------|
| Claude Code | 用更便宜的模型总结旧回合 |
| OpenAI Agents SDK | 留给开发者去做 |
| LangGraph | 图模型里没有原生压缩 |
| AutoGen GroupChat | O(n×m) 随 agent×turn 增长 |

---

## 新增了什么

### 8.1 — Masking（遮蔽）

把旧的 `ToolResult.content` 替换成占位符，保留 `call_id` 和原始 token 数。

```
原始: "大型 JSON 输出（5000 tokens）"
遮蔽: "[tool_result elided; call_id=c-3; original_tokens~=1250]"
```

三个设计细节：

- **幂等** — 已 mask 的 content（以 `[tool_result elided` 开头）不再处理，因为压缩可能在一个 session 里跑多次
- **返回释放数** — 调用方据此决定是否升级到 summarization
- **重建 message** — 保持不可变纪律（ch03 的 frozen block 约定）

```typescript
export function maskOlderResults(
  transcript: Transcript,
  keepRecent: number = 3,
): number
```

### 8.2 — Summarization（总结）

当 masking 单独不能把 transcript 压到 red 以下时，用 LLM 总结前缀。

**关键设计：**

- **跳过第 1 条 user message** — 用户的初始目标是 anchor，agent 最终要满足它，尽可能久保留原样
- **Tool calls 显式渲染** — `[assistant→tool] calc({...})` 进了 summarizer 输入；prompt 要求逐行保留 tool call
- **就地替换** — transcript 第 1 条保留，摘要成第 2 条，最近 turn 保留

### 8.3 — Compactor（协调者）

```typescript
export class Compactor {
  async compactIfNeeded(
    transcript: Transcript,
    toolSchemas: Record<string, unknown>[],
  ): Promise<CompactionResult> {
    // Step 1: mask older tool results
    // Step 2: if still red → summarize prefix
    // Step 3: if still red → log warning and give up
  }
}
```

**两根杠杆，按顺序拉：**

```
red → mask → 还红? → summarize → 还红? → log 警告并放弃
           ↓              ↓               ↓
          green         green         provider 层失败
```

### 8.4 — Loop 集成

```typescript
if (snapshot.state === "red") {
  const result = await compactor.compactIfNeeded(transcript, schemas);
  if (onCompaction) onCompaction(result);
  // 再发一次 snapshot（效果帧）
  if (onSnapshot) onSnapshot(accountant.snapshot(transcript, schemas));
}
```

压缩后发第二次 `onSnapshot`——同一迭代内观察者能看到 before/after。

---

## 架构变化

```
agent.ts (arun)
  │
  ├─ 每 turn: snapshot
  │     └─ red → Compactor.compactIfNeeded()
  │              ├─ maskOlderResults()        masking.ts
  │              └─ summarizePrefix()         summarizer.ts
  │
  └─ 压缩后: 二次 snapshot（效果帧）
                   │
        context/
          ├─ masking.ts     — maskOlderResults()
          ├─ summarizer.ts  — summarizePrefix()
          └─ compactor.ts   — Compactor + CompactionResult
```

## 测试覆盖

```
ch08_compactor.test.ts — 11 tests
├─ maskOlderResults (5)
│  ├─ count <= keepRecent → 无操作
│  ├─ masks older, keeps recent
│  ├─ 幂等
│  ├─ 无 tool_result → 0
│  └─ 保留 callId 和 isError
├─ summarizePrefix (2)
│  ├─ 消息不足 → null
│  └─ 替换前缀为摘要消息
├─ Compactor (2)
│  ├─ green → 无操作
│  └─ red → masking 生效
└─ Agent 集成 (2)
   ├─ red 触发 onCompaction
   └─ 默认参数不破坏正常流程
```

---

## 一句话

> ch08 的 Compactor 先尝试免费的 mask（可逆、精确），不够再调用 LLM summarize（有损、昂贵）。两根杠杆都拉了还红 → 日志警告并放弃——**让操作员能看到问题，比默默失败好**。
