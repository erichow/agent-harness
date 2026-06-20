/**
 * MCP 客户端 — JSON-RPC 2.0 over stdio（第 13 章）
 *
 * 通过子进程 + stdio pipe 与 MCP 服务器通信。
 * 不依赖 MCP SDK——协议简单到只需要裸 JSON-RPC。
 *
 * MCP 协议 3 类消息：
 *   1. initialize（握手 + 版本协商）→ initialized（通知）
 *   2. tools/list（一次性工具发现）
 *   3. tools/call（每次工具调用）
 *
 * 安全警告：MCP 是集成标准，不是安全边界。
 * 第 14 章加权限层前，不要用于聚集敏感凭据的服务器。
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";

/* ─── 类型 ────────────────────────────────────────────────────────── */

export interface MCPServerConfig {
  /** 逻辑名称，用于工具名前缀（如 "github" → mcp__github__） */
  name: string;
  /** 启动命令（如 "npx"） */
  command: string;
  /** 命令参数（如 ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]） */
  args: string[];
  /** 环境变量（可选） */
  env?: Record<string, string>;
}

export interface MCPTool {
  /** 服务器限定名：mcp__<server>__<tool> */
  name: string;
  /** 服务器原始名 */
  rawName: string;
  /** 所属服务器名 */
  server: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** JSON-RPC 2.0 请求 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 响应 */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/* ─── MCPClient ──────────────────────────────────────────────────── */

export class MCPClient {
  private _processes: Map<string, ChildProcess> = new Map();
  private _sessions: Map<string, { requestId: number }> = new Map();
  private _tools: Map<string, MCPTool> = new Map();
  private _readers: Map<string, readline.Interface> = new Map();
  private _pending: Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }> = new Map();
  private _globalId = 0;

  /**
   * 连接一台 MCP 服务器。
   * spawn 子进程、握手、discover 工具。
   */
  async connect(config: MCPServerConfig): Promise<void> {
    const serverName = config.name;

    // 启动子进程
    const proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    this._processes.set(serverName, proc);

    // 读 stdout（JSON-RPC 行）
    const rl = readline.createInterface({ input: proc.stdout! });
    this._readers.set(serverName, rl);

    rl.on("line", (line: string) => {
      line = line.trim();
      if (!line) return;
      try {
        const msg: JsonRpcResponse = JSON.parse(line);
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const { resolve } = this._pending.get(msg.id)!;
          this._pending.delete(msg.id);
          resolve(msg);
        }
        // 忽略 notification（没有 id 的消息）
      } catch {
        // 非 JSON 行忽略（MCP server 可能打日志）
      }
    });

    // 错误处理
    proc.on("error", (err) => {
      console.error(`[mcp:${serverName}] process error:`, err.message);
    });

    this._sessions.set(serverName, { requestId: 0 });

    // 握手：initialize
    const initResult = await this._sendRequest(serverName, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "agent-harness",
        version: "0.1.0",
      },
    });

    if (initResult.error) {
      throw new Error(
        `MCP initialize failed for ${serverName}: ${initResult.error.message}`,
      );
    }

    // 通知：initialized
    this._sendNotification(serverName, "notifications/initialized");

    // 发现工具：tools/list
    const listResult = await this._sendRequest(serverName, "tools/list");

    if (listResult.error) {
      throw new Error(
        `MCP tools/list failed for ${serverName}: ${listResult.error.message}`,
      );
    }

    const listData = listResult.result as { tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }> };

    if (listData?.tools) {
      for (const rawTool of listData.tools) {
        const qualified = `mcp__${serverName}__${rawTool.name}`;
        const mcpTool: MCPTool = {
          name: qualified,
          rawName: rawTool.name,
          server: serverName,
          description: rawTool.description ?? "",
          inputSchema: rawTool.inputSchema ?? { type: "object", properties: {} },
        };
        this._tools.set(qualified, mcpTool);
      }
    }
  }

  /**
   * 调用一个 MCP 工具。
   * @param qualifiedName - 完全限定工具名（mcp__<server>__<tool>）
   * @param args - 工具参数
   * @returns 工具结果文本
   */
  async call(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this._tools.get(qualifiedName);
    if (!tool) {
      throw new Error(`unknown MCP tool: ${qualifiedName}`);
    }

    const result = await this._sendRequest(tool.server, "tools/call", {
      name: tool.rawName,
      arguments: args,
    });

    if (result.error) {
      throw new Error(
        `MCP tools/call failed for ${qualifiedName}: ${result.error.message}`,
      );
    }

    const callResult = result.result as { content?: Array<{ type?: string; text?: string }> };
    const parts: string[] = [];

    if (callResult?.content) {
      for (const c of callResult.content) {
        if (c.type === "text" && c.text !== undefined) {
          parts.push(c.text);
        } else {
          parts.push(JSON.stringify(c));
        }
      }
    }

    return parts.join("\n");
  }

  /** 列出所有已发现的 MCP 工具 */
  listTools(): MCPTool[] {
    return Array.from(this._tools.values());
  }

  /** 按名称获取 MCP 工具 */
  getTool(name: string): MCPTool | undefined {
    return this._tools.get(name);
  }

  /** 关闭所有连接 */
  async close(): Promise<void> {
    for (const [name, proc] of this._processes) {
      const rl = this._readers.get(name);
      if (rl) rl.close();
      if (!proc.killed) {
        proc.kill();
      }
    }
    this._processes.clear();
    this._sessions.clear();
    this._readers.clear();
    this._tools.clear();
    this._pending.clear();
  }

  /* ─── 内部：JSON-RPC 通信 ──────────────────────────────────── */

  /** 发送 JSON-RPC 请求并等待响应 */
  private async _sendRequest(
    server: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const id = ++this._globalId;
    const proc = this._processes.get(server);
    if (!proc || !proc.stdin) {
      throw new Error(`MCP server not connected: ${server}`);
    }

    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params) request.params = params;

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} on ${server}`));
      }, 30_000);

      this._pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timeout);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      proc.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  /** 发送 JSON-RPC notification（无响应期望） */
  private _sendNotification(
    server: string,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    const proc = this._processes.get(server);
    if (!proc || !proc.stdin) return;

    const notification: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 0,
      method,
    };
    if (params) notification.params = params;

    proc.stdin.write(JSON.stringify(notification) + "\n");
  }
}
