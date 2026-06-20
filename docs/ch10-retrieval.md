# ch10-retrieval — 检索：Agent 驱动的、放在窗口末端的、显式成本的 RAG

**commit:** （下一个）
**tag:** ch10-retrieval

---

## 为什么需要这个

前情：scratchpad 给了 agent 它**自己产出**的内容的 durable state。它没覆盖的是 *agent 要读但不是它写的*：探索中的代码库、文档、一份比窗口本身还大的知识库。

**Retrieval 是 agent 在一个比 context 大的语料库上工作的方式。** 这个想法不新——Lewis et al. 2020 NeurIPS 那篇 *RAG* 就建立了"检索相关段落、注入 prompt、基于两者生成"的模式，所有生产检索系统都是它的后代。

但多数实现错过了 2020 之后的研究让它无可回避的一个微妙点：*检索不只是"拿到对的内容"，还是"把对的内容放在对的位置"*。Lost-in-the-Middle 是经过量化的——**一篇相关文档塞到 100K context 中间，得到的注意力比一份相关性更低但放在末尾的还少**。*召回率完美、答案还是糟糕*，是可能的。

---

## 3 条纪律

| # | 原则 | 含义 |
|---|------|------|
| ① | **Agent 驱动** | 由模型选何时检索，而非每回合自动注入 |
| ② | **Edge-placed** | 检索结果放在窗口末端（注意力最高处） |
| ③ | **显式成本** | 每次返回结果末附带 token 估算 |

---

## Lost-in-the-Middle：注意力在中间塌陷

```
检索准确率
  ^
  |  ~90%                    ~90%
  |   \                      /
  |    \     ~55%           /
  |     \      ▃▃▃▃▃      /
  |      \    ▃      ▃    /
  |       \  ▃        ▃  /
  |        \▃          ▃/
  +------------------------------→ 位置
   开头        中间        结尾
   system     history    current
   prompt     (旧 turn)  turn
```

把关键检索结果放在**窗口两端**——尾端优先。塞中间等于浪费 token。

---

## 朴素 RAG 错在哪

经典模式：每个 user turn 都 embed 用户消息、搜 vector store、拿 top-K、prepend 到 prompt。**多数教程到这里就停。**

| 问题 | 后果 |
|------|------|
| ① 不分需要不需要都检索 | 一个简单算术 prompt 也触发 vector search；top-K 结果无关；模型 context 里有**无关内容**——按 context rot，这 *降低* 而不是提升输出 |
| ② 位置错 | Prepend 到 system prompt 是最糟的位置——**历史一累积就是窗口中间**。U 形曲线咬人 |
| ③ Agent 看不见 | 搜得不好，模型不知道；它只知道 context 里有"奇怪的东西"。**Agent 驱动的检索工具意味着 agent 决定、看见结果、可以用更好的词重 query** |

---

## 索引：BM25 而不是 vector

本书场景**不需要 vector 数据库**。一个 BM25 索引在文本文档目录上——足够准、足够快，并且*跑起来不需要网络调用、不需要 embedding 模型*。

```shell
npm install --save rank-bm25  # (but we implement it inline)
```

### BM25 Okapi 公式

```
score(D, Q) = Σ  idf(t) * tf(t, D) * (k1 + 1) / (tf(t, D) + k1 * (1 - b + b * |D| / avgdl))
```

- **idf(t)** = log((N - n(t) + 0.5) / (n(t) + 0.5)) — 文档频率倒数的平滑版本
- **tf(t, D)** = term t 在文档 D 中的出现次数
- **|D|** = 文档长度（tokens）
- **avgdl** = 平均文档长度
- **k1 = 1.5** — 饱和度参数（控制 term frequency 的边际收益）
- **b = 0.75** — 长度归一化参数（0 = 无归一化，1 = 完全归一化）

### 4 个设计选择

**① 词级 chunk，~500 tokens，50 overlap**

本书场景够用。生产系统用 semantic chunking / sentence-aware splitters / 结构感知递归切。我们优化可读性而非 SOTA。**Overlap 防止切边丢信息**。

**② BM25 不是 embedding**

BM25 是"加强版 TF-IDF"。**在技术文档、代码、任何关键词富集的语料上效果惊人地好**。Embedding 在语义相似（释义查询）上更好，但需要模型、向量库、网络。*本书索引 5K 文档秒级、查询毫秒级*——这才是这里该有的工程预算。

**③ 过滤 0 分命中**

BM25 给每个 chunk 一个分，很多接近 0。返回它们会用"假装相关"的噪音污染 agent 的 context。我们 cap 在 k 并要求**正分**；query 匹配不到就*返回空*。

**④ Chunk 携带 doc_id + chunk_id**

Agent 看见每条命中来自哪。它可以在推理里回引 "`config.yaml` 的第三 chunk"；后续的 viewport reader 也能把整段渲染出来。

---

## search_docs 工具

```typescript
// src/harness/tools/retrieval.ts  (核心逻辑)
const definition: ToolDefinition = {
  name: "search_docs",
  description:
    "Search the document corpus for chunks matching a query. " +
    "query: keywords or a short sentence describing what you're " +
    "looking for. " +
    "k: number of hits to return (default 5, max 10). " +
    "Returns up to k hits, each with: doc_id, chunk_id, score, and " +
    "the chunk text. Chunks are ~500 tokens each; plan your context " +
    "budget before calling with k > 3. " +
    "After getting results, quote the relevant passages in your " +
    "reasoning — do not rely on memory of them across many turns. " +
    "If the first query is not useful, refine the query.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "..." },
      k: { type: "number", description: "...", default: 5 },
    },
    required: ["query"],
  },
};
```

### 工具描述里 3 条显式指令

- **点名成本**："chunks are ~500 tokens each"
- **上限 k**：max 10
- **结果最后一行带 token 估算**：`[5 hits, ~12500 chars (~3125 tokens)]`

最后这行是**刻意的**。没有它，agent 没法*感觉到*检索的成本。有了它，模型学会：*"这次 query 我花了 3K token；下次该综合，而不是再检索"*。

### 使用方式

```typescript
import { DocumentIndex, RetrievalInterface } from "./harness/index.js";
import { ToolRegistry } from "./harness/index.js";

const index = new DocumentIndex("./docs-corpus");
const retriever = new RetrievalInterface(index);
const registry = new ToolRegistry();
registry.register(...retriever.asTool());

// 通过 registry 执行
const result = registry.execute(
  "search_docs",
  { query: "How does compaction work?", k: 3 },
  "call-1",
);
console.log(result.content);
// → --- docs/ch08-compaction.md#0 (score=12.34) ---
//   Compaction reduces context window pressure...
//   [1 hits, ~500 chars (~125 tokens)]
```

---

## Edge placement——放在窗口末端

检索结果作为 `ToolResult` 回来，进 transcript 跟其它工具结果一样。**到下一回合，它已经在 history 里某个位置**。session 一长，它就在中间——最糟的位置。

### 解决方案：两条路

| 谁来放 | 做法 | 代价 |
|--------|------|------|
| Agent 自己 | Agent 在下一回合的推理里把命中*引用进自己的话*：「我找到：....基于此，我会...」。检索内容现在占据新鲜的 assistant-message 位置——窗口末端。 | 需要 agent 有这个纪律——靠 system prompt 教 |
| Harness 自动 | Harness 拦截检索结果，把它们作为"合成的最近消息"重新插入在下个 user turn 之前。 | 更侵入；可能让模型对"发生了什么"产生困惑 |

本书选**第一条**，加一点辅助：工具结果*结构化好*，方便 agent 原封不动 lift 出来。

---

## 什么时候检索会伤害你

| 问题 | 描述 | 缓解 |
|------|------|------|
| **Distractor 干扰** | Query 返回看起来相关但其实不相关的 chunk。模型抓住它们自信地**错答** | 抬高 score 阈值；缩小 k；更好的 chunk 边界 |
| **Query/文档错配** | 用户问 "rate limiting"；文档写 "throttling"；BM25 不知道它们同义 | Embedding 索引能处理；BM25 要 agent 用更广的词重 query |
| **Top-K 内部冗余** | 5 个命中里有 2 个是*重叠 chunk 的相同内容*。模型烧 token 在重复上 | 按 doc/chunk 邻近度去重，或加大 chunk size 减小 K |

---

## 混合检索（为何不建）

生产检索系统通常把 BM25（关键词精度）和 embedding（语义召回）通过 reciprocal rank fusion 结合。harness 直接支持——把 `DocumentIndex` 换成 hybrid 实现、保留同样的 search 方法——**但本书不需要**。我们跑的场景是关键词富集的（技术文档、代码、配置），BM25 在那些上面占优。

### 什么时候应该切换

| 场景 | 为什么 BM25 不够 |
|------|-------------------|
| 释义重度查询 | 用户问 'how do I make my agent remember things?'，文档写 'context persistence' |
| 跨语言 | 查询一种语言、文档另一种语言 |
| 超短文档 | 推文、SMS、短 FAQ——BM25 在短文本上饿死，TF 分量没东西可用 |

---

## 试一试

**① 索引这本书自己**

把 `DocumentIndex` 指向本书的 `docs/` 目录，问 agent："这个 harness 里 compaction 怎么工作？" 检索找到第 8 章了吗？**没有的话——chunking 还是 query 错了？**

**② 压力测试**

索引 10000+ 文件的目录（克隆的开源项目）。计时索引构建和查询。可以接受吗？**不行的话——你会先 profile 哪一段？**

**③ 建一个 distractor 测试**

索引两个目录——一个是 topic-A，一个是*无关* topic-B。问一个答案在 A 的问题。统计 B 的 chunk 出现在 top-5 的频率。**这就是你的 distractor rate**——告诉你要不要抬阈值或重写 chunk。

---

## 参考

- Lewis et al. 2020 — *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks* (NeurIPS)
- Robertson & Zaragoza 2009 — *The Probabilistic Relevance Framework: BM25 and Beyond* (FnTIR)
- Liu et al. 2023 — *Lost in the Middle: How Language Models Use Long Contexts* (arXiv:2307.03172)
