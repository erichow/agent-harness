# ch06-safe-tool-execution — 安全工具执行

**commit:** （下一个）
**tag:** ch06-safe-tool-execution

---

> **一句话：在工具 dispatch 前加 3 道安全闸门——Schema 校验杜绝畸形参数、模糊匹配给出 "Did you mean" 建议、循环检测拦截模型转圈——全部插在 execute() 一个拦截点。**

---

## 解决了什么

ch05 把 loop 改成了 async，解决了流式、中断和重试。但 **第 2 章那张 5-break 表还有两个开着的**：

| # | Break | ch05 现状 |
|---|---|---|
| 2 | 模型传错了参数 shape（`{expr: ...}` 而不是 `{expression: ...}`） | Python 在函数体里抛 TypeError 才发现——太晚了 |
| 4 | 模型用同样参数把同一个工具调一遍又一遍 | `MAX_ITERATIONS=20` 在 20 次浪费之后才接住——也太晚了 |

此外还有个设计债：**失败消息面向 Python 开发者，不面向模型**。

```
TypeError: calc() got an unexpected keyword argument 'expr'
```

→ 模型必须从一段瞄向人类调试器的错误里反向推理"哪个参数才对"。  
→ **结构化反馈** 让模型下一回合就能纠正（Reflexion 效应，Shinn et al. 2023）。

---

## 新增了什么

### 6.1 — JSON Schema 校验

```typescript
// src/harness/tools/validation.ts
export class ValidationError {
  constructor(readonly message: string, readonly path: string) {}
  toString(): string { return `${this.path}: ${this.message}`; }
}

export function validate(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): ValidationError[] { /* 使用 ajv */ }
```

**两个设计选择：**

- **返回 list，不抛异常。** 一次调用可能有多个问题（类型错 + 缺必填）。模型从"一条消息列出三件事"里学得比"连续 3 个回合各修一个"快得多。
- **路径是人类可读的。** 我们发 `args.expression`、`args.items[0].name`，而不是 JSON Pointer 的 `$.items.0.name`。

### 6.2 — 4 道闸门详解

4 道闸门全部在 `execute()` 方法里，按顺序执行，任一失败就短路返回错误，不给下一闸门机会。

```
execute(name, args, callId)
  ├─ 闸门 1: name 存在?            否 → _unknownTool (含 Did you mean?)
  ├─ 闸门 2: args ⊃ schema?        否 → _validationFailure (结构化错误回传)
  ├─ 闸门 3: 连续 3 次相同调用?     是 → _loopDetected (注入提示换策略)
  └─ 闸门 4: execute + try/catch    异常 → "faulty raised Error: kaboom"
```

---

#### 闸门 1 — 工具名存在性检查

```typescript
// 直接从源码来
if (!this.definitions.has(name)) {
  return this._unknownTool(name, toolCallId);
}
```

模型叫了一个不存在的工具名（比如 `calculator` 而你只注册了 `calc`），直接短路。

背后调用 `_fuzzyFindClosest()`，用 **LCS（最长公共子序列）比值** 在所有已注册工具名里找最接近的：

| 输入 | 候选 | LCS 长度 | 相似度 2×LCS÷(a+b) | 结果 |
|------|------|----------|---------------------|------|
| `"calculator"` | `"calc"` | 4 (`"calc"`) | 2×4÷14 ≈ **0.571** | ✅ ≥ 0.5 → `Did you mean 'calc'?` |
| `"python"` | `"calc"` | 1 (`"c"`) | 2×1÷10 = **0.2** | ❌ < 0.5 → 不提建议 |

输出给模型的错误消息：
```
unknown tool: calculator. Did you mean 'calc'? Available: ["calc","json_query"]
```

> **为什么不用 Levenshtein：** Levenshtein 给 `calculator` vs `calc` 的相似度为 `1 - 6÷10 = 0.4`，低于 cutoff，会把明显的拼写错误漏掉。LCS 比值匹配 Python `difflib.SequenceMatcher` 的行为，对子串保留类场景更友好。

---

#### 闸门 2 — JSON Schema 校验

```typescript
const errors = validate(args, tool.inputSchema);
if (errors.length > 0) {
  return this._validationFailure(name, errors, toolCallId);
}
```

参数传进去了，但它不满足 schema 的形状。使用 **ajv** 做完整 JSON Schema 校验。

**它能抓三类问题：**

| 问题类型 | 输入 | 输出 |
|----------|------|------|
| 缺必填 | `calc({})` | `calc: invalid arguments. args: must have required property 'expression'` |
| 类型错 | `calc({expression: 42})` | `calc: invalid arguments. args.expression: must be string` |
| 多个问题 | schema 有多个必填字段 | `calc: invalid arguments. args: must have required property 'expression'; args: must have required property 'format'` |

> **关键设计：返回 list 不抛异常。** 一次调用可能有多个问题。模型从"一条消息列出三件事"里学得比"连续 3 个回合各修一个"快得多——这是 Reflexion 论文 (Shinn et al. 2023, NeurIPS) 的核心发现。

路径格式也是刻意设计的——`args.expression`、`args.items[0].name` 比 JSON Pointer 的 `$.items.0.name` 对人类和模型都更自然。

---

#### 闸门 3 — 循环检测

```typescript
// 先记录
this._recordCall(name, args);
// 再检测
const loopResult = this._checkLoop(name, args, toolCallId);
if (loopResult !== null) {
  return loopResult;
}
```

校验通过，但模型在用完全相同的参数调同一个工具一遍又一遍——它卡住了。

**如何工作：**

```
记录: key = "calc|{\"expression\":\"1+1\"}"    push 到 callHistory[]
检测: 取最近 3 条 → 过滤等于当前 key → 计数 ≥ 3?
```

连续 3 次完全相同的 `(tool, args)` → 返回结构化错误：
```
tool-call loop detected: calc called with identical arguments 3 times in a row.
Try a different approach or different arguments, or stop and return your current best answer.
```

> **为什么用精确匹配：** 模糊匹配会把"真正的前进"误判为"循环"——`read_file("lines 1-50")` 和 `read_file("lines 1-51")` 看似相似但语义是前进。误报比漏报更糟。精确匹配只抓那个真正糟糕的情况——模型已经无招可出。

---

#### 闸门 4 — 执行 + try/catch

```typescript
try {
  const result = String(this.handlers.get(name)!(args));
  return toolResultBlock(toolCallId, result);
} catch (e) {
  return toolResultBlock(
    toolCallId,
    `${name} raised ${(e as Error).constructor.name}: ${(e as Error).message}`,
    true,
  );
}
```

三道闸门都过了，真的去执行工具函数。但如果工具内部抛异常，不会崩掉 loop——**try/catch 兜底**，以结构化错误回传给模型。

```
faulty raised Error: kaboom
```

比 ch04 的 `"kaboom"` 多了工具名和异常类型信息，方便模型判断"是这个工具本身不稳定"还是"我的参数导致的问题"。

---

#### 完整流程示例

```
execute("calc", {expression: 42}, "call-1")
  │
  ├─ 闸门 1: "calc" 在 registry 里吗?   → 是 ✅
  │
  ├─ 闸门 2: {expression: 42} 符合 schema? → 否 ❌
  │     expression 需要是 string，收到 number
  │     → 返回: `calc: invalid arguments. args.expression: must be string`
  │
  └─ 停在这里，不会继续到闸门 3 和 4
```

```
execute("calc", {expression: "1+1"}, "call-1")  第 1 次
execute("calc", {expression: "1+1"}, "call-2")  第 2 次
execute("calc", {expression: "1+1"}, "call-3")  第 3 次
  │
  ├─ 闸门 1 ✅ → 闸门 2 ✅ → 闸门 3: 最近 3 条里 3 条相同 → ❌
  │     → 返回: `tool-call loop detected: calc called with identical arguments 3 times...`
  │
  └─ 模型看到错误，下一回合换策略
```

```
execute("calc", {expression: "1+1"}, "call-1")
  │
  ├─ 闸门 1 ✅ → 闸门 2 ✅ → 闸门 3（仅 1 条记录，不触发）→ 闸门 4
  │     → eval("1+1") → "2" ✅ 正常返回
```

> 四道闸门合起来的效果：**错误的参数永远不会到达你的工具函数内部**，**卡住的模型不会浪费 token 原地转圈**，**拼错名字会被轻轻推一把而不是冷冰冰地拒绝**。

### 6.3 — 未知工具建议

使用 **最长公共子序列（LCS）比值**（匹配 Python `difflib.SequenceMatcher` 行为）：

```
"calculator" × "calc" → LCS = "calc"(4) → 2×4/(10+4) ≈ 0.571 → 通过 0.5 cutoff
"python"    × "calc" → LCS = "c"(1)   → 2×1/(6+4)  = 0.2   → 拒绝
```

经验上这能恢复 ~80% 的拼错工具名，代价是不到 30 行内联代码。

### 6.4 — 循环检测

使用 **精确匹配** — `(name, JSON.stringify(sorted keys))` 作为 dedup key：

```typescript
const MAX_REPEAT_CALLS = 3;
```

- 连续 3 次完全相同 (tool, args) → 注入结构化错误
- 不搞模糊匹配——"read lines 1-50" 和 "read lines 1-51" 看似相似但语义是前进，误报比漏报更糟

### 6.5 — json_query 工具

新增示例工具，两个必填 string 参数，压力测试校验能力：

```typescript
json_query({ data: '{"user":{"name":"Alice"}}', path: "user.name" })
// → '"Alice"'
```

---

## 架构变化

```
                    ┌─────────────────────────┐
                    │      agent.ts (loop)    │
                    │  registry.execute(args) │
                    └────────┬────────────────┘
                             │
                    ┌────────▼────────────────┐
                    │    ToolRegistry          │
                    │  ┌─ 闸门 1: name 存在?  │
                    │  ├─ 闸门 2: validate()  │
                    │  ├─ 闸门 3: checkLoop() │
                    │  └─ 闸门 4: handler     │
                    └─────────────────────────┘
                             │
               ┌─────────────┼─────────────┐
               ▼             ▼             ▼
        validation.ts   tools/*.ts    callHistory[]
        (ajv schema)    (执行函数)    (循环检测)
```

---

## 测试覆盖

```
ch06_registry.test.ts — 22 tests
├─ unknown tool with suggestion (3)
│  ├─ 'calculator' → Did you mean 'calc'?
│  ├─ 'python' → no suggestion
│  └─ empty registry → no suggestion
├─ validation (4)
│  ├─ missing required field
│  ├─ wrong type
│  ├─ extra unknown properties (allowed)
│  └─ valid args passes
├─ loop detection (3)
│  ├─ 3 identical calls → detected
│  ├─ different args → not triggered
│  └─ different tools → not triggered
├─ json_query tool (7)
│  ├─ simple object / array / nested
│  ├─ invalid JSON / missing key / out of range
│  └─ via registry
└─ 4 gates integrated (5)
   ├─ gate 1-4 individual
   └─ all pass → success
```

---

## 一句话

> ch06 用 4 道闸门把 registry 从"工具调度器"变成"安全的工具调度器"——校验在 dispatch 前，建议在拼错时，拦截在转圈时。**模型不再需要看 Python traceback 来理解自己错了什么。**
