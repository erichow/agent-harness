# ch01-skeleton / ch02-minimal-loop

---

## ch01-skeleton — 工程骨架

**commit:** deeb7a5
**tag:** ch01-skeleton

### 解决了什么

什么也没解决。这个 tag 的存在意义是：**让 `npm install && npm test` 能通过**。

TypeScript 项目有一堆 boilerplate 要搭——`package.json`（ESM 模式）、`tsconfig.json`（ES2022 + bundler 解析）、`vitest` 配置、`.gitignore`。ch01 就是把这些一次性做完，以后不会因为"咦为什么 import 报错"而停下来。

### 有什么

| 文件 | 干什么 |
|---|---|
| `package.json` | ESM + TypeScript + Vitest，最简依赖 |
| `tsconfig.json` | 目标 ES2022，模块解析 bundler 模式 |
| `vitest.config.ts` | 测试框架配置 |
| `src/harness/index.ts` | 唯一导出：`VERSION = "0.1.0"` |
| `tests/test_smoke.ts` | 验证 VERSION 存在 + Node >= 20 |

没有 agent 逻辑，没有 provider，没有工具系统。README 画了一张未来蓝图（agent.ts、messages.ts、providers/、tools/、context/），但 ch01 里**一个都没有**。

### 设计要点

- **ESM + bundler 模式** — 兼容 tsx / vitest 这些现代运行器，开发时不用编译
- **先搭测试** — 烟雾测试先确保导入链路是通的，后续新增逻辑时立刻有反馈
- **README 故意超前画图** — 让读者知道"这里以后会长什么"，每一章看到目录出现时不会惊讶

### 一句话

> ch01 只是脚手架——让你能跑 `npm test`，然后心安理得地开始写真正的代码。

---

## ch02-minimal-loop — 最小可用 Agent 循环

**commit:** dc01bda
**tag:** ch02-minimal-loop

### 解决了什么

ch01 只有一个空壳。ch02 把**核心循环**写出来了——让一个"模型 + 工具"的对话闭环跑通第一遍。

### 怎么工作

```
用户说"帮我算 2+2"
      ↓
┌─────────────────────────────────────────┐
│        Provider.complete(transcript)     │
│            ↑                      ↓      │
│        transcript ← response             │
│                                          │
│  if response == text:  → 返回答案（结束）│
│  if response == tool_call:               │
│     → 调工具 → 记结果 → continue         │
│  if 超了 20 轮:  → 抛异常                │
└─────────────────────────────────────────┘
```

三件事：问模型 → 看它是想给答案还是调工具 → 调完工具把结果写回去继续问。

### 为什么这样设计

**1. Provider 协议把模型厂商切在外面**

```typescript
interface Provider {
  complete(transcript, tools): ProviderResponse;
}
```

loop 不关心背后是 OpenAI 还是 Anthropic 还是假数据——只要实现 `complete()` 就算是个 Provider。这样写循环的时候不用等真实 API key，拿个 mock 就能跑。

**2. 先写 mock 再写真实 provider**

```typescript
class MockProvider {
  constructor(responses: ProviderResponse[]) // 预设响应列表
  complete(): ProviderResponse              // 顺序返回
}
```

离线、确定性、零成本。写循环逻辑时先用 mock 把各种路径测通，再接入真实 API。这是一个教学上的关键决策：**先让循环逻辑正确，再操心网络问题。**

**3. 刻意朴素**

ch02 的循环只有 40 行，注释里自己说了：

> "这是朴素版——它马上就要以 5 种方式破。"

这 5 种破法是：

| 问题 | 为什么是问题 |
|---|---|
| transcript 是 `Record[]` | 工具调用和文本回答在代码里长一个样，接新厂商要重写 |
| 没有工具注册中心 | tools 直接传 map，没法校验 schema、没法自动发现 |
| 错误直接 throw | 模型叫了不存在的工具 → 整个循环崩 |
| transcript 无线增长 | 长对话迟早撑爆上下文窗口 |
| 没有 token 计数 | 没法知道花了多少钱、还剩多少空间 |

ch02 故意不修它们——让每个问题在实际跑的时候自己暴露出来，然后 ch03 逐个解决。

### 跟 ch01 比多了什么

| 维度 | ch01 | ch02 |
|---|---|---|
| 逻辑代码 | 0 行（只导出 VERSION） | ~60 行 agent 循环 |
| Provider 协议 | 无 | `interface Provider` + `MockProvider` |
| transcript | 无 | `Record[]` 简单消息数组 |
| 测试 | 2 个烟雾测试 | 4 个测试（覆盖 text / tool / unknown / 超限） |
| 工具系统 | 无 | 基本的 `Record<string, ToolFunction>` 调度 |

ch01 到 ch02 是纯增量——`index.ts` 一行没改，只加了新文件。

### 代价

就是那 5 个不解决的问题。为了让循环先跑起来，牺牲了类型安全、错误恢复、上下文管理。这些是 ch03 开始逐个补的。

### 一句话

> ch02 用一个 40 行循环和一个 30 行 mock，让"问模型 → 调工具 → 给答案"这条线跑通了——代价是 5 个设计债，ch03 开始还。
