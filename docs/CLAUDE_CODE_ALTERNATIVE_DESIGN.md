# 基于agent-harness构建Claude Code替代品设计方案

## 当前框架能力总结

| 模块 | 已实现 | 价值 |
|------|--------|------|
| **Agent 循环** | ✅ `arun()` | 思考、工具调用、多轮对话 |
| **消息系统** | ✅ `Transcript` | 类型化、不可变对话历史 |
| **工具注册表** | ✅ `ToolRegistry` | 工具发现、动态注册 |
| **流式中断** | ✅ `StreamEvent` | 实时反馈 |
| **上下文管理** | ✅ `ContextAccountant` | token 计数、窗口控制 |
| **工具压缩** | ✅ `Compactor` | 保留重要信息 |
| **工具选择器** | ✅ `ToolCatalog` | 智能工具选取 |
| **权限管理** | ✅ `PermissionManager` | 安全执行沙盒 |
| **可观测性** | ✅ `Tracing` | OTel集成 |
| **评测系统** | ✅ `EvalRunner` | 自动评测 |
| **成本控制** | ✅ `BudgetEnforcer` | Token预算 |
| **可恢复性** | ✅ `Checkpointer` | 断点续传 |
| **MCP集成** | ✅ `MCPClient` | 协议支持 |

---

## Claude Code 需要的核心工具

### 1. 文件系统工具

**当前状态**: 部分实现 (viewport + 行编辑)

**需要补充**:
```typescript
// src/harness/tools/files.ts (扩展)
const toolDefinitions = {
  // Viewport (已有)
  read_file_viewport,

  // 行编辑 (已有)
  edit_lines,

  // 新增
  create_file: {
    name: "create_file",
    description: "Create a new file with content",
    inputSchema: { /* path, content */ },
  },

  delete_file: {
    name: "delete_file",
    description: "Delete a file or directory",
  },

  list_directory: {
    name: "list_directory",
    description: "List files in a directory",
  },

  glob_pattern: {
    name: "glob_pattern",
    description: "Find files matching a pattern",
  },

  get_file_info: {
    name: "get_file_info",
    description: "Get file metadata (size, mtime, etc.)",
  },

  find_text_in_files: {
    name: "find_text_in_files",
    description: "Search for text across multiple files",
  },

  extract_code_context: {
    name: "extract_code_context",
    description: "Extract code blocks from file (git diff aware)",
  },
};
```

### 2. Git 工具

**当前状态**: 未实现

```typescript
// src/harness/tools/git.ts (新建)
import * as git from "simple-git";

export const gitToolDefinitions = {
  git_status: {
    name: "git_status",
    description: "Show git status (uncommitted changes, branches)",
  },

  git_diff: {
    name: "git_diff",
    description: "Show diff for modified files",
  },

  git_log: {
    name: "git_log",
    description: "Show commit history for a file/branch",
  },

  git_commit: {
    name: "git_commit",
    description: "Stage and commit changes",
    inputSchema: { message: string, all?: boolean },
  },

  git_stash: {
    name: "git_stash",
    description: "Stash changes for later",
  },

  git_branch: {
    name: "git_branch",
    description: "Create/switch/delete branches",
  },

  git_push: {
    name: "git_push",
    description: "Push to remote",
  },

  git_pull: {
    name: "git_pull",
    description: "Pull from remote",
  },
};
```

### 3. 终端工具

**当前状态**: 未实现

```typescript
// src/harness/tools/terminal.ts (新建)
import { spawn } from "child_process";
import { PermissionManager } from "../permissions/manager.js";

export const terminalToolDefinitions = {
  run_command: {
    name: "run_command",
    description: "Execute shell command with output capture",
    inputSchema: { command: string, cwd?: string, timeout?: number },
  },

  run_command_async: {
    name: "run_command_async",
    description: "Execute command and stream output",
  },

  which_command: {
    name: "which_command",
    description: "Check if command exists",
  },

  shell_completion: {
    name: "shell_completion",
    description: "Get shell completions for a command",
  },
};
```

### 4. 语言服务器协议 (LSP) 工具

**当前状态**: 未实现

```typescript
// src/harness/tools/lsp.ts (新建)
import { createConnection } from "vscode-languageserver/node";

export const lspToolDefinitions = {
  lsp_completion: {
    name: "lsp_completion",
    description: "Get code completions at cursor",
  },

  lsp_definition: {
    name: "lsp_definition",
    description: "Go to definition",
  },

  lsp_references: {
    name: "lsp_references",
    description: "Find all references",
  },

  lsp_hover: {
    name: "lsp_hover",
    description: "Get hover documentation",
  },

  lsp_signature_help: {
    name: "lsp_signature_help",
    description: "Get function signature",
  },

  lsp_diagnostic: {
    name: "lsp_diagnostic",
    description: "Get all diagnostics for file",
  },
};
```

### 5. 代码分析工具

**当前状态**: 部分实现

```typescript
// src/harness/tools/code_analysis.ts (新建)
import type { ToolRegistry } from "./registry.js";

export function registerCodeAnalysisTools(registry: ToolRegistry) {
  // AST 解析
  registry.register({
    name: "parse_ast",
    description: "Parse code into AST (only for supported languages)",
  }, handler);

  // 依赖关系分析
  registry.register({
    name: "analyze_dependencies",
    description: "Find all dependencies of a file",
  }, handler);

  // 代码复杂度分析
  registry.register({
    name: "analyze_complexity",
    description: "Calculate cyclomatic complexity",
  }, handler);

  // 代码模式识别
  registry.register({
    name: "find_patterns",
    description: "Find common code patterns",
  }, handler);

  // 安全漏洞扫描
  registry.register({
    name: "scan_security",
    description: "Check for security vulnerabilities",
  }, handler);
}
```

### 6. 上下文管理增强

**当前状态**: 基础压缩

```typescript
// src/harness/context/code_context.ts (新建)
export class CodeContextManager {
  // 代码 diff 视图
  async getDiffView(): Promise<string>;

  // 文件语义摘要
  async getFileSemanticSummary(filePath: string): Promise<string>;

  // 项目结构缓存
  async buildProjectStructure(): Promise<ProjectTree>;

  // 重点关注文件
  async identifyImportantFiles(): Promise<File[]>;

  // 上下文预算分配
  allocateBudget(
    file: File,
    requestType: RequestType
  ): BudgetAllocation;
}
```

### 7. UI/交互工具

**当前状态**: 未实现

```typescript
// src/harness/tools/ui.ts (新建)
export const uiToolDefinitions = {
  // 显示文件内容（带行号）
  show_file_content: {
    name: "show_file_content",
    description: "Render file with syntax highlighting and line numbers",
  },

  // 显示 diff 视图
  show_diff_view: {
    name: "show_diff_view",
    description: "Render unified diff with interactive navigation",
  },

  // 进度条
  show_progress: {
    name: "show_progress",
    description: "Display progress bar",
  },

  // 确认对话框
  confirm_dialog: {
    name: "confirm_dialog",
    description: "Get user confirmation",
    inputSchema: { message: string, options?: string[] },
  },

  // 输入框
  input_dialog: {
    name: "input_dialog",
    description: "Get user input",
    inputSchema: { message: string, defaultValue?: string },
  },
};
```

---

## 架构集成

### 主应用入口

```typescript
// src/cli/main.ts (新建)
import { arun } from "../harness/agent.js";
import { ToolRegistry } from "../harness/tools/registry.js";
import { ContextAccountant } from "../harness/context/accountant.js";
import { Compactor } from "../harness/context/compactor.js";
import { PermissionManager } from "../harness/permissions/manager.js";
import * as gitTools from "../harness/tools/git.js";
import * as fileTools from "../harness/tools/files.js";
import * as terminalTools from "../harness/tools/terminal.js";
import * as lspTools from "../harness/tools/lsp.js";
import * as uiTools from "../harness/tools/ui.js";
import * as codeAnalysis from "../harness/tools/code_analysis.js";

export async function runAgentCLI() {
  const registry = new ToolRegistry();

  // 注册所有工具
  registry.register(...gitTools.definitions);
  registry.register(...fileTools.definitions);
  registry.register(...terminalTools.definitions);
  registry.register(...lspTools.definitions);
  registry.register(...uiTools.definitions);
  registry.register(...codeAnalysis.tools);

  // 权限管理
  const permissionManager = new PermissionManager();

  // 上下文管理
  const accountant = new ContextAccountant();
  const compactor = new Compactor(accountant, provider);

  // 运行 agent
  const response = await arun(
    provider,
    registry,
    userPrompt,
    transcript,
    systemPrompt,
    onEvent,
    onToolCall,
    onToolResult,
    onSnapshot,
    accountant,
    compactor,
    onCompaction,
    pinnedTools,
    toolsPerTurn,
  );

  return response;
}
```

### 权限策略

```typescript
// 需要的安全策略
const securityPolicy = compose([
  // 文件系统：只允许操作当前工作目录
  pathAllowlist({
    base: process.cwd(),
    allowWrite: true,
    allowDelete: false, // 删除需要额外确认
  }),

  // 终端：需要确认
  bySideEffect(async (req: PermissionRequest) => {
    if (req.action.startsWith("run_command")) {
      return await defaultCliPrompt(req);
    }
    return allowAll();
  }),

  // Git：需要确认所有更改
  bySideEffect(async (req: PermissionRequest) => {
    if (req.action.startsWith("git_")) {
      return await defaultCliPrompt(req);
    }
    return allowAll();
  }),
]);
```

### 配置系统

```typescript
// src/config/config.ts (新建)
export interface AgentConfig {
  model: string;
  temperature: number;
  maxIterations: number;
  maxContextSize: number;
  tools: string[];
  permissions: PermissionConfig;
  tracing: boolean;
  budget: {
    enabled: boolean;
    maxTokens: number;
  };
}

export function loadConfig(): AgentConfig {
  return {
    model: process.env.MODEL || "claude-sonnet-4-6",
    temperature: parseFloat(process.env.TEMPERATURE || "0.7"),
    maxIterations: parseInt(process.env.MAX_ITERATIONS || "20"),
    maxContextSize: parseInt(process.env.MAX_CONTEXT_SIZE || "100000"),
    tools: (process.env.TOOLS || "all").split(","),
    permissions: {
      fileWrite: true,
      fileDelete: false,
      terminal: true,
      git: true,
    },
    tracing: process.env.TRACING === "true",
    budget: {
      enabled: process.env.BUDGET_ENABLED === "true",
      maxTokens: parseInt(process.env.MAX_TOKENS || "100000"),
    },
  };
}
```

---

## 实现路线图

### Phase 1: 核心工具集 (1-2周)

- [x] 文件工具扩展 (create, delete, list, glob, find)
- [ ] Git 工具完整实现
- [ ] 终端工具实现
- [ ] 权限策略完善

### Phase 2: 代码分析 (1周)

- [ ] LSP 工具集成
- [ ] AST 解析工具
- [ ] 依赖分析工具
- [ ] 复杂度分析工具

### Phase 3: 上下文优化 (1周)

- [ ] 代码上下文管理器
- [ ] 项目结构缓存
- [ ] 智能预算分配

### Phase 4: CLI 构建 (1周)

- [ ] 命令行界面
- [ ] 配置系统
- [ ] 日志/输出格式
- [ ] 帮助系统

### Phase 5: UI 集成 (2周)

- [ ] Web 界面
- [ ] 交互式 diff 视图
- [ ] 实时进度显示
- [ ] 历史记录

---

## 与 Claude Code 的功能对比

| 功能 | Claude Code | Agent Harness 实现 |
|------|-------------|-------------------|
| 文件编辑 | ✅ | ✅ (viewport + edit) |
| Git 操作 | ✅ | 🔄 (需要实现) |
| 终端执行 | ✅ | 🔄 (需要实现) |
| LSP 支持 | ✅ | 🔄 (需要实现) |
| 代码分析 | ✅ | 🔄 (需要实现) |
| 上下文管理 | ✅ | ✅ (已有压缩) |
| 思考模式 | ✅ | ✅ (ReasoningBlock) |
| 多轮对话 | ✅ | ✅ (Transcript) |
| 工具调用 | ✅ | ✅ (ToolRegistry) |
| 安全沙盒 | ✅ | ✅ (PermissionManager) |
| 成本控制 | ✅ | ✅ (BudgetEnforcer) |
| 可观测性 | ✅ | ✅ (OTel) |

**差距**: Git、终端、LSP、代码分析工具

**优势**: 已有完整框架、可测试、可调试、可扩展

---

## 关键技术决策

### 1. 为什么用 agent-harness 而不是从零开始？

- ✅ 已有 22 章教程，经过验证
- ✅ 类型安全 + TypeScript
- ✅ 完整的工具系统
- ✅ 权限管理、可观测性、评测系统
- ✅ 可扩展的架构

### 2. 需要额外集成的库

| 功能 | 库选择 | 原因 |
|------|--------|------|
| Git | simple-git | 轻量、易用 |
| LSP | vscode-languageserver | 标准、稳定 |
| 代码解析 | ts-morph / ast-kit | 类型安全 |
| 终端 | node:child_process | 原生支持 |
| 语法高亮 | shiki / highlight.js | 视觉体验 |

### 3. 部署模式

**CLI 版本**:
```bash
npx @your-username/agent-code
```

**VS Code 插件**:
```typescript
// 使用 agent-harness 作为 core
import { arun } from "agent-harness";
// 注入 VS Code API 作为工具
```

**Web 版本**:
```typescript
// 使用 agent-harness + 简单前端
import { arun } from "agent-harness";
// 通过 WebSocket 实时通信
```

---

## 总结

agent-harness 已经提供了构建 Claude Code 所需的**核心框架**，只需要实现以下工具即可：

1. **Git 工具** (6-8个工具)
2. **终端工具** (4-5个工具)
3. **LSP 工具** (5-6个工具)
4. **代码分析工具** (5-6个工具)
5. **UI 工具** (3-4个工具)

预计 **4-6周** 可完成 MVP 版本。

关键优势：
- 安全性：权限管理 + 沙盒执行
- 可观测性：OTel 集成
- 可测试性：完整的测试套件
- 可扩展性：模块化架构
- 可调试性：流式中断 + 思考过程可见
