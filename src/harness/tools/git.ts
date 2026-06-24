/**
 * Git 版本控制工具（第 23 章）
 *
 * 8 个结构化的 git 工具，通过 simple-git 库直接与 git 交互。
 * 不包装 run_command 的壳——返回结构化输出而非 raw CLI 文本。
 *
 * 设计原则：
 *   1. 只读操作（status/diff/log）无副作用
 *   2. 写操作（commit/stash/branch/push/pull）带 side_effects 标注
 *   3. Diff 输出使用 viewport 截断（每文件 80 行），与第 11 章 ACI 一致
 *   4. 结构化的 log 包含 author/time/hash——模型和 UI 都能消费
 */
import type { CatalogEntry } from "./selector.js";
import type { ToolDefinition } from "./registry.js";

/* ─── 常量 ───────────────────────────────────────────────────────── */

const GIT_DIFF_LINES_PER_FILE = 80;

/* ─── createGitTools ─────────────────────────────────────────────── */

/**
 * 创建 8 个 git 工具的 CatalogEntry 数组。
 *
 * @param cwd - git 仓库目录（默认当前工作目录）
 * @returns CatalogEntry[] 用于注册到 ToolRegistry / ToolCatalog
 */
export function createGitTools(cwd?: string): CatalogEntry[] {
  const tools: CatalogEntry[] = [];

  /* ─── git_status ──────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "git_status",
      description:
        "Show the working tree status — uncommitted changes, staged changes, " +
        "current branch, untracked files. Returns a structured summary, not raw `git status` output. " +
        "Side effects: reads the repository. Use this to check what has changed before committing.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };

    const handler = async (): Promise<string> => {
      const git = (await import("simple-git")).default(cwd);
      const status = await git.status();

      const lines: string[] = [
        `branch: ${status.current}`,
        `changes: ${status.files.length} file(s)`,
        status.isClean() ? "status: clean (no uncommitted changes)" : "",
      ].filter(Boolean);

      if (status.created.length > 0) {
        lines.push("", "created:", ...status.created.map(f => `  + ${f}`));
      }
      if (status.modified.length > 0) {
        lines.push("", "modified:", ...status.modified.map(f => `  ~ ${f}`));
      }
      if (status.deleted.length > 0) {
        lines.push("", "deleted:", ...status.deleted.map(f => `  - ${f}`));
      }
      if (status.staged.length > 0) {
        lines.push("", "staged:", ...status.staged.map(f => `  ✓ ${f}`));
      }
      if (status.not_added.length > 0) {
        lines.push("", "untracked:", ...status.not_added.map(f => `  ? ${f}`));
      }
      if (status.conflicted.length > 0) {
        lines.push("", "conflicted:", ...status.conflicted.map(f => `  ! ${f}`));
      }

      lines.push("", `[git_status: ${status.current}, ${status.files.length} changed]`);
      return lines.join("\n");
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── git_diff ────────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "git_diff",
      description:
        "Show file diffs. " +
        "file: optional specific file path to scope the diff (default: all changed files). " +
        "staged: if true, show staged diff (--staged). Default false (working tree vs index). " +
        "Returns diff output per file, with viewport truncation (max 80 lines per file). " +
        "Side effects: reads the repository. Use to review changes before committing.",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Optional specific file path to diff",
          },
          staged: {
            type: "boolean",
            description: "Show staged diff (--staged). Default false.",
            default: false,
          },
        },
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const git = (await import("simple-git")).default(cwd);
      const file = args.file ? String(args.file) : undefined;
      const staged = Boolean(args.staged);

      let diff: string;
      try {
        diff = file
          ? await git.diff([staged ? "--staged" : "", "--", file].filter(Boolean))
          : await git.diff([staged ? "--staged" : ""].filter(Boolean));
      } catch (e) {
        return `git_diff: error — ${(e as Error).message}`;
      }

      if (!diff || diff.trim() === "") {
        return "(no diff)";
      }

      // 按文件拆分 diff
      const fileSections = diff.split(/\ndiff --git /);

      const parts: string[] = [];
      for (let i = 0; i < fileSections.length; i++) {
        let section = fileSections[i];
        // 恢复 diff --git 前缀（除了第一个 section）
        if (i > 0) section = `diff --git ${section}`;

        const lines = section.split("\n");
        const totalLines = lines.length;

        if (totalLines <= GIT_DIFF_LINES_PER_FILE) {
          parts.push(section);
        } else {
          const visible = lines.slice(0, GIT_DIFF_LINES_PER_FILE);
          const truncated = totalLines - GIT_DIFF_LINES_PER_FILE;

          // 提取文件名
          const headerMatch = section.match(/diff --git a\/(.+?) b\//);
          const fileName = headerMatch ? headerMatch[1] : "?";

          parts.push(
            visible.join("\n"),
            `  [file: ${fileName}; showing 1-${GIT_DIFF_LINES_PER_FILE} of ${totalLines} lines; ` +
            `${truncated} more lines — call git_diff with file="${fileName}" for full diff]`,
          );
        }
      }

      return parts.join("\n");
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── git_log ─────────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "git_log",
      description:
        "Show commit history. " +
        "file: optional specific file path to scope history. " +
        "max_count: max commits to return (default 10, max 50). " +
        "branch: optional branch name (default: current branch). " +
        "Returns structured log with hash, author, date, message for each commit. " +
        "Side effects: reads the repository. Use to understand project history.",
      inputSchema: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Optional file path to scope history",
          },
          max_count: {
            type: "number",
            description: "Max commits to return (default 10, max 50)",
            default: 10,
          },
          branch: {
            type: "string",
            description: "Branch name (default: current branch)",
          },
        },
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const git = (await import("simple-git")).default(cwd);
      const maxCount = Math.min(50, Math.max(1, Number(args.max_count) || 10));
      const file = args.file ? String(args.file) : undefined;
      const branch = args.branch ? String(args.branch) : undefined;

      try {
        const log = await git.log({
          maxCount,
          file,
          ...(branch ? [branch] : []),
        } as Record<string, unknown>);

        if (log.total === 0) {
          return "(no commits)";
        }

        const lines: string[] = [
          `${log.total} commit(s) on ${log.latest?.hash ? log.latest.hash.substring(0, 7) : "?"}`,
          "",
        ];

        for (const commit of log.all) {
          const shortHash = commit.hash.substring(0, 7);
          const date = commit.date ? new Date(commit.date).toISOString().split("T")[0] : "?";
          const author = commit.author_name ?? "?";
          // 截断过长的消息
          const msg = (commit.message ?? "").split("\n")[0];
          lines.push(`  ${shortHash}  ${date}  ${author}  ${msg}`);
        }

        lines.push("", `[git_log: ${log.total} commits]`);
        return lines.join("\n");
      } catch (e) {
        return `git_log: error — ${(e as Error).message}`;
      }
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── git_commit ──────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "git_commit",
      description:
        "Stage all changes and create a commit. " +
        "message: commit message. " +
        "files: optional array of specific files to stage (default: all changes). " +
        "Returns the commit hash and summary. " +
        "Side effects: writes to the repository history. User confirmation required. " +
        "WARNING: this stages AND commits in one step.",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Commit message",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Optional specific files to stage (default: all)",
          },
        },
        required: ["message"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const git = (await import("simple-git")).default(cwd);
      const message = String(args.message ?? "");
      const files = args.files
        ? (args.files as string[])
        : undefined;

      if (!message.trim()) {
        return "git_commit: commit message cannot be empty";
      }

      try {
        if (files && files.length > 0) {
          await git.add(files);
        } else {
          await git.add(".");
        }

        const result = await git.commit(message);

        return [
          `committed: ${result.commit ?? "(unknown hash)"}`,
          `branch: ${result.branch ?? "?"}`,
          `message: ${message}`,
          `summary: ${result.summary?.changes ?? 0} changed, ` +
          `${result.summary?.insertions ?? 0} insertions, ` +
          `${result.summary?.deletions ?? 0} deletions`,
          `[git_commit: ${result.commit ?? "done"}]`,
        ].join("\n");
      } catch (e) {
        return `git_commit: error — ${(e as Error).message}`;
      }
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── git_stash ───────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "git_stash",
      description:
        "Stash or unstash changes. " +
        "action: 'push' to stash working changes, 'pop' to restore most recent stash, " +
        "'list' to show all stashes. " +
        "message: optional message for stash (only for action='push'). " +
        "Side effects: modifies working tree state. User confirmation required for push/pop.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "'push', 'pop', or 'list'",
            enum: ["push", "pop", "list"],
          },
          message: {
            type: "string",
            description: "Optional stash message (only for push)",
          },
        },
        required: ["action"],
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const git = (await import("simple-git")).default(cwd);
      const action = String(args.action ?? "list");

      try {
        switch (action) {
          case "push": {
            const msg = args.message ? String(args.message) : undefined;
            const result = msg
              ? await git.stash(["push", "-m", msg])
              : await git.stash();
            return `stashed changes${msg ? `: ${msg}` : ""}\n[git_stash: pushed]`;
          }
          case "pop": {
            const result = await git.stash(["pop"]);
            return `unstashed changes\n[git_stash: popped]`;
          }
          case "list": {
            const list = await git.stashList();
            if (list.all.length === 0) {
              return "(no stashes)";
            }
            const lines = list.all.map((s, i) => {
              const shortHash = s.hash.substring(0, 7);
              const msg = (s.message ?? "").split("\n")[0];
              return `  stash@{${i}}  ${shortHash}  ${msg}`;
            });
            return `${list.all.length} stash(es):\n${lines.join("\n")}\n[git_stash: listed]`;
          }
          default:
            return `git_stash: unknown action '${action}' — use push, pop, or list`;
        }
      } catch (e) {
        return `git_stash: error — ${(e as Error).message}`;
      }
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── git_branch ──────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "git_branch",
      description:
        "List, create, switch, or delete branches. " +
        "action: 'list' (default), 'create', 'switch', 'delete'. " +
        "name: branch name (required for create/switch/delete). " +
        "Side effects: modifies branch references. User confirmation required for create/delete.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "'list', 'create', 'switch', or 'delete'",
            enum: ["list", "create", "switch", "delete"],
            default: "list",
          },
          name: {
            type: "string",
            description: "Branch name (required for create/switch/delete)",
          },
        },
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const git = (await import("simple-git")).default(cwd);
      const action = String(args.action ?? "list");
      const name = args.name ? String(args.name) : undefined;

      try {
        switch (action) {
          case "list": {
            const branches = await git.branch();
            const lines: string[] = [];
            for (const [bname, b] of Object.entries(branches.branches)) {
              const marker = b.current ? "*" : " ";
              const shortHash = b.commit.substring(0, 7);
              lines.push(`${marker} ${bname}  (${shortHash})`);
            }
            return lines.length > 0
              ? `branches (${branches.all.length} total):\n${lines.join("\n")}\n[git_branch: listed]`
              : "(no branches)";
          }
          case "create": {
            if (!name) return "git_branch: name required for create";
            await git.branch([name]);
            return `created branch: ${name}\n[git_branch: created]`;
          }
          case "switch": {
            if (!name) return "git_branch: name required for switch";
            await git.checkout(name);
            return `switched to branch: ${name}\n[git_branch: switched]`;
          }
          case "delete": {
            if (!name) return "git_branch: name required for delete";
            await git.branch(["-D", name]);
            return `deleted branch: ${name}\n[git_branch: deleted]`;
          }
          default:
            return `git_branch: unknown action '${action}' — use list, create, switch, or delete`;
        }
      } catch (e) {
        return `git_branch: error — ${(e as Error).message}`;
      }
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── git_push ────────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "git_push",
      description:
        "Push commits to a remote repository. " +
        "remote: remote name (default: 'origin'). " +
        "branch: branch to push (default: current branch). " +
        "Side effects: network write to remote. User confirmation required. " +
        "WARNING: pushes code to remote — ensure you've committed first.",
      inputSchema: {
        type: "object",
        properties: {
          remote: {
            type: "string",
            description: "Remote name (default: 'origin')",
            default: "origin",
          },
          branch: {
            type: "string",
            description: "Branch to push (default: current branch)",
          },
        },
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const git = (await import("simple-git")).default(cwd);
      const remote = String(args.remote ?? "origin");
      const branch = args.branch ? String(args.branch) : undefined;

      try {
        const pushResult = branch
          ? await git.push(remote, branch)
          : await git.push(remote);

        return [
          `pushed to ${remote}${branch ? `/${branch}` : ""}`,
          pushResult?.summary?.changes
            ? `changes: ${pushResult.summary.changes}`
            : "(no output from push)",
          `[git_push: completed]`,
        ].join("\n");
      } catch (e) {
        return `git_push: error — ${(e as Error).message}`;
      }
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  /* ─── git_pull ────────────────────────────────────────────────── */

  {
    const definition: ToolDefinition = {
      name: "git_pull",
      description:
        "Pull latest changes from a remote repository. " +
        "remote: remote name (default: 'origin'). " +
        "branch: branch to pull (default: current branch). " +
        "Side effects: network read + merges changes into working tree. " +
        "User confirmation may be required. " +
        "Use to sync with remote before pushing or starting new work.",
      inputSchema: {
        type: "object",
        properties: {
          remote: {
            type: "string",
            description: "Remote name (default: 'origin')",
            default: "origin",
          },
          branch: {
            type: "string",
            description: "Branch to pull (default: current branch)",
          },
        },
      },
    };

    const handler = async (args: Record<string, unknown>): Promise<string> => {
      const git = (await import("simple-git")).default(cwd);
      const remote = String(args.remote ?? "origin");
      const branch = args.branch ? String(args.branch) : undefined;

      try {
        const pullResult = branch
          ? await git.pull(remote, branch)
          : await git.pull(remote);

        return [
          `pulled from ${remote}${branch ? `/${branch}` : ""}`,
          pullResult?.summary?.changes
            ? `changes: ${pullResult.summary.changes}`
            : "(already up to date or no output)",
          `[git_pull: completed]`,
        ].join("\n");
      } catch (e) {
        return `git_pull: error — ${(e as Error).message}`;
      }
    };

    tools.push({
      definition,
      handler: handler as unknown as (args: Record<string, unknown>) => string,
      asyncHandler: handler,
    });
  }

  return tools;
}
