import simpleGit, { SimpleGit } from "simple-git";
import { fs } from "../node-builtins";
import type { SubmoduleConfig } from "../settings";
import type { PendingChanges, SyncProgress } from "../types";
import { GitManager, GitConflictError } from "./GitManager";
import type { ProgressFn } from "./GitManager";

export class SubmoduleManager {
  private git: SimpleGit;
  private gitManagers = new Map<string, GitManager>();

  constructor(
    private vaultPath: string,
    private user: string,
    private email: string,
    private token: string,
    private configDir: string
  ) {
    this.git = simpleGit(vaultPath);
  }

  // ── Submodule lifecycle ──────────────────────────────────────────

  async add(config: SubmoduleConfig): Promise<void> {
    await this.git.submoduleAdd(config.remoteUrl, config.localPath);
    await this.git.submoduleUpdate(["--init", config.localPath]);
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

  async abortMerge(config: SubmoduleConfig): Promise<void> {
    return this.getSubGM(config).abortMerge();
  }

  // ── Sync ─────────────────────────────────────────────────────────

  async syncOne(config: SubmoduleConfig, onProgress?: ProgressFn): Promise<number> {
    const count = await this.getSubGM(config).sync({
      branch: config.branch,
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
  private getSubGM(config: SubmoduleConfig): GitManager {
    let gm = this.gitManagers.get(config.id);
    if (!gm) {
      gm = new GitManager(
        `${this.vaultPath}/${config.localPath}`,
        this.user,
        this.email,
        this.token,
        this.configDir
      );
      this.gitManagers.set(config.id, gm);
    }
    return gm;
  }

  /** Stage the updated submodule pointer in the parent vault and push. */
  private async updateParentPointer(config: SubmoduleConfig): Promise<void> {
    await this.git.add(config.localPath);
    const status = await this.git.status();
    if (status.staged.length === 0) return;
    await this.git.commit(`chore: update submodule ${config.localPath}`);
    const branch = (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (branch && branch !== "HEAD") {
      await this.git.raw(["push", "--set-upstream", "origin", branch]);
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
