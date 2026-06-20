/**
 * Scratchpad — 外部持久化 KV 存储（第 9 章）
 *
 * 基于文件系统的 key-value 存储，通过 3 个工具暴露给 agent：
 *   - scratchpad_write(key, content)
 *   - scratchpad_read(key)
 *   - scratchpad_list()
 *
 * 设计目标：让 agent 自己决定什么值得持久化，而不是靠 compactor 猜测。
 * "能在压缩中存活的状态，是从来不在 context 里的状态。"
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition, ToolHandler } from "./registry.js";

/* ─── Scratchpad ─────────────────────────────────────────────────── */

export class Scratchpad {
  readonly root: string;

  constructor(root: string = ".scratchpad") {
    this.root = root;
    fs.mkdirSync(this.root, { recursive: true });
  }

  /**
   * 消毒 key：只允许字母、数字、短横线、下划线。
   * 拒绝空 key 和含 / . 的 key（防止路径遍历）。
   */
  private _sanitize(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9_-]/g, "");
    if (safe !== key) {
      throw new Error(
        `invalid key ${JSON.stringify(key)}: use [A-Za-z0-9_-]+`,
      );
    }
    if (!safe) {
      throw new Error("key cannot be empty");
    }
    return safe;
  }

  /** 获取 key 对应的文件路径 */
  private _path(key: string): string {
    return path.join(this.root, `${this._sanitize(key)}.txt`);
  }

  /** 写入一个 key */
  write(key: string, content: string): string {
    const filePath = this._path(key);
    fs.writeFileSync(filePath, content, "utf-8");
    return `wrote ${content.length} chars to scratchpad[${key}]`;
  }

  /** 读取一个 key */
  read(key: string): string {
    const filePath = this._path(key);
    if (!fs.existsSync(filePath)) {
      throw new Error(`scratchpad[${key}] not found`);
    }
    return fs.readFileSync(filePath, "utf-8");
  }

  /** 列出所有 key */
  list(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root)
      .filter((f) => f.endsWith(".txt"))
      .map((f) => f.replace(/\.txt$/, ""))
      .sort();
  }

  /**
   * 将 scratchpad 暴露为 3 个可注册的工具。
   * 返回 [ToolDefinition, ToolHandler][] 数组。
   */
  asTools(): Array<[ToolDefinition, ToolHandler]> {
    const pad = this;

    const writeDef: ToolDefinition = {
      name: "scratchpad_write",
      description:
        "Store a value in the scratchpad under the given key. " +
        "key: alphanumeric, dashes, underscores only. " +
        "content: any string; overwrites existing value for this key. " +
        "Use for: plans, discovered facts, decisions that should survive " +
        "the context window. Write once, read on demand.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Alphanumeric key (A-Za-z0-9_-)",
          },
          content: {
            type: "string",
            description: "Value to store",
          },
        },
        required: ["key", "content"],
      },
    };

    const writeHandler: ToolHandler = (args) => {
      return pad.write(String(args.key), String(args.content));
    };

    const readDef: ToolDefinition = {
      name: "scratchpad_read",
      description:
        "Retrieve a value from the scratchpad. " +
        "key: the key used when writing. " +
        "Returns the stored content, or an error if not found.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Key to retrieve",
          },
        },
        required: ["key"],
      },
    };

    const readHandler: ToolHandler = (args) => {
      return pad.read(String(args.key));
    };

    const listDef: ToolDefinition = {
      name: "scratchpad_list",
      description:
        "List keys currently in the scratchpad. " +
        "Returns a newline-separated list of keys. " +
        "Use at the start of a session to discover what prior agents " +
        "(or you, in a past turn) have stored.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };

    const listHandler: ToolHandler = () => {
      const keys = pad.list();
      return keys.length > 0 ? keys.join("\n") : "(empty)";
    };

    return [
      [writeDef, writeHandler],
      [readDef, readHandler],
      [listDef, listHandler],
    ];
  }
}
