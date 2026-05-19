import type { GitManager } from "../git/GitManager";
import { GitConflictError } from "../git/GitManager";
import type { SubmoduleManager } from "../git/SubmoduleManager";
import { ensureRemoteHasCommits } from "../git/githubApi";
import type { GitHubSyncSettings } from "../settings";
import type { SyncProgress } from "../types";
import { VAULT_REPO_ID } from "../types";

export type StatusListener = (id: string, progress: SyncProgress) => void;
export type SyncCompleteListener = (
  id: string,
  result: { ok: true; count: number } | { ok: false; error: Error }
) => void;
export type AutoResolveResult =
  | { ok: true; count: number }
  | { ok: false };
export type AutoResolveCallback = (
  repoId: string,
  conflicts: string[]
) => Promise<AutoResolveResult>;

export class SyncScheduler {
  private timer: number | null = null;
  private running = false;
  private listeners: StatusListener[] = [];
  private completeListeners: SyncCompleteListener[] = [];
  private autoResolve: AutoResolveCallback | null = null;
  private betweenVaultAndSubsHook: (() => Promise<void>) | null = null;

  constructor(
    private gitManager: GitManager,
    private submoduleManager: SubmoduleManager,
    private getSettings: () => GitHubSyncSettings
  ) {}

  setAutoResolver(cb: AutoResolveCallback | null): void {
    this.autoResolve = cb;
  }

  /**
   * Hook fired between `runVault()` and `runSubmodules()` in every `run()`
   * cycle. Used by main.ts to reload .github-sync.json (which the vault
   * pull may have just updated) and clone any newly-declared submodules
   * BEFORE we try to sync them — otherwise a teammate's new submodule
   * never gets pulled until the next plugin reload.
   */
  setBetweenVaultAndSubsHook(fn: (() => Promise<void>) | null): void {
    this.betweenVaultAndSubsHook = fn;
  }

  onStatus(fn: StatusListener): void {
    this.listeners.push(fn);
  }

  onComplete(fn: SyncCompleteListener): void {
    this.completeListeners.push(fn);
  }

  private emit(id: string, progress: SyncProgress): void {
    for (const fn of this.listeners) fn(id, progress);
  }

  private emitComplete(
    id: string,
    result: { ok: true; count: number } | { ok: false; error: Error }
  ): void {
    for (const fn of this.completeListeners) fn(id, result);
  }

  start(): void {
    this.stop();
    const interval = this.getSettings().autoSyncInterval;
    if (interval <= 0) return;
    this.timer = window.setInterval(() => {
      if (!this.running) this.run().catch(() => {});
    }, interval * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runVault();
      // Vault pull may have brought in new submodule entries — let the
      // plugin reload .github-sync.json and clone any missing ones before
      // we try to sync them.
      if (this.betweenVaultAndSubsHook) {
        try { await this.betweenVaultAndSubsHook(); } catch { /* non-fatal */ }
      }
      await this.runSubmodules();
    } finally {
      this.running = false;
    }
  }

  async runVault(message?: string): Promise<void> {
    const settings = this.getSettings();
    if (!settings.mainRepoUrl) return;
    const branch = settings.mainRepoBranch || "main";

    this.emit(VAULT_REPO_ID, { phase: "checking" });
    try {
      // Defensive: if the remote is still an uninitialised GitHub repo,
      // seed it via the Contents API so the upcoming pull/push has a
      // default branch to talk to. No-op for non-empty remotes; cost is
      // a single cheap API request.
      await ensureRemoteHasCommits(settings.mainRepoUrl, settings.githubToken);

      const count = await this.gitManager.sync({
        branch,
        message,
        remoteUrl: settings.mainRepoUrl,
        ignorePatterns: settings.ignorePatterns,
        onProgress: (p) => this.emit(VAULT_REPO_ID, p),
      });
      this.emit(VAULT_REPO_ID, { phase: "synced" });
      this.emitComplete(VAULT_REPO_ID, { ok: true, count });
    } catch (e) {
      if (e instanceof GitConflictError && this.autoResolve) {
        try {
          const r = await this.autoResolve(VAULT_REPO_ID, e.conflicts);
          if (r.ok === true) {
            this.emit(VAULT_REPO_ID, { phase: "synced" });
            this.emitComplete(VAULT_REPO_ID, { ok: true, count: r.count });
            return;
          }
        } catch {
          // fall through to normal conflict emission below
        }
      }

      const err = e as Error;
      this.emit(VAULT_REPO_ID, {
        phase: e instanceof GitConflictError ? "conflict" : "error",
        message: err.message,
        conflicts: e instanceof GitConflictError ? e.conflicts : undefined,
      });
      this.emitComplete(VAULT_REPO_ID, { ok: false, error: err });
    }
  }

  async runSubmodule(id: string, message?: string): Promise<void> {
    const sub = this.getSettings().submodules.find((s) => s.id === id);
    if (!sub) return;
    this.emit(id, { phase: "checking" });
    try {
      // Same defensive auto-init as runVault — covers the case where the
      // user added a submodule via an older plugin version (no auto-init),
      // or recreated the remote on github.com between runs.
      await ensureRemoteHasCommits(sub.remoteUrl, this.getSettings().githubToken);

      const count = await this.submoduleManager.syncOne(sub, (p) => this.emit(id, p));
      this.emit(id, { phase: "synced" });
      this.emitComplete(id, { ok: true, count });
    } catch (e) {
      if (e instanceof GitConflictError && this.autoResolve) {
        try {
          const r = await this.autoResolve(id, e.conflicts);
          if (r.ok === true) {
            this.emit(id, { phase: "synced" });
            this.emitComplete(id, { ok: true, count: r.count });
            return;
          }
        } catch {
          // fall through
        }
      }

      const err = e as Error;
      this.emit(id, {
        phase: e instanceof GitConflictError ? "conflict" : "error",
        message: err.message,
        conflicts: e instanceof GitConflictError ? e.conflicts : undefined,
      });
      this.emitComplete(id, { ok: false, error: err });
    }
  }

  async runSubmodules(): Promise<void> {
    // Route each submodule through runSubmodule so silent auto-resolve
    // applies. (Previously this used submoduleManager.syncAll directly,
    // which skipped the auto-resolve hook.)
    const settings = this.getSettings();
    for (const sub of settings.submodules) {
      if (sub.autoSync) await this.runSubmodule(sub.id);
    }
  }
}
