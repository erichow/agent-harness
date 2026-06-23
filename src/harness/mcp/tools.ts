/**
 * MCP 工具包装器（第 13 章）
 *
 * 将 MCPClient 发现的 MCPTool 列表包装为 CatalogEntry，
 * 使 MCP 工具像本地工具一样通过 ToolRegistry / ToolCatalog 使用。
 *
 * 设计：
 *   - 工具名使用 mcp__<server>__<tool> 前缀（防碰撞 + 来源可见）
 *   - 默认 side_effects = network + mutate（悲观默认）
 *   - 异步 handler——MCP 调用本质是 async IO
 */
import type { CatalogEntry } from "../tools/selector.js";
import type { ToolDefinition } from "../tools/registry.js";
import { MCPClient } from "./client.js";

/**
 * 将 MCPClient 中的所有工具包装为 CatalogEntry 列表。
 *
 * @param client - 已连接（已 discover 工具）的 MCPClient
 * @returns 可用于 ToolCatalog 的 CatalogEntry 数组
 */
export function wrapMcpTools(client: MCPClient): CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  for (const mcpTool of client.listTools()) {
    // MCP 工具默认标记为 network + mutate（悲观安全默认）
    // 有 per-tool 元数据时可以覆盖
    const sideEffectsNote = "Side effects: network, mutate (default — pessimistic for external tools)";

    const definition: ToolDefinition = {
      name: mcpTool.name,
      description: `${mcpTool.description} [MCP server: ${mcpTool.server}] ${sideEffectsNote}`,
      inputSchema: mcpTool.inputSchema as Record<string, unknown>,
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      return client.call(mcpTool.name, args);
    };

    entries.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  return entries;
}
