/**
 * 第 13 章 MCP 示例 — 连接外部工具服务器
 *
 * 对应设计文档「ch13-mcp — MCP：来自外部的工具」
 *
 * 设计要点：
 *   1. JSON-RPC 2.0 over stdio — 子进程通信
 *   2. initialize → tools/list → tools/call 三步握手
 *   3. mcp__<server>__<tool> 前缀防命名冲突
 *   4. MCP 工具通过 wrapMcpTools 进入 ToolCatalog
 *
 * 此示例连接 @modelcontextprotocol/server-filesystem MCP 服务器，
 * 读取当前项目目录下的文件信息。
 *
 * 运行方式：
 *   npx tsx examples/ch13_mcp.ts
 */

import { MCPClient, type MCPServerConfig } from "../src/harness/mcp/client.js";
import { wrapMcpTools } from "../src/harness/mcp/tools.js";

async function main() {
  console.log("━━━ ch13: MCP 外部工具 ━━━\n");

  // 1. 配置 MCP 服务器 — filesystem server
  console.log("─ 1. 配置 MCP 服务器配置 ───────────");
  const config: MCPServerConfig = {
    name: "fs",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
  };
  console.log(`   服务器名: ${config.name}`);
  console.log(`   命令: ${config.command} ${config.args.join(" ")}\n`);

  // 2. 连接并握手
  console.log("─ 2. 连接服务器 ─────────────────────");
  const client = new MCPClient();
  await client.connect(config);
  const tools = client.listTools();
  console.log(`   已连接，发现 ${tools.length} 个工具:`);
  for (const t of tools) {
    console.log(`     ${t.name} — ${t.description.slice(0, 60)}...`);
  }
  console.log();

  // 3. 调用 MCP 工具
  console.log("─ 3. 调用 filesystem 工具 ────────────");
  try {
    // 查看当前目录文件列表
    const result = await client.call("mcp__fs__read_file", { path: "./package.json" });
    const preview = (result as string).slice(0, 200);
    console.log(`   mcp__fs__read_file("./package.json") →`);
    console.log(`   ${preview}...`);
  } catch (e) {
    console.log(`   (调用失败，这在无 npx 环境是预期的: ${(e as Error).message})`);
    console.log(`   💡 本示例需要 node + npx 可访问互联网。`);
  }
  console.log();

  // 4. 包装为 CatalogEntry
  console.log("─ 4. 包装为 CatalogEntry ────────────");
  const entries = wrapMcpTools(client);
  console.log(`   生成了 ${entries.length} 个 CatalogEntry`);
  if (entries.length > 0) {
    console.log(`   首个工具: ${entries[0].definition.name}`);
    console.log(`   描述: ${entries[0].definition.description.slice(0, 80)}...`);
  }
  console.log();

  // 5. 断开连接
  console.log("─ 5. 断开连接 ───────────────────────");
  client.disconnect();
  console.log("   已断开所有 MCP 连接");

  console.log("\n━━━ ✅ MCP 示例完成 ━━━");
  console.log("💡 MCP 工具像本地工具一样使用：");
  console.log("   const entries = wrapMcpTools(client);");
  console.log("   const catalog = new ToolCatalog(entries);");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
