/**
 * src/config/discovery.ts — 配置文件发现（第 28 章）
 *
 * 按优先级查找配置文件位置：
 *   1. $AGENT_HARNESS_CONFIG 环境变量
 *   2. ./agent-harness.yaml
 *   3. ./agent-harness.yml
 *   4. ./config/agent-harness.yaml
 *   5. ~/.config/agent-harness.yaml
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** 搜索的配置文件列表（按优先级） */
const SEARCH_PATHS: string[] = [
  "./agent-harness.yaml",
  "./agent-harness.yml",
  "./config/agent-harness.yaml",
  "./config/agent-harness.yml",
];

/**
 * 查找配置文件。
 *
 * @returns 找到的配置文件绝对路径，或 null
 */
export function discoverConfigFile(): string | null {
  // 1. 环境变量覆盖
  const envPath = process.env["AGENT_HARNESS_CONFIG"];
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  // 2. 搜索默认路径
  for (const relative of SEARCH_PATHS) {
    const resolved = path.resolve(relative);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  // 3. 用户 home 目录
  const homeDir = os.homedir();
  const homeConfig = path.join(homeDir, ".config", "agent-harness.yaml");
  if (fs.existsSync(homeConfig)) {
    return homeConfig;
  }

  return null;
}
