# ch09-scratchpad — 外部状态：草稿本

**commit:** （下一个）
**tag:** ch09-scratchpad

---

> **一句话：基于文件系统的持久化 KV 存储，通过 3 个工具暴露给 agent——write / read / list——让 agent 自己决定什么值得持久化，而不是靠 compactor 猜测。**

---

## 解决了什么

ch08 的 compactor 能压缩 transcript，但 **agent 想原样保留的任何东西都受 compactor 摆布**。一个计划、一个发现、一个想坚持的决定——这些不应该在 context window 里，而应该在 agent 能按需读取的、压缩动不到的、durable 的存储里。

**核心洞察：** 能在压缩中存活的状态，是**从来不在 context 里**的状态。

### 为什么不直接用更长的窗口？

| 问题 | 说明 |
|------|------|
| Compactor 不会分辨 | 教 compactor "保留重要内容" 会把分类关切耦合到压缩层 |
| Context 不跨进程 | Harness 崩、用户明天回来——context 没了。文件还在磁盘上 |
| 成本 | 2000-token plan 在 30 个 turn 中只用 3 次→ 60000 vs 6000 tokens（10× 节省） |

---

## 新增了什么

### 9.1 — Scratchpad 类

```typescript
export class Scratchpad {
  constructor(root: string = ".scratchpad") {}

  write(key: string, content: string): string
  read(key: string): string
  list(): string[]
}
```

### 9.2 — Key 消毒

```typescript
private _sanitize(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "");
  if (safe !== key) throw new Error(`invalid key ${key}: use [A-Za-z0-9_-]+`);
  if (!safe) throw new Error("key cannot be empty");
  return safe;
}
```

拒绝含 `/` 或 `.` 的 key（防止路径遍历），模型很快学会用 `plan`、`findings-os`、`port-decision` 这类约定。

### 9.3 — asTools()

```typescript
const pad = new Scratchpad(".scratchpad");
for (const [def, handler] of pad.asTools()) {
  registry.register(def, handler);
}
```

3 个工具：`scratchpad_write`、`scratchpad_read`、`scratchpad_list`，闭包捕获 pad 实例。

### 9.4 — System Prompt 教学

Agent 需要知道 scratchpad **存在** 以及 **什么时候用**。Tool description 说"这个工具做什么"，system prompt 说"什么时候去拿它"。

典型的 system prompt 教 agent：
- 每次 session 开始时调 `scratchpad_list()`
- 发现重要信息立即 `scratchpad_write()`
- 迷茫时 `scratchpad_read('plan')`

---

## 架构变化

```
tools/scratchpad.ts
  └─ Scratchpad class
       ├─ write(key, content)    → .scratchpad/{key}.txt
       ├─ read(key)              → .scratchpad/{key}.txt
       ├─ list()                 → *.txt 文件列表
       └─ asTools()              → [ToolDef, Handler][] 注册
              │
         ToolRegistry.register()
              │
         agent 通过工具接口访问
```

## 测试覆盖

```
ch09_scratchpad.test.ts — 12 tests
├─ write / read (3)
│  ├─ 基本读写
│  ├─ 覆盖已存在 key
│  └─ 长文本精确回读
├─ key 消毒 (4)
│  ├─ 拒绝斜杠（路径遍历）
│  ├─ 拒绝点
│  ├─ 拒绝空 key
│  └─ 允许字母数字短横线下划线
├─ list (2)
│  ├─ 排序
│  └─ 空目录
├─ read 错误 (1)
│  └─ 不存在 → 抛错
└─ asTools (2)
   ├─ 返回 3 个工具
   └─ 通过 registry 执行
```

---

## 一句话

> ch09 的 Scratchpad 让 agent 自己决定什么值得持久化——一个目录加 3 个工具，比任何 compactor 启发式都可靠。**Compactor 是个清洁工；Scratchpad 是个保险箱。**
