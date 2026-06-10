/**
 * Recovery tool registry.
 *
 * Philosophy: the agent should be flexible. Instead of enumerating every
 * possible git error → wrapper-tool, we expose ONE general-purpose
 * `git_exec(args)` that lets the model run any git command. We only keep
 * specialised tools for the handful of cases git itself can't express:
 * direct `.git/` filesystem mutations (clear stale locks, repair HEAD,
 * mass-add to .gitignore, nuke-and-rebuild the whole .git).
 *
 * Direct `fs` use here is confined to `<vault>/.git/` and `<vault>/.gitignore`.
 * Module load is gated by `Platform.isDesktop` in `node-builtins.ts`.
 */

import type { SimpleGit } from "simple-git";
import { fs, path } from "../node-builtins";

export interface RecoveryContext {
  git: SimpleGit;
  vaultPath: string;
  branch: string;
  /** Configured remote URL — used as fallback when .git/config is corrupt. */
  remoteUrl?: string;
}

/**
 * Executors may return a short summary of what they did; the ReAct loop feeds
 * it back to the model as the observation (a void return becomes "ok").
 */
export type RecoveryToolExecutor = (
  ctx: RecoveryContext,
  params: Record<string, string>,
) => Promise<string | void>;

/**
 * Destructive tools have irreversible side effects that aren't trivially
 * recoverable via `git reflog`. The ReAct loop requires confidence ≥ 4 +
 * an explicit error signal before allowing one.
 */
export const DESTRUCTIVE_TOOLS = new Set<string>([
  "skip_large_file",
]);

/**
 * Catastrophic tools rebuild repository state from scratch. Backup is
 * mandatory; failure must not destroy user data. The ReAct loop requires
 * confidence == 5, multiple corroborating signals, and a one-per-loop limit.
 */
export const CATASTROPHIC_TOOLS = new Set<string>([
  "reinit_from_remote",
]);

export function resolveGitDir(vaultPath: string): string | null {
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

/**
 * Patterns that `git_exec` refuses to run, no matter what confidence
 * the model claims. These are the commands that can permanently delete
 * user data outside git's reflog safety net.
 *
 * Allow-list philosophy was rejected as too brittle (every new git
 * version invents commands); deny-list is narrower but covers the only
 * truly irreversible operations:
 *   - `git clean -x` / `-X`: deletes untracked AND .gitignored files,
 *     which on an Obsidian vault means the user's `.obsidian/` settings,
 *     local-only notes, etc. No reflog recovery.
 *   - `git clean -d`: deletes untracked DIRECTORIES, possibly containing
 *     notes the user hasn't yet added. No reflog recovery.
 *   - Anything else (reset --hard, push --force, filter-branch) is
 *     recoverable via local or remote reflog within 90 days.
 */
const DENY_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /^clean$/i,
    reason: "git clean removes untracked files — refused. If you really want this, ask the user.",
  },
];

/**
 * Global flags allowed before the subcommand. Everything else is refused
 * by default: `-C`/`--git-dir`/`--work-tree` re-target another repo,
 * `-c`/`--config-env` inject config overrides (which can define aliases or
 * command-executing settings), and value-taking flags like `--namespace`
 * would defeat subcommand detection. No recovery recipe needs any of them.
 */
const SAFE_GLOBAL_FLAGS = new Set(["--no-pager", "--no-optional-locks"]);

/**
 * Config keys whose values git later runs as commands (or that re-route
 * subcommands, like aliases). Writable via `git config`; left unchecked they
 * would let a later step smuggle a denied verb past the subcommand check.
 */
const EXECUTABLE_CONFIG_KEY =
  /^(alias|credential|filter|pager|gpg)\.|^core\.(sshcommand|fsmonitor|hookspath|askpass|pager|editor|gitproxy)$|^sequence\.editor$|^remote\.[^.]+\.(uploadpack|receivepack)$|^(diff|merge)\.[^.]+\.(command|driver|textconv)$/i;

function isDenied(args: string[]): string | null {
  if (args.length === 0) return "empty args";

  // The subcommand is the first token after the (allow-listed) global flags.
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (!SAFE_GLOBAL_FLAGS.has(args[i])) {
      return `global flag '${args[i]}' before the subcommand is refused — run plain subcommands against the vault repo`;
    }
    i++;
  }
  const cmd = args[i];
  if (!cmd) return "no git subcommand given";

  for (const { re, reason } of DENY_PATTERNS) {
    if (re.test(cmd)) return reason;
  }

  if (/^config$/i.test(cmd) && args.slice(i + 1).some((a) => EXECUTABLE_CONFIG_KEY.test(a))) {
    return "git config on alias/credential/command-executing keys is refused";
  }

  return null;
}

export const RECOVERY_TOOLS: Record<string, RecoveryToolExecutor> = {
  /**
   * Run an arbitrary git subcommand. params.args is a JSON-stringified
   * array of arguments (without the leading "git").
   *
   * Examples:
   *   { args: '["merge", "--abort"]' }
   *   { args: '["pull", "origin", "main", "--no-rebase", "--allow-unrelated-histories"]' }
   *   { args: '["push", "--set-upstream", "origin", "jakob"]' }
   *   { args: '["reset", "--hard", "origin/main"]' }
   *
   * Refuses dangerous commands per DENY_PATTERNS.
   */
  git_exec: async (ctx, params) => {
    let args: unknown;
    try {
      args = JSON.parse(params.args ?? "[]");
    } catch {
      throw new Error("git_exec: params.args must be a JSON array of strings");
    }
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      throw new Error("git_exec: params.args must be a JSON array of strings");
    }
    const deny = isDenied(args as string[]);
    if (deny) throw new Error(`git_exec blocked: ${deny}`);
    const out = await ctx.git.raw(args as string[]);
    return typeof out === "string" ? out.trim() : "";
  },

  /**
   * Delete stale `.git/*.lock` files older than 30 s. Kept as a specialised
   * tool because git itself has no command to clear its own locks — and
   * because lock files are the single most common recovery scenario
   * (one in every Obsidian-was-quit-mid-sync session).
   */
  /**
   * Pull from origin using the current branch, allowing unrelated histories.
   * Used as the deterministic recovery for non-fast-forward push rejections:
   * remote has commits we haven't merged yet — pull them, then the retry
   * loop pushes again. Safe; no data loss possible.
   */
  pull_remote: async (ctx) => {
    await ctx.git.pull("origin", ctx.branch, {
      "--no-rebase": null,
      "--allow-unrelated-histories": null,
    });
  },

  /**
   * Discard local changes to tracked files that are blocking a pull.
   * Safe because _doSync already committed everything NOT in ignorePatterns
   * before calling pull — so whatever remains on disk (and would be
   * overwritten) was deliberately excluded from commits. Letting git
   * overwrite those files is the intended behaviour.
   */
  discard_tracked_changes: async (ctx) => {
    await ctx.git.checkout(["--", "."]);
  },

  /** Checkout (or create) the target branch so push has a valid ref. */
  checkout_branch: async (ctx) => {
    try {
      await ctx.git.checkout(ctx.branch);
    } catch {
      await ctx.git.checkoutLocalBranch(ctx.branch);
    }
  },

  clear_lock: async (ctx) => {
    const gitDir = resolveGitDir(ctx.vaultPath);
    if (!gitDir) return "no .git directory found";
    const deleted: string[] = [];
    for (const name of ["index.lock", "HEAD.lock", "MERGE_HEAD.lock"]) {
      const lockPath = path.join(gitDir, name);
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30_000) {
          fs.unlinkSync(lockPath);
          deleted.push(name);
        }
      } catch { /* file absent — ok */ }
    }
    const clearRefsLocks = (dir: string, rel: string) => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            clearRefsLocks(full, relPath);
          } else if (entry.name.endsWith(".lock")) {
            try {
              const stat = fs.statSync(full);
              if (Date.now() - stat.mtimeMs > 30_000) {
                fs.unlinkSync(full);
                deleted.push(`refs/${relPath}`);
              }
            } catch { /* ok */ }
          }
        }
      } catch { /* ok */ }
    };
    clearRefsLocks(path.join(gitDir, "refs"), "");
    return deleted.length > 0
      ? `deleted stale locks: ${deleted.join(", ")}`
      : "no stale lock files found (locks younger than 30 s are left alone)";
  },

  /**
   * Rewrite `.git/HEAD` to point at refs/heads/<branch>. Direct file
   * mutation — git itself has no idempotent command to do this when
   * HEAD points at a missing/broken ref.
   */
  repair_head: async (ctx) => {
    const gitDir = resolveGitDir(ctx.vaultPath);
    if (!gitDir) return "no .git directory found";
    const headPath = path.join(gitDir, "HEAD");
    const refPath = path.join(gitDir, "refs", "heads", ctx.branch);
    try {
      fs.statSync(refPath);
      fs.writeFileSync(headPath, `ref: refs/heads/${ctx.branch}\n`);
      return `HEAD now points at refs/heads/${ctx.branch}`;
    } catch {
      // Ref doesn't exist — leave HEAD alone, caller can create the branch.
      return `refs/heads/${ctx.branch} does not exist — HEAD left unchanged`;
    }
  },

  /**
   * Add a filename to `.gitignore` and unstage it. Two-step mutation;
   * encapsulated here so the agent doesn't have to coordinate fs + git
   * across two separate calls.
   */
  skip_large_file: async (ctx, params) => {
    const filename = params.filename?.trim();
    if (!filename) return "no filename given — nothing done";
    const gitignorePath = path.join(ctx.vaultPath, ".gitignore");
    const existing = (() => {
      try { return fs.readFileSync(gitignorePath, "utf8"); } catch { return ""; }
    })();
    if (!existing.split("\n").includes(filename)) {
      fs.writeFileSync(gitignorePath, existing.trimEnd() + "\n" + filename + "\n");
    }
    await ctx.git.raw(["rm", "--cached", "--ignore-unmatch", filename]).catch(() => {});
    return `added '${filename}' to .gitignore and removed it from the index`;
  },

  /**
   * Catastrophic last-resort: backup `.git/` to `.git.broken-<ts>/`,
   * re-init from origin. Working-tree files untouched. Encapsulates the
   * backup + rebuild sequence so the agent can't accidentally skip the
   * backup step.
   */
  reinit_from_remote: async (ctx) => {
    const remoteUrl = readConfiguredRemoteUrl(ctx.vaultPath) ?? ctx.remoteUrl;
    if (!remoteUrl) {
      throw new Error("reinit_from_remote: no remote URL found in .git/config and none provided in context");
    }
    const gitDir = resolveGitDir(ctx.vaultPath);
    if (!gitDir) {
      throw new Error("reinit_from_remote: no .git directory present");
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(ctx.vaultPath, `.git.broken-${ts}`);
    fs.renameSync(gitDir, backupDir);
    try {
      await ctx.git.raw(["init", "-b", ctx.branch]);
      await ctx.git.raw(["remote", "add", "origin", remoteUrl]);
      await ctx.git.fetch("origin", ctx.branch);
      await ctx.git.raw(["reset", "--hard", `origin/${ctx.branch}`]);
      return `re-initialised from origin/${ctx.branch}; old .git backed up to ${path.basename(backupDir)}`;
    } catch (e) {
      try { fs.rmSync(gitDir, { recursive: true, force: true }); } catch { /* ok */ }
      try { fs.renameSync(backupDir, gitDir); } catch { /* ok */ }
      throw new Error(`reinit_from_remote: rolled back due to error: ${(e as Error).message}`);
    }
  },
};

export function isRecoveryTool(name: string): boolean {
  return name in RECOVERY_TOOLS;
}

function readConfiguredRemoteUrl(vaultPath: string): string | null {
  const gitDir = resolveGitDir(vaultPath);
  if (!gitDir) return null;
  try {
    const config = fs.readFileSync(path.join(gitDir, "config"), "utf8");
    const m = config.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
