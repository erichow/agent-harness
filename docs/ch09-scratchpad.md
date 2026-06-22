# ch09-scratchpad — 外部状态：草稿本

**commit:** （下一个）
**tag:** ch09-scratchpad

## 为什么需要这个

前几章我们解决了窗口撑爆的问题——compactor 会自动压缩旧内容。但有个矛盾：

**Compactor 是个清洁工，它分不清什么是垃圾，什么是宝贝。**

如果你在调试一个服务器，第 3 步发现"端口 8080 被占了，改用 8081"，这个信息第 20 步还要用。但 compactor 不会知道它重要——它只看到"旧对话"，可能把它压缩掉。

解决方案不是教 compactor 变得更聪明，而是**让重要的东西根本不在对话窗口里**。

---

## 怎么解决的

### Scratchpad：写在磁盘上，不写在对话里

Scratchpad 就是一个目录，里面是一些文本文件。Agent 通过 3 个操作来读写：

- **scratchpad_write(key, content)** — "把这个发现存到草稿本里，标题是 `port-decision`"
- **scratchpad_read(key)** — "把 `port-decision` 的内容给我看看"
- **scratchpad_list()** — "草稿本里现在有哪些内容？"

跟你的便签 app 一样——写了不会丢，翻回去就能找到。

> **为什么不用对话内容本身？** 对话是"短期记忆"，compactor 随时可能压缩它。scratchpad 是"长期存储"——文件在磁盘上，compactor 动不了，session 重启也不会丢。

### 三件事，对话做不到，文件做到了

**1. Compactor 动不了它**

对话窗口里的内容会被压缩。磁盘上的文件不会。Agent 把重要发现写进 scratchpad，compactor 再怎么压缩对话都不会影响它。

**2. 跨 session 存活**

Agent 跑崩了、你关掉终端明天再开——对话没了。但 scratchpad 文件还在磁盘上。新 session 的 agent 一启动先 `list`，看到昨天的 `plan`、`findings-os`、`port-decision`，就知道自己昨天做过什么。

**3. 省钱**

一段 2000 字的计划如果塞在对话里，每一轮模型都要重读它——30 轮就是 60000 token 的浪费。如果存在 scratchpad 里、只在需要时读 3 次，只用 6000 token。**10 倍的差距。**

> **三件事都是"对话做不到"的事，不是"做得差"的事。** 第一个是压缩不可控，第二个是 session 边界，第三个是每次全量重读。Scratchpad 能做的不是"更好"，而是"对话根本做不了"。

### 安全设计：一道门

Agent 是模型在操控，你没法保证它不乱来。所以 scratchpad 加了一道门：

**文件名不能含有 `/` 或 `.`。**

如果 agent 试图写 `../../etc/passwd` 作为标题，系统会直接拒绝——防止它利用这个工具写到系统目录去。Agent 很快学会用 `plan`、`findings-cpu`、`port-decision` 这种干净的标题。

> **为什么不是白名单？** 黑名单（拒绝 `/` 和 `.`）足够简单且有效。白名单需要维护一个合法字符列表，agent 记不住，反而容易误杀合理文件名。

### 怎么教 agent 用

写一条 system prompt 告诉 agent scratchpad 的存在和用法。效果天差地别：

- ❌ 不教：agent 偶尔用，不系统化
- ✅ 教了：复杂任务开头先写 `plan`，迷茫时读回去，发现存下来

**最好的 analogy：** 把你笔记本上的草稿本给 agent——"重要的写在这里，不会被清掉"。

### 流程图

```mermaid
flowchart TB
    subgraph "Agent 视角"
        Write["scratchpad_write(key, content)<br/>→ 存入磁盘"]
        Read["scratchpad_read(key)<br/>→ 从磁盘读取"]
        List["scratchpad_list()<br/>→ 列出所有 key"]
    end

    subgraph "Scratchpad 内部"
        Sanitize["key 消毒<br/>拒绝 / 和 .<br/>防止路径遍历"]
        Store["磁盘文件<br/>.scratchpad/<key>.txt"]
    end

    subgraph "对比: Context 中的内容"
        InContext["Transcript 中的内容<br/>会被 compactor 压缩"]
        Compactor["Compactor<br/>mask / summarize"]
        InContext -->|压缩| Compactor
    end

    Write --> Sanitize --> Store
    Read --> Sanitize --> Store
    List --> Store

    Store -.->|压缩动不了它| Survive[跨 session 存活 ✅]

    style Store fill:#90EE90
    style Compactor fill:#FFB6B6
    style Survive fill:#90EE90
```

> **和第八章的关系：** compactor 是"压缩旧对话"，scratchpad 是"让重要内容根本不在对话里"。两者互补——一个处理用过的信息，一个保护未来的需要。
