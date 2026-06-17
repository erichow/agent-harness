# 构建 AI Agent Harness · JavaScript 版

> 从《构建 AI Agent Harness · 可视化学习教程》改编  
> 原教程使用 Python 3.11+，本仓库逐章转写为 TypeScript

## 项目布局

```
agent-harness/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   └── harness/
│       ├── index.ts           # 入口
│       ├── agent.ts           # 循环 (第 2 章)
│       ├── messages.ts        # 有类型的 transcript (第 3 章)
│       ├── providers/         # provider 适配器 (第 3 章)
│       │   ├── base.ts        # Provider 协议
│       │   └── mock.ts        # 内存假实现
│       ├── tools/             # 工具协议 + 注册表 (第 4-5 章)
│       └── context/           # 上下文记账 + 压缩 (第 7-11 章)
├── tests/
└── examples/
```

## 快速开始

```bash
npm install
npm test
```
