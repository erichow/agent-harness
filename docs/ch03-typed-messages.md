# ch03-typed-messages — 类型化消息系统与错误恢复

**commit:** 951709b
**tag:** ch03-typed-messages

---

## 解决了什么

ch02 的朴素版 loop 有 5 个"一定会破"的设计缺陷。ch03 堵上了前 2 个：

| ch02 的问题 | ch03 怎么修的 |
|---|---|
| **transcript 是 `Record[]`** — 没有语义类型，工具调用和文本回答在代码里长一个样，接入新厂商要重写整个 transcript | 引入 `Block` / `Message` / `Transcript` 三层架构，语义和传输格式分离 |
| **工具调度没防护** — 模型喊了个不存在的工具 → 循环崩；工具函数抛异常 → 循环崩 | `try/catch` 包裹调度，错误结构化为 `ToolResultBlock(isError=true)` 还给模型，让它自己决定下一步 |

## 核心设计：Block 是语义，role 是传输细节

ch02 存的是"谁说了什么"：

```typescript
{ role: "assistant", content: [{ type: "tool_use", name: "calc", input: {...} }] }
{ role: "user", content: [{ type: "tool_result", content: "4" }] }
```

这在只接 Anthropic 时没问题。但 OpenAI 要求 tool_result 挂在 `role: "tool"` 下，Gemini 又不一样。如果 transcript 跟某个厂商的格式绑定死了，每接一家新厂商就得重写 transcript 处理逻辑。

ch03 换了个思路：**存"发生了什么"，不管"谁说的"**。4 种 Block 分别是：

| Block | 代表什么 | 关键字段 |
|---|---|---|
| `TextBlock` | 一段文本 | `text` |
| `ToolCallBlock` | 模型要调一个工具 | `id` / `name` / `args` |
| `ToolResultBlock` | 工具执行的结果 | `content` / `isError` |
| `ReasoningBlock` | 模型的推理过程 | `text` / `metadata` |

Message 的 `role` 只是传输标记——发出去的时候 adapter 按目标厂商的规则把它映射成对应的角色。Transcript 本身不关心你用哪家。

## 三个实际好处

### 1. 工具异常不再是核弹

ch02 里模型喊了个不存在的工具 → 直接抛异常，整个 loop 终止。ch03 里：

```typescript
try {
  result = tools[toolName](args);
} catch (e) {
  result = e.message;
  isError = true;  // ← 不是崩溃，是结构化反馈
}
```

模型在下一轮通过 `ToolResultBlock(isError=true)` 看到错误，可以重试、换工具、或告诉用户办不到。**agent 层不需要写 if-else 错误路由。**

### 2. 推理模型的"内心独白"有地方放

DeepSeek R1、Anthropic Extended Thinking 在给最终答案前会输出一段思考过程。ch02 的 `Record[]` 没有位置放这个——要么跟正常文本混在一起，要么丢掉。

ch03 的 `ReasoningBlock` 专门兜这个：

```typescript
// blocks: [ReasoningBlock("用户需要计算…"), TextBlock("答案是 42。")]
Message.assistantText("答案是 42。", reasoningBlock("用户需要计算…"));
```

后续 token 计费也能区分 `reasoningTokens`（推理 token 通常计费规则不同）。

### 3. 不可变历史 = 安全回滚

ch02 的 `Record[]` 任何人都能中间插一条消息，编译不报错。ch03 所有 Block 都是 `readonly`，只能通过 `transcript.append()` 追加。

想回滚一行搞定：

```typescript
const snapshot = [...transcript.messages]; // 浅拷贝 = 深拷贝（block 不可变）
// 跑了几轮模型跑偏了…
transcript.messages = snapshot; // 回到之前
```

## 跟 ch02 比，代价是什么

| 维度 | ch02 | ch03 |
|---|---|---|
| transcript | `Record[]`，无类型约束 | `Message[]`，编译期检查字段名 |
| 错误处理 | 抛了就崩 | try/catch → isError 反馈给模型 |
| 厂商适配 | transcript 格式与厂商绑定 | Block 语义 + adapter 映射 |
| 推理模型 | 不支持 | ReasoningBlock 预留 |
| system prompt | 不支持 | `Transcript.system` 字段 |
| 写代码的直观性 | 手写对象字面量，很直接 | 要调 factory 方法，啰嗦一点 |

**ch02 上手更快，但 ch03 的抽象层在接真实 LLM 时成本会收回来。**

## 仍然缺的（后续章节的事）

- 工具注册中心（现在还是 `Record<string, ToolFunction>` 直接传）
- 上下文窗口管理（transcript 无线增长）
- token 计数/压缩（ProviderResponse 已有字段但没人消费）
- 真实 LLM provider（只有 MockProvider）

## 一句话

> **ch03 把 transcript 从无类型对象升级为语义化的 Block 体系，让错误能传递、推理模型有位置、厂商适配可插拔，代价是多写几行 factory 调用。**
