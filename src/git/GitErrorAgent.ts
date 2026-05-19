/**
 * Git error recovery agent for Agentic Git Sync.
 *
 * When a git operation fails, the agent:
 *  1. Calls the configured AI provider (if any) with the error and a tool catalog.
 *  2. Falls back to deterministic rule-based classification if no AI is available
 *     or the model has low confidence.
 *  3. Executes the selected recovery tool silently.
 *
 * The caller retries the original operation after tryRecover() returns true.
 * GitConflictError is never passed here — those surface to the ConflictModal.
 */

import type { SimpleGit } from "simple-git";
import { fs, path } from "../node-builtins";
import type { AIProvider } from "../ai/AIProvider";
import {
  GIT_ERROR_SYSTEM_PROMPT,
  buildErrorPrompt,
  parseErrorPlan,
  type ErrorRecoveryPlan,
} from "../ai/gitErrorPrompt";

// ─── Recovery context ────────────────────────────────────────────────────────

interface RecoveryContext {
  git: SimpleGit;
  vaultPath: string;
  branch: string;
}

// ─── Tool executors ──────────────────────────────────────────────────────────

type ToolExecutor = (ctx: RecoveryContext, params: Record<string, string>) => Promise<void>;

function resolveGitDir(vaultPath: string): string | null {
  try {
    const p = path.join(vaultPath, ".git");
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return p;
    const ref = fs.readFileSync(p, "utf8").trim().replace(/^gitdir:\s*/, "");
    return path.resolve(vaultPath, ref);
  } catch {
    return null;
  }
}

const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
  clear_lock: async (ctx) => {
    const gitDir = resolveGitDir(ctx.vaultPath);
    if (!gitDir) return;
    for (const name of ["index.lock", "HEAD.lock", "MERGE_HEAD.lock"]) {
      const lockPath = path.join(gitDir, name);
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) fs.unlinkSync(lockPath);
      } catch { /* file absent — ok */ }
    }
    // Also clear lock files nested under refs/
    const clearRefsLocks = (dir: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            clearRefsLocks(full);
          } else if (entry.name.endsWith(".lock")) {
            try {
              const stat = fs.statSync(full);
              if (Date.now() - stat.mtimeMs > 30_000) fs.unlinkSync(full);
            } catch { /* ok */ }
          }
        }
      } catch { /* ok */ }
    };
    clearRefsLocks(path.join(gitDir, "refs"));
  },

  abort_merge: async (ctx) => {
    await ctx.git.raw(["merge", "--abort"]).catch(() => {});
    // Remove MERGE_HEAD in case abort partially failed
    const gitDir = resolveGitDir(ctx.vaultPath);
    if (gitDir) {
      try { fs.unlinkSync(path.join(gitDir, "MERGE_HEAD")); } catch { /* ok */ }
    }
  },

  abort_rebase: async (ctx) => {
    await ctx.git.raw(["rebase", "--abort"]).catch(() => {});
  },

  abort_cherry_pick: async (ctx) => {
    await ctx.git.raw(["cherry-pick", "--abort"]).catch(() => {});
    const gitDir = resolveGitDir(ctx.vaultPath);
    if (gitDir) {
      try { fs.unlinkSync(path.join(gitDir, "CHERRY_PICK_HEAD")); } catch { /* ok */ }
    }
  },

  abort_bisect: async (ctx) => {
    await ctx.git.raw(["bisect", "reset"]).catch(() => {});
  },

  reset_to_remote: async (ctx) => {
    await ctx.git.fetch("origin");
    await ctx.git.raw(["reset", "--hard", `origin/${ctx.branch}`]);
  },

  force_push_with_lease: async (ctx) => {
    await ctx.git.raw([
      "push", "--force-with-lease", "--set-upstream", "origin", ctx.branch,
    ]);
  },

  pull_allow_unrelated: async (ctx) => {
    await ctx.git.pull("origin", ctx.branch, {
      "--rebase": "false",
      "--allow-unrelated-histories": null,
    } as Record<string, string | null>);
  },

  push_set_upstream: async (ctx) => {
    await ctx.git.raw(["push", "--set-upstream", "origin", ctx.branch]);
  },

  rebuild_index: async (ctx) => {
    const gitDir = resolveGitDir(ctx.vaultPath);
    if (gitDir) {
      try { fs.unlinkSync(path.join(gitDir, "index")); } catch { /* ok */ }
    }
    await ctx.git.raw(["reset"]).catch(() => {});
  },

  stash_and_pull: async (ctx) => {
    await ctx.git.stash().catch(() => {});
    await ctx.git.pull("origin", ctx.branch, { "--rebase": "false" });
    await ctx.git.stash(["pop"]).catch(() => {});
  },

  skip_large_file: async (ctx, params) => {
    const filename = params.filename?.trim();
    if (!filename) return;
    const gitignorePath = path.join(ctx.vaultPath, ".gitignore");
    const existing = (() => {
      try { return fs.readFileSync(gitignorePath, "utf8"); } catch { return ""; }
    })();
    if (!existing.split("\n").includes(filename)) {
      fs.writeFileSync(gitignorePath, existing.trimEnd() + "\n" + filename + "\n");
    }
    await ctx.git.raw(["rm", "--cached", "--ignore-unmatch", filename]).catch(() => {});
  },

  enable_long_paths: async (ctx) => {
    await ctx.git.addConfig("core.longpaths", "true");
  },

  checkout_branch: async (ctx) => {
    const checkedOut = await ctx.git.raw(["checkout", ctx.branch]).then(() => true).catch(() => false);
    if (!checkedOut) {
      await ctx.git.raw(["checkout", "-b", ctx.branch]).catch(() => {});
    }
  },

  create_branch: async (ctx) => {
    await ctx.git.raw(["checkout", "-b", ctx.branch]).catch(() => {});
  },

  init_submodules: async (ctx) => {
    await ctx.git.raw(["submodule", "init"]).catch(() => {});
    await ctx.git.raw(["submodule", "update", "--recursive"]).catch(() => {});
  },

  no_op: async () => { /* intentional no-op */ },
};

// ─── Rule-based fallback classifier ─────────────────────────────────────────

function classifyByRules(error: string): ErrorRecoveryPlan {
  const m = error.toLowerCase();

  if (m.includes("index.lock") || m.includes("another git process") || m.includes("unable to lock ref")) {
    return { tool: "clear_lock", params: {}, reasoning: "Stale lock file blocks git operation", confidence: 5 };
  }
  if (m.includes("merge_head") || m.includes("you have not concluded your merge") || m.includes("unmerged files") || m.includes("finish your previous merge")) {
    return { tool: "abort_merge", params: {}, reasoning: "Mid-merge state must be aborted before proceeding", confidence: 5 };
  }
  if ((m.includes("rebase") && (m.includes("in-progress") || m.includes("already") || m.includes("staged changes"))) || m.includes("rebase-merge")) {
    return { tool: "abort_rebase", params: {}, reasoning: "In-progress rebase blocks the operation", confidence: 5 };
  }
  if (m.includes("cherry-pick") || m.includes("cherry_pick_head")) {
    return { tool: "abort_cherry_pick", params: {}, reasoning: "In-progress cherry-pick blocks the operation", confidence: 5 };
  }
  if (m.includes("bisect")) {
    return { tool: "abort_bisect", params: {}, reasoning: "Active bisect session blocks checkout/commit", confidence: 5 };
  }
  if (m.includes("refusing to merge unrelated histories")) {
    return { tool: "pull_allow_unrelated", params: {}, reasoning: "Repositories share no common ancestor", confidence: 5 };
  }
  if (m.includes("non-fast-forward") || (m.includes("rejected") && m.includes("behind its remote"))) {
    return { tool: "reset_to_remote", params: {}, reasoning: "Local branch is behind remote", confidence: 4 };
  }
  if (m.includes("src refspec") || m.includes("does not match any") || m.includes("no upstream branch") || m.includes("unborn branch")) {
    return { tool: "push_set_upstream", params: {}, reasoning: "Remote branch does not exist yet", confidence: 5 };
  }
  if (m.includes("would be overwritten") || m.includes("please commit or stash")) {
    return { tool: "stash_and_pull", params: {}, reasoning: "Uncommitted local changes block merge/checkout", confidence: 5 };
  }
  if (m.includes("gh001") || m.includes("file size limit") || m.includes("large files detected")) {
    const match = error.match(/File\s+(\S+)\s+is\s+[\d.]/) ?? error.match(/File\s+(\S+)\s+exceeds/i);
    return {
      tool: "skip_large_file",
      params: match ? { filename: match[1] } : {},
      reasoning: "File exceeds GitHub's 100 MB size limit",
      confidence: 5,
    };
  }
  if (m.includes("index file corrupt") || m.includes("smaller than expected") || m.includes("cache entry has null sha1")) {
    return { tool: "rebuild_index", params: {}, reasoning: "Git staging index is corrupt", confidence: 4 };
  }
  if (m.includes("detached head") || m.includes("not currently on any branch") || m.includes("detached head state")) {
    return { tool: "checkout_branch", params: {}, reasoning: "HEAD is detached; re-attaching to branch", confidence: 5 };
  }
  if ((m.includes("filename too long") || m.includes("enametoolong")) && !m.includes("remote")) {
    return { tool: "enable_long_paths", params: {}, reasoning: "Path exceeds 260-char Windows limit", confidence: 5 };
  }
  if (m.includes("no url found for submodule") || m.includes("submodule mapping") || m.includes("submodule") && m.includes("not initialized")) {
    return { tool: "init_submodules", params: {}, reasoning: "Submodule has not been initialised", confidence: 5 };
  }
  if (m.includes("pathspec") && m.includes("did not match")) {
    return { tool: "create_branch", params: {}, reasoning: "Local branch does not exist yet", confidence: 4 };
  }
  if (m.includes("nothing to commit") || m.includes("nothing added to commit") || m.includes("everything up-to-date")) {
    return { tool: "no_op", params: {}, reasoning: "Not an error — repository is already clean", confidence: 5 };
  }

  return { tool: "no_op", params: {}, reasoning: "No matching recovery rule", confidence: 0 };
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class GitErrorAgent {
  private providers: AIProvider[];

  constructor(
    private git: SimpleGit,
    private vaultPath: string,
    providers: AIProvider[] = []
  ) {
    this.providers = providers.filter((p) => p.isAvailable());
  }

  /**
   * Attempt to recover from a git error.
   * Returns true if a recovery tool was executed (operation should be retried).
   * Returns false if no recovery is possible (caller should surface the error).
   */
  async tryRecover(error: Error, operation: string, branch: string): Promise<boolean> {
    const errMsg = error.message || String(error);
    const plan = await this.classify(errMsg, operation, branch);

    if (plan.confidence === 0) return false;

    const executor = TOOL_EXECUTORS[plan.tool];
    if (!executor) return false;

    try {
      await executor({ git: this.git, vaultPath: this.vaultPath, branch }, plan.params);
      return true;
    } catch (recoveryErr) {
      console.warn(
        `[agentic-git-sync] Recovery tool '${plan.tool}' failed:`,
        (recoveryErr as Error).message
      );
      return false;
    }
  }

  private async classify(error: string, operation: string, branch: string): Promise<ErrorRecoveryPlan> {
    for (const provider of this.providers) {
      if (!provider.isAvailable()) continue;
      try {
        const response = await provider.complete(
          GIT_ERROR_SYSTEM_PROMPT,
          buildErrorPrompt(error, operation, branch)
        );
        if (response) {
          const plan = parseErrorPlan(response);
          if (plan.confidence >= 2) return plan;
        }
      } catch { /* try next provider */ }
    }
    return classifyByRules(error);
  }
}
