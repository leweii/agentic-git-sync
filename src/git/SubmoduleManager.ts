import simpleGit, { SimpleGit } from "simple-git";
import { fs } from "../node-builtins";
import type { SubmoduleConfig } from "../settings";
import type { PendingChanges, SyncProgress } from "../types";
import { GitManager, GitConflictError } from "./GitManager";
import type { ProgressFn } from "./GitManager";
import { ensureRemoteBranch } from "./githubApi";
import type { AIProvider } from "../ai/AIProvider";
import type { EventLog } from "../observability/EventLog";
import { wrapGitWithLogging } from "./loggedGit";

// Direct `fs` use is bounded to: (a) the submodule's working-tree
// directory under `<vault>/<localPath>`, and (b) the submodule's git
// metadata under `<vault>/.git/modules/<localPath>/`. Both are inside
// the user's vault and invisible to Obsidian's Vault API. Module load
// is gated by `Platform.isDesktop` in `node-builtins.ts`.

export class SubmoduleManager {
  private git: SimpleGit;
  private gitManagers = new Map<string, GitManager>();

  constructor(
    private vaultPath: string,
    private user: string,
    private email: string,
    private token: string,
    private configDir: string,
    private providers: AIProvider[] = [],
    private eventLog: EventLog | null = null,
  ) {
    const raw = simpleGit(vaultPath);
    this.git = eventLog ? wrapGitWithLogging(raw, eventLog, "main") : raw;
  }

  // ── Submodule lifecycle ──────────────────────────────────────────

  async add(config: SubmoduleConfig): Promise<void> {
    await this.git.submoduleAdd(config.remoteUrl, config.localPath);
    await this.git.submoduleUpdate(["--init", config.localPath]);
    await this.alignSubmoduleToBranch(config);
  }

  /**
   * Bring the freshly-cloned submodule onto the requested branch.
   *
   * `git submodule add <url> <path>` always checks out the remote's
   * default branch — it doesn't read `config.branch`. So when the user
   * asks for a non-default branch (existing or not), the submodule's
   * local HEAD diverges from what later syncs try to push, producing
   * "src refspec <branch> does not match any" on first push.
   *
   * This method makes the two sides match:
   *   1. Create the branch on the remote via the GitHub Git Refs API
   *      if it doesn't exist yet (based on the repo's default branch).
   *   2. Locally check out (or create) that branch and push --set-upstream.
   *   3. Record `submodule.<path>.branch` in .gitmodules so other clones
   *      (`git submodule update --remote`) track the right branch too.
   *
   * All steps are best-effort: a failure here doesn't unwind the add,
   * since the submodule is already registered and the next sync's
   * recovery agent can finish the alignment.
   */
  private async alignSubmoduleToBranch(config: SubmoduleConfig): Promise<void> {
    const subPath = `${this.vaultPath}/${config.localPath}`;
    const subGit = simpleGit(subPath);
    const current = await subGit.revparse(["--abbrev-ref", "HEAD"]).then((s) => s.trim()).catch(() => "");
    if (!current || current === config.branch) {
      await this.recordSubmoduleBranch(config).catch(() => {});
      return;
    }

    if (this.token) {
      try {
        await ensureRemoteBranch(config.remoteUrl, config.branch, this.token);
      } catch (e) {
        console.warn("[agentic-git-sync] ensureRemoteBranch (submodule) failed:", (e as Error).message);
      }
    }

    // Try to track the (now-)existing remote branch; fall back to
    // creating a fresh local branch off the current HEAD.
    const checkedOut = await subGit
      .raw(["checkout", "-B", config.branch, `origin/${config.branch}`])
      .then(() => true)
      .catch(() => false);
    if (!checkedOut) {
      await subGit.raw(["checkout", "-B", config.branch]).catch(() => {});
    }
    await subGit
      .raw(["push", "--set-upstream", "origin", config.branch])
      .catch((e) => {
        console.warn("[agentic-git-sync] submodule branch push failed:", (e as Error).message);
      });

    await this.recordSubmoduleBranch(config).catch(() => {});
  }

  /** Record `submodule.<path>.branch = <branch>` in the parent's .gitmodules. */
  private async recordSubmoduleBranch(config: SubmoduleConfig): Promise<void> {
    await this.git.raw([
      "config", "-f", ".gitmodules",
      `submodule.${config.localPath}.branch`,
      config.branch,
    ]);
  }

  async remove(localPath: string): Promise<void> {
    // Standard submodule removal:
    //   1. deinit (remove working tree)
    //   2. git rm (remove from index + .gitmodules)
    //   3. fs.rm .git/modules/<path>   (NOT `git rm` — that path isn't tracked)
    await this.git.raw(["submodule", "deinit", "-f", "--", localPath]).catch(() => {});
    await this.git.raw(["rm", "-f", "--", localPath]).catch(() => {});
    try {
      fs.rmSync(`${this.vaultPath}/.git/modules/${localPath}`, {
        recursive: true,
        force: true,
      });
    } catch { /* may not exist */ }
    try {
      fs.rmSync(`${this.vaultPath}/${localPath}`, { recursive: true, force: true });
    } catch { /* already gone */ }
    // Cache is keyed by id (not path) and we don't have it here. Easiest:
    // clear all — they'll be re-created lazily on next access.
    this.gitManagers.clear();
  }

  /**
   * Ensure every submodule declared in `configs` is checked out locally.
   *
   * Called on plugin load: a fresh clone of the vault may have `.gitmodules`
   * entries but no checked-out content (user didn't pass `--recursive`).
   * Idempotent — does nothing for submodules already present.
   *
   * Returns the list of paths that were newly initialized.
   */
  async ensureInitialized(
    configs: SubmoduleConfig[],
    onProgress?: (msg: string) => void
  ): Promise<string[]> {
    if (configs.length === 0) return [];

    // Need the parent vault to be a git repo before we can manage submodules.
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) return [];

    const newly: string[] = [];
    const gitmodulesPath = `${this.vaultPath}/.gitmodules`;
    const gitmodules = fs.existsSync(gitmodulesPath)
      ? fs.readFileSync(gitmodulesPath, "utf8")
      : "";

    for (const c of configs) {
      const subDir = `${this.vaultPath}/${c.localPath}`;
      const hasContent = fs.existsSync(`${subDir}/.git`);
      if (hasContent) continue;

      onProgress?.(`Initializing ${c.localPath}…`);
      const inGitmodules = gitmodules.includes(`path = ${c.localPath}`);
      try {
        if (inGitmodules) {
          // Parent already knows about this submodule — just clone + checkout.
          await this.git.raw(["submodule", "update", "--init", "--", c.localPath]);
        } else {
          // Out-of-band config (e.g., recreated from .github-sync.json).
          // Register the submodule with the parent, then init.
          await this.git.submoduleAdd(c.remoteUrl, c.localPath);
          await this.git.raw(["submodule", "update", "--init", "--", c.localPath]);
        }
        newly.push(c.localPath);
      } catch (e) {
        // Don't let one bad submodule block the rest. Surface via progress.
        onProgress?.(`Failed to init ${c.localPath}: ${(e as Error).message}`);
      }
    }
    return newly;
  }

  // ── Rename detection (OS-level renames bypass Obsidian events) ───

  /**
   * For each config whose localPath no longer exists on disk, scans the
   * vault for a folder whose .git gitfile points to
   * .git/modules/<configuredLocalPath>. That gitfile is written at
   * submodule-init time and is never updated on a plain folder rename,
   * making it a reliable fingerprint of the original path.
   *
   * Returns pairs of {config, newPath} for every submodule whose new
   * location was found. The caller is responsible for updating settings.
   */
  async detectRenamedPaths(
    configs: SubmoduleConfig[]
  ): Promise<Array<{ config: SubmoduleConfig; newPath: string }>> {
    const missing = configs.filter(
      (c) => !fs.existsSync(`${this.vaultPath}/${c.localPath}`)
    );
    if (missing.length === 0) return [];

    // Collect all .git gitfiles (files, not directories) in the vault.
    // Skips .git/ dirs and node_modules to keep the scan fast.
    const gitfiles: string[] = [];
    const scanDir = (dir: string, depth: number) => {
      if (depth > 8) return;
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name === "node_modules") continue;
        const full = `${dir}/${name}`;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (name === ".git") continue; // skip .git/ dirs
            scanDir(full, depth + 1);
          } else if (name === ".git") {
            gitfiles.push(full); // .git file inside a submodule
          }
        } catch { /* permission errors, broken symlinks */ }
      }
    };
    scanDir(this.vaultPath, 0);

    const results: Array<{ config: SubmoduleConfig; newPath: string }> = [];
    for (const gitfile of gitfiles) {
      let content: string;
      try { content = fs.readFileSync(gitfile, "utf8").trim(); } catch { continue; }
      // Format: "gitdir: ../.git/modules/folder/sub-folder"
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) continue;
      const gitdirVal = match[1].trim();
      // Extract the path after "modules/"
      const modulesIdx = gitdirVal.indexOf(".git/modules/");
      if (modulesIdx === -1) continue;
      const originalPath = gitdirVal.slice(modulesIdx + ".git/modules/".length).replace(/\\/g, "/");

      const cfg = missing.find((c) => c.localPath === originalPath);
      if (!cfg) continue;

      // The folder containing the .git gitfile is the new submodule root.
      const newAbsPath = gitfile.slice(0, -"/.git".length);
      const newPath = newAbsPath.slice(this.vaultPath.length + 1); // relative to vault
      results.push({ config: cfg, newPath });
    }
    return results;
  }

  // ── Git ops: delegated to per-submodule GitManager ───────────────

  async listChanges(config: SubmoduleConfig): Promise<PendingChanges> {
    return this.getSubGM(config).listChanges();
  }

  async listConflicts(config: SubmoduleConfig): Promise<string[]> {
    return this.getSubGM(config).listConflicts();
  }

  async stagePath(config: SubmoduleConfig, file: string): Promise<void> {
    return this.getSubGM(config).stagePath(file);
  }

  /**
   * Repoint a submodule at a new remote URL. Updates both sides:
   *   - Parent's `.gitmodules` (`submodule.<path>.url`)
   *   - Submodule's own `remote.origin.url`
   *
   * Runs `git submodule sync` so any cached refspec inside `.git/config`
   * picks up the new URL. Does not fetch or push — the caller's next
   * sync handles that.
   */
  async setRemoteUrl(config: SubmoduleConfig, newUrl: string): Promise<void> {
    // Parent .gitmodules — the source of truth for what URL fresh clones use.
    await this.git.raw([
      "config", "-f", ".gitmodules",
      `submodule.${config.localPath}.url`, newUrl,
    ]);
    // Apply to existing .git/config of the submodule via `submodule sync`.
    await this.git.raw(["submodule", "sync", "--", config.localPath]);
    // Also set it directly inside the submodule, in case `submodule sync`
    // skipped this entry (it sometimes does when the path looks odd).
    const subGit = simpleGit(`${this.vaultPath}/${config.localPath}`);
    await subGit.remote(["set-url", "origin", newUrl]).catch(() => { /* origin may have been remapped already */ });
    // Drop the cached per-submodule GitManager — its `insteadOf` config
    // was set up against the old URL; new one will be initialised on
    // next access with the new URL in scope.
    this.gitManagers.delete(config.id);
  }

  async abortMerge(config: SubmoduleConfig): Promise<void> {
    return this.getSubGM(config).abortMerge();
  }

  // ── Sync ─────────────────────────────────────────────────────────

  async syncOne(config: SubmoduleConfig, onProgress?: ProgressFn): Promise<number> {
    const count = await this.getSubGM(config).sync({
      branch: config.branch,
      upstreamBranch: config.upstreamBranch,
      remoteUrl: config.remoteUrl,
      onProgress,
    });
    await this.updateParentPointer(config);
    return count;
  }

  /** Commit staged conflict resolution and push — both submodule and parent pointer. */
  async commitMergedAndPush(
    config: SubmoduleConfig,
    message: string,
    onProgress?: ProgressFn
  ): Promise<number> {
    const count = await this.getSubGM(config).commitMergedAndPush(
      config.branch,
      message,
      onProgress
    );
    await this.updateParentPointer(config);
    return count;
  }

  // ── Bulk ─────────────────────────────────────────────────────────

  async syncAll(
    configs: SubmoduleConfig[],
    onProgress?: (id: string, p: SyncProgress) => void
  ): Promise<Map<string, { ok: true; count: number } | { ok: false; error: Error }>> {
    const results = new Map<string, { ok: true; count: number } | { ok: false; error: Error }>();
    const active = configs.filter((c) => c.autoSync);

    await Promise.allSettled(
      active.map(async (c) => {
        try {
          const count = await this.syncOne(c, (p) => onProgress?.(c.id, p));
          results.set(c.id, { ok: true, count });
          onProgress?.(c.id, { phase: "synced" });
        } catch (e) {
          results.set(c.id, { ok: false, error: e as Error });
          onProgress?.(c.id, {
            phase: e instanceof GitConflictError ? "conflict" : "error",
            message: (e as Error).message,
            conflicts: e instanceof GitConflictError ? e.conflicts : undefined,
          });
        }
      })
    );

    return results;
  }

  // ── Private ──────────────────────────────────────────────────────

  /** Returns (creating if needed) a GitManager scoped to the submodule path. */
  gitManagerFor(config: SubmoduleConfig): GitManager {
    return this.getSubGM(config);
  }

  private getSubGM(config: SubmoduleConfig): GitManager {
    let gm = this.gitManagers.get(config.id);
    if (!gm) {
      gm = new GitManager(
        `${this.vaultPath}/${config.localPath}`,
        this.user,
        this.email,
        this.token,
        this.configDir,
        this.providers,
        this.eventLog,
        config.id,
      );
      this.gitManagers.set(config.id, gm);
    }
    return gm;
  }

  /**
   * Stage the updated submodule pointer in the parent vault and commit it.
   * Push attempts are *best-effort* and never thrown.
   *
   * If we re-threw on push failure here, a successful submodule sync
   * would be reported to the user as a failure whenever the parent
   * vault's remote rejects the push (typical case: the user can push
   * to the submodule's repo but not to the main vault's repo). The
   * commit stays in the parent's local history regardless, so the next
   * vault sync will pick it up and surface that push failure where it
   * actually belongs — under the vault, not the submodule.
   */
  private async updateParentPointer(config: SubmoduleConfig): Promise<void> {
    await this.git.add(config.localPath);
    const status = await this.git.status();
    if (status.staged.length === 0) return;
    await this.git.commit(`chore: update submodule ${config.localPath}`);
    const branch = (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (branch && branch !== "HEAD") {
      await this.git
        .raw(["push", "--set-upstream", "origin", branch])
        .catch((e) => {
          console.warn(
            "[agentic-git-sync] couldn't push parent pointer for submodule",
            config.localPath,
            "—",
            (e as Error).message,
            "(will retry on next vault sync)"
          );
        });
    }
  }
}

// Validation helpers exposed for UI use.
export function isValidGitHubUrl(url: string): boolean {
  if (!url) return false;
  return /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?|git@github\.com:[\w.-]+\/[\w.-]+(\.git)?)$/.test(
    url.trim()
  );
}

export function normalizeRepoPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}
