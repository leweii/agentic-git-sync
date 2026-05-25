/**
 * Read-only diagnostic tools the ReAct loop can call to gather context
 * before choosing a recovery action. None of these mutate repository
 * state — they are safe to invoke any number of times and have no
 * confidence gate.
 *
 * Each tool returns a short string suitable for direct inclusion in the
 * LLM prompt (truncated to ~600 characters).
 */

import type { SimpleGit } from "simple-git";
import { fs, path } from "../node-builtins";
import { resolveGitDir } from "./recoveryTools";

export interface ObservationContext {
  git: SimpleGit;
  vaultPath: string;
  branch: string;
}

export type ObservationToolExecutor = (ctx: ObservationContext) => Promise<string>;

const MAX_OUTPUT = 600;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + "…(truncated)";
}

export const OBSERVATION_TOOLS: Record<string, ObservationToolExecutor> = {
  git_status: async (ctx) => {
    try {
      const out = await ctx.git.raw(["status", "--porcelain=v2", "--branch"]);
      return truncate(out.trim() || "(clean working tree)");
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },

  git_log_recent: async (ctx) => {
    try {
      const out = await ctx.git.raw([
        "log", "-3", "--oneline", "--decorate", "--no-color",
      ]);
      return truncate(out.trim() || "(no commits)");
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },

  git_remote_state: async (ctx) => {
    try {
      // rev-list returns "<ahead>\t<behind>" relative to origin/<branch>.
      const out = await ctx.git.raw([
        "rev-list",
        "--left-right",
        "--count",
        `${ctx.branch}...origin/${ctx.branch}`,
      ]);
      const [ahead, behind] = out.trim().split(/\s+/);
      return `ahead=${ahead ?? "?"} behind=${behind ?? "?"}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },

  list_git_dir: async (ctx) => {
    const gitDir = resolveGitDir(ctx.vaultPath);
    if (!gitDir) return "no .git directory found";
    const interesting = [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "rebase-merge",
      "rebase-apply",
      "index.lock",
      "HEAD.lock",
      "MERGE_HEAD.lock",
    ];
    const present: string[] = [];
    for (const name of interesting) {
      try {
        fs.statSync(path.join(gitDir, name));
        present.push(name);
      } catch { /* absent */ }
    }
    // Also scan refs/ for stale .lock files
    const refsLocks: string[] = [];
    const scan = (dir: string, rel: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            scan(full, relPath);
          } else if (entry.name.endsWith(".lock")) {
            refsLocks.push(`refs/${relPath}`);
          }
        }
      } catch { /* ok */ }
    };
    scan(path.join(gitDir, "refs"), "");
    if (refsLocks.length > 0) present.push(...refsLocks);
    return present.length > 0
      ? `markers present: ${present.join(", ")}`
      : "no merge/rebase/lock markers";
  },

  read_gitignore: async (ctx) => {
    try {
      const content = fs.readFileSync(path.join(ctx.vaultPath, ".gitignore"), "utf8");
      return truncate(content);
    } catch {
      return "(no .gitignore)";
    }
  },

  /**
   * Repository integrity check. We deliberately avoid `--full` (slow on big
   * vaults) and `--strict` (false positives on shallow clones). Errors are
   * the signal that `reinit_from_remote` may be needed.
   */
  git_fsck: async (ctx) => {
    try {
      const out = await ctx.git.raw(["fsck", "--no-progress", "--no-dangling"]);
      const trimmed = out.trim();
      return truncate(trimmed || "ok (no errors)");
    } catch (e) {
      // fsck exits non-zero when it finds problems — capture stderr as the signal.
      return truncate(`error: ${(e as Error).message}`);
    }
  },

  /** Last 10 reflog entries — shows what the user did manually before the error. */
  git_reflog: async (ctx) => {
    try {
      const out = await ctx.git.raw(["reflog", "-10", "--no-color"]);
      return truncate(out.trim() || "(empty reflog)");
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },

  /** Names + line counts of changed tracked files. No content. */
  git_diff_summary: async (ctx) => {
    try {
      const out = await ctx.git.raw(["diff", "--stat"]);
      return truncate(out.trim() || "(no tracked changes)");
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },

  /** Remotes and their URLs — confirms 'origin' exists with the expected URL. */
  git_remote_list: async (ctx) => {
    try {
      const out = await ctx.git.raw(["remote", "-v"]);
      return truncate(out.trim() || "(no remotes)");
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  },
};

export function isObservationTool(name: string): boolean {
  return name in OBSERVATION_TOOLS;
}
