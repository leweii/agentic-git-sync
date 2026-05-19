import { Plugin, Notice, FileSystemAdapter } from "obsidian";
import { GitHubSyncSettings, DEFAULT_SETTINGS, GitHubSyncSettingTab } from "./settings";
import { setLang } from "./i18n";
import { GitManager } from "./git/GitManager";
import { SubmoduleManager } from "./git/SubmoduleManager";
import { ensureRemoteHasCommits } from "./git/githubApi";
import { SyncScheduler } from "./sync/SyncScheduler";
import { StatusBar } from "./ui/StatusBar";
import { SyncDashboard, DASHBOARD_VIEW_TYPE } from "./ui/SyncDashboard";
import { LocalChangesModal } from "./ui/LocalChangesModal";
import { friendlyError } from "./errors";
import { VAULT_REPO_ID } from "./types";
import { AIClient } from "./ai/AIClient";
import { DeepSeekProvider } from "./ai/DeepSeekProvider";
import { GeminiProvider } from "./ai/GeminiProvider";
import type { AIProvider } from "./ai/AIProvider";
import { AutoResolver } from "./sync/AutoResolver";
import type { ConflictRepoOps } from "./sync/ConflictRepoOps";
import type { SubmoduleConfig } from "./settings";
import {
  applyRepoConfig,
  settingsToRepoConfig,
  REPO_CONFIG_FILENAME,
} from "./config/RepoConfig";
import {
  readRepoConfig,
  writeRepoConfig,
  repoConfigExists,
} from "./config/repoConfigIO";

export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  gitManager: GitManager;
  submoduleManager: SubmoduleManager;
  scheduler: SyncScheduler;
  private statusBar: StatusBar;
  private pendingPollHandle: number | null = null;

  /**
   * Resolve the live dashboard view from the workspace rather than holding
   * a reference on the plugin. Storing the view instance on the plugin
   * leaks it across leaf detach/reattach (Obsidian guideline).
   */
  private get dashboard(): SyncDashboard | null {
    const leaf = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
    return leaf?.view instanceof SyncDashboard ? leaf.view : null;
  }

  /**
   * Absolute path to the vault on disk. Plugin is desktop-only
   * (`isDesktopOnly: true`), so the adapter is always a FileSystemAdapter
   * — the explicit instanceof check satisfies the type checker and gives
   * a clearer error than a blind cast if the invariant is ever broken.
   */
  private getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Agentic Git Sync requires a FileSystemAdapter (desktop only).");
    }
    return adapter.getBasePath();
  }

  async onload() {
    await this.loadSettings();
    setLang(this.settings.language ?? "en");

    const vaultPath = this.getVaultPath();

    // If user already had settings in data.json but no .github-sync.json
    // yet, generate one — runs once, then a no-op forever after.
    this.app.workspace.onLayoutReady(() => this.migrateRepoConfigIfNeeded());

    this.initGit(vaultPath);

    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.statusBar.el.onclick = () => this.activateDashboard();

    this.scheduler = new SyncScheduler(
      this.gitManager,
      this.submoduleManager,
      () => this.settings
    );

    this.scheduler.onStatus((id, progress) => {
      if (id === VAULT_REPO_ID) {
        this.statusBar.setPhase(progress.phase, progress.message);
      }
      this.dashboard?.onProgress(id, progress);
    });

    this.scheduler.onComplete((id, result) => {
      this.recordHistoryFromResult(id, result);
      void this.refreshStatusBarPending();
    });

    // Run between vault and submodule syncs in every cycle:
    //   1. Reload .github-sync.json (the vault pull may have updated it).
    //   2. Clone any newly-declared submodules before we try to sync them —
    //      otherwise a teammate's new submodule wouldn't get pulled until
    //      the next plugin reload.
    this.scheduler.setBetweenVaultAndSubsHook(async () => {
      await this.reloadRepoConfigOnly();
      await this.autoInitSubmodules();
    });

    this.scheduler.setAutoResolver((repoId, conflicts) => this.attemptAutoResolve(repoId, conflicts));

    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new SyncDashboard(leaf, this));

    // eslint-disable-next-line obsidianmd/ui/sentence-case -- "Agentic Git Sync" is the proper product name
    this.addRibbonIcon("github", "Agentic Git Sync", () => this.activateDashboard());

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: async () => {
        if (this.scheduler.isRunning) {
          new Notice("Sync already in progress.");
          return;
        }
        const silent = this.settings.ai.silentMode;
        if (!silent) new Notice("Sync started…");
        await this.scheduler.run();
        if (!silent) new Notice("Sync finished.");
      },
    });

    this.addCommand({
      id: "open-dashboard",
      name: "Open sync dashboard",
      callback: () => this.activateDashboard(),
    });

    this.addCommand({
      id: "sync-vault-only",
      name: "Sync vault only",
      callback: () => this.scheduler.runVault(),
    });

    this.addCommand({
      id: "revert-local-changes",
      name: "Revert local changes…",
      callback: () => this.openLocalChanges(),
    });

    this.addSettingTab(new GitHubSyncSettingTab(this.app, this));

    this.scheduler.start();

    // Poll pending change count every 2 minutes for the status-bar badge.
    this.pendingPollHandle = window.setInterval(() => { void this.refreshStatusBarPending(); }, 120_000);
    this.app.workspace.onLayoutReady(() => {
      void this.refreshStatusBarPending();
      void this.checkExistingConflicts();
    });

    // Setup wizard no longer auto-pops on plugin load — that's nagging.
    // Users open it from Settings → Agentic Git Sync → "Run setup wizard".

    // On startup:
    //   1. Auto-init submodules declared in .github-sync.json but not yet
    //      cloned (fresh clone without --recursive).
    //   2. Immediately run one full sync so the user sees the latest remote
    //      state on entering Obsidian — instead of waiting up to autoSyncInterval
    //      minutes for the scheduler timer to fire.
    this.app.workspace.onLayoutReady(async () => {
      try {
        await this.autoInitSubmodules();
        await this.syncOnStartupIfEnabled();
      } catch { /* surfaced via per-phase notices */ }
    });
  }

  private async autoInitSubmodules(): Promise<void> {
    if (this.settings.submodules.length === 0) return;
    const newly = await this.submoduleManager.ensureInitialized(
      this.settings.submodules,
      (msg) => this.statusBar.setPhase("pulling", msg)
    );
    this.statusBar.setPhase("idle", "");
    if (newly.length > 0) {
      new Notice(`Initialized ${newly.length} submodule(s): ${newly.join(", ")}`);
      this.dashboard?.refreshRepos();
    }
  }

  /**
   * Run one full sync (main vault + every autoSync submodule) right after
   * the plugin loads, so opening Obsidian pulls the latest remote state
   * instead of waiting up to autoSyncInterval minutes for the timer.
   * Skipped when the user hasn't completed setup, has no remote configured,
   * or has disabled it in Settings.
   */
  private async syncOnStartupIfEnabled(): Promise<void> {
    if (!this.settings.syncOnStartup) return;
    if (!this.settings.setupComplete) return;
    if (!this.settings.mainRepoUrl && this.settings.submodules.length === 0) return;
    if (this.scheduler.isRunning) return;
    await this.scheduler.run();
  }

  /**
   * Inline init/save of the main vault repo from the Settings page.
   * Replaces the SetupWizard's repo step for the simple case:
   *   - save URL + branch to settings (writes data.json AND .github-sync.json)
   *   - rebuild GitManager with the new URL
   *   - point origin at the new URL (init the repo if it doesn't exist yet)
   *   - run one vault sync — handles the empty-remote first-push case
   */
  async connectMainRepo(url: string, branch: string): Promise<void> {
    const cleanUrl = url.trim();
    const cleanBranch = (branch.trim() || "main");
    if (!cleanUrl) throw new Error("Repository URL is required.");

    this.settings.mainRepoUrl = cleanUrl;
    this.settings.mainRepoBranch = cleanBranch;
    this.settings.setupComplete = true;
    await this.saveSettings();
    this.reinitGit();

    // If the remote is a brand-new empty GitHub repo, push a README via
    // the Contents API first. Without this, the user's chosen branch
    // might not exist on the remote when the local push tries to
    // --set-upstream — and even when it works, the regular (non-initial)
    // sync path's pull would fail on "couldn't find remote ref" until
    // the first push lands.
    await ensureRemoteHasCommits(cleanUrl, this.settings.githubToken);

    await this.gitManager.setOrigin(cleanUrl, cleanBranch);
    await this.scheduler.runVault("chore: initial vault sync");
  }

  /**
   * Register and clone a new submodule, then push the parent vault so
   * other machines pick it up. `submoduleManager.add()` only stages
   * .gitmodules + the submodule pointer locally; without a follow-up
   * vault sync those would just sit in the index until the next manual
   * sync. saveSettings() also writes .github-sync.json — same problem.
   */
  async addSubmodule(config: SubmoduleConfig): Promise<void> {
    await this.submoduleManager.add(config);
    this.settings.submodules.push(config);
    await this.saveSettings();
    try {
      await this.scheduler.runVault(`chore: add submodule ${config.localPath}`);
    } catch { /* swallow — settings are saved either way */ }
    this.dashboard?.refreshRepos();
  }

  async removeSubmodule(id: string): Promise<void> {
    const sub = this.settings.submodules.find((s) => s.id === id);
    if (!sub) return;
    try {
      await this.submoduleManager.remove(sub.localPath);
      this.settings.submodules = this.settings.submodules.filter((s) => s.id !== id);
      await this.saveSettings();
      // Push parent change so other machines pick up the removal.
      try {
        await this.scheduler.runVault(`chore: remove submodule ${sub.localPath}`);
      } catch { /* swallow — settings are saved either way */ }
      new Notice(`Removed ${sub.localPath}`);
      this.dashboard?.refreshRepos();
    } catch (e) {
      new Notice(`Couldn't remove ${sub.localPath}: ${(e as Error).message}`, 8000);
      throw e;
    }
  }

  /** Surface any pre-existing merge conflicts so Resolve buttons appear without needing a manual sync. */
  async checkExistingConflicts(): Promise<void> {
    try {
      const conflicts = await this.gitManager.listConflicts();
      if (conflicts.length > 0) {
        this.dashboard?.onProgress(VAULT_REPO_ID, {
          phase: "conflict",
          message: `Merge conflict in ${conflicts.length} file(s). Click Resolve.`,
          conflicts,
        });
      }
    } catch { /* not a git repo yet */ }

    for (const sub of this.settings.submodules) {
      try {
        const conflicts = await this.submoduleManager.listConflicts(sub);
        if (conflicts.length > 0) {
          this.dashboard?.onProgress(sub.id, {
            phase: "conflict",
            message: `Merge conflict in ${conflicts.length} file(s). Click Resolve.`,
            conflicts,
          });
        }
      } catch { /* submodule not initialised */ }
    }
  }

  private initGit(vaultPath: string): void {
    const configDir = this.app.vault.configDir;
    const providers = this.buildAIProviders();
    this.gitManager = new GitManager(
      vaultPath,
      this.settings.gitUser,
      this.settings.gitEmail,
      this.settings.githubToken,
      configDir,
      providers
    );
    this.submoduleManager = new SubmoduleManager(
      vaultPath,
      this.settings.gitUser,
      this.settings.gitEmail,
      this.settings.githubToken,
      configDir
    );
  }

  private buildAIProviders(): AIProvider[] {
    const ai = this.settings.ai;
    const providers: AIProvider[] = [];
    if (ai.deepseekToken) {
      providers.push(new DeepSeekProvider({ token: ai.deepseekToken, model: ai.deepseekModel }));
    }
    if (ai.geminiToken) {
      providers.push(new GeminiProvider({ token: ai.geminiToken, model: ai.geminiModel }));
    }
    return providers;
  }

  reinitGit(): void {
    const vaultPath = this.getVaultPath();
    this.initGit(vaultPath);
    this.scheduler = new SyncScheduler(
      this.gitManager,
      this.submoduleManager,
      () => this.settings
    );
    this.scheduler.onStatus((id, progress) => {
      if (id === VAULT_REPO_ID) this.statusBar.setPhase(progress.phase, progress.message);
      this.dashboard?.onProgress(id, progress);
    });
    this.scheduler.onComplete((id, result) => this.recordHistoryFromResult(id, result));
    this.scheduler.setBetweenVaultAndSubsHook(async () => {
      await this.reloadRepoConfigOnly();
      await this.autoInitSubmodules();
    });
    this.scheduler.setAutoResolver((repoId, conflicts) => this.attemptAutoResolve(repoId, conflicts));
    this.scheduler.start();
    this.dashboard?.refreshRepos();
  }

  getRepoOps(repoId: string): ConflictRepoOps | null {
    if (repoId === VAULT_REPO_ID) {
      return this.buildVaultOps();
    }
    const sub = this.settings.submodules.find((s) => s.id === repoId);
    if (!sub) return null;
    return this.buildSubmoduleOps(sub);
  }

  private buildVaultOps(): ConflictRepoOps {
    const adapter = this.app.vault.adapter;
    const gm = this.gitManager;
    const branch = this.settings.mainRepoBranch || "main";
    return {
      readFile: (p) => adapter.read(p),
      writeFile: (p, c) => adapter.write(p, c),
      stage: (p) => gm.stagePath(p),
      abortMerge: () => gm.abortMerge(),
      commitMergedAndPush: (msg) => gm.commitMergedAndPush(branch, msg),
    };
  }

  private buildSubmoduleOps(sub: SubmoduleConfig): ConflictRepoOps {
    const adapter = this.app.vault.adapter;
    const sm = this.submoduleManager;
    // Submodule conflict paths are relative to the submodule root, but
    // vault adapter expects vault-relative — prefix it.
    const prefix = sub.localPath.replace(/\/+$/, "");
    const prefixed = (p: string) => `${prefix}/${p}`;
    return {
      readFile: (p) => adapter.read(prefixed(p)),
      writeFile: (p, c) => adapter.write(prefixed(p), c),
      stage: (p) => sm.stagePath(sub, p),
      abortMerge: () => sm.abortMerge(sub),
      commitMergedAndPush: (msg) => sm.commitMergedAndPush(sub, msg),
    };
  }

  async attemptAutoResolve(
    repoId: string,
    conflicts: string[]
  ): Promise<{ ok: true; count: number } | { ok: false }> {
    const ai = this.settings.ai;
    if (!ai.silentMode) return { ok: false };

    const client = this.getAIClient();
    if (!client.isEnabled()) {
      new Notice("Silent mode is on but no AI provider is configured — opening manual conflict modal.");
      return { ok: false };
    }

    const ops = this.getRepoOps(repoId);
    if (!ops) return { ok: false };

    const resolver = new AutoResolver(ops, client, ai.silentMinConfidence);
    const result = await resolver.resolveAll(conflicts);
    if (result.ok !== true) {
      new Notice(
        `AI couldn't fully auto-resolve: ${result.reason}. Open the dashboard to fix manually.`,
        8000
      );
      return { ok: false };
    }

    try {
      const count = await ops.commitMergedAndPush(
        `merge: AI auto-resolved ${conflicts.length} conflict(s)`
      );
      const costStr = result.totalCostUsd > 0 ? ` · ~$${result.totalCostUsd.toFixed(4)}` : "";
      new Notice(`✓ Auto-merged ${result.hunkCount} hunk(s) in ${result.fileCount} file(s)${costStr}`);
      return { ok: true, count };
    } catch (e) {
      new Notice(`Auto-resolved but commit/push failed: ${(e as Error).message}`, 8000);
      return { ok: false };
    }
  }

  async refreshStatusBarPending(): Promise<void> {
    try {
      const changes = await this.gitManager.listChanges(this.settings.ignorePatterns);
      this.statusBar.setPendingChanges(changes.total);
    } catch {
      this.statusBar.setPendingChanges(0);
    }
  }

  private async recordHistory(entry: import("./types").SyncHistoryEntry): Promise<void> {
    const limit = this.settings.historyLimit ?? 20;
    if (limit <= 0) return;
    this.settings.syncHistory = [entry, ...(this.settings.syncHistory ?? [])].slice(0, limit);
    await this.saveData(this.settings);
    this.dashboard?.refreshHistory();
  }

  private recordHistoryFromResult(
    id: string,
    result: { ok: true; count: number } | { ok: false; error: Error }
  ): void {
    const label =
      id === VAULT_REPO_ID
        ? "Main Vault"
        : this.settings.submodules.find((s) => s.id === id)?.localPath ?? id;
    let message: string;
    let filesCount = 0;
    if (result.ok === true) {
      filesCount = result.count;
      message = result.count === 0 ? "No changes" : `Synced ${result.count} file(s)`;
    } else {
      message = friendlyError(result.error.message);
    }
    void this.recordHistory({
      repoId: id,
      repoLabel: label,
      time: Date.now(),
      status: result.ok ? "success" : "error",
      filesCount,
      message,
    });
  }

  onunload() {
    this.scheduler.stop();
    if (this.pendingPollHandle) window.clearInterval(this.pendingPollHandle);
    this.statusBar?.destroy();
  }

  async loadSettings() {
    // Local layer: secrets + machine state (data.json). loadData()
    // returns `unknown` (Obsidian doesn't know our shape); merge with
    // defaults to fill in any missing fields, then trust the union.
    const local = (await this.loadData()) as Partial<GitHubSyncSettings> | null;
    let merged: GitHubSyncSettings = Object.assign({}, DEFAULT_SETTINGS, local ?? {});

    // Repo layer: structural config (.github-sync.json) overlays local
    try {
      const repoCfg = await readRepoConfig(this.app.vault.adapter, "");
      if (repoCfg) {
        merged = applyRepoConfig(merged, repoCfg);
      }
    } catch (e) {
      console.warn("[github-sync] applyRepoConfig failed:", e);
    }

    // Ensure the (possibly custom) config dir is always ignored at the
    // commit-stage filter, mirroring the .gitignore GitManager writes.
    const configGlob = `${this.app.vault.configDir}/**`;
    if (!merged.ignorePatterns.includes(configGlob)) {
      merged.ignorePatterns = [...merged.ignorePatterns, configGlob];
    }

    this.settings = merged;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Mirror repo-level fields into .github-sync.json so they travel
    // with the repo. Non-fatal if write fails (e.g., vault read-only).
    try {
      await writeRepoConfig(this.app.vault.adapter, "", settingsToRepoConfig(this.settings));
    } catch (e) {
      console.warn("[github-sync] couldn't write .github-sync.json:", e);
    }
    this.dashboard?.refreshRepos();
  }

  /**
   * Re-overlay .github-sync.json onto in-memory settings without writing
   * back to disk. Called after a successful pull so config changes from
   * other machines apply hot.
   */
  private async reloadRepoConfigOnly(): Promise<void> {
    try {
      const repoCfg = await readRepoConfig(this.app.vault.adapter, "");
      if (!repoCfg) return;
      this.settings = applyRepoConfig(this.settings, repoCfg);
      this.dashboard?.refreshRepos();
    } catch (e) {
      console.warn("[github-sync] couldn't reload repo config:", e);
    }
  }

  /**
   * One-shot migration: if the user already has settings in data.json
   * (setupComplete) but never had a .github-sync.json, generate it now
   * so their config starts traveling on the next sync.
   */
  private async migrateRepoConfigIfNeeded(): Promise<void> {
    if (!this.settings.setupComplete) return;
    try {
      const exists = await repoConfigExists(this.app.vault.adapter, "");
      if (exists) return;
      await writeRepoConfig(
        this.app.vault.adapter,
        "",
        settingsToRepoConfig(this.settings)
      );
      new Notice(
        `Created ${REPO_CONFIG_FILENAME} — your sync settings will now travel with your repo.`,
        6000
      );
    } catch (e) {
      console.warn("[github-sync] migration failed:", e);
    }
  }

  getAIClient(): AIClient {
    const ai = this.settings.ai;
    const providers: AIProvider[] = [];
    if (ai.deepseekToken) {
      providers.push(new DeepSeekProvider({ token: ai.deepseekToken, model: ai.deepseekModel }));
    }
    if (ai.geminiToken) {
      providers.push(new GeminiProvider({ token: ai.geminiToken, model: ai.geminiModel }));
    }
    return new AIClient(providers, {
      enabled: ai.enabled,
      sendFilePaths: ai.sendFilePaths,
      sendGitMetadata: ai.sendGitMetadata,
      sendSurroundingContext: ai.sendSurroundingContext,
      excludePatterns: ai.excludePatterns,
    });
  }

  private async openLocalChanges(): Promise<void> {
    try {
      const changes = await this.gitManager.listChanges(this.settings.ignorePatterns);
      if (changes.total === 0) {
        new Notice("No uncommitted changes.");
        return;
      }
      new LocalChangesModal(this.app, changes, this.gitManager).open();
    } catch (e) {
      new Notice(`Could not read changes: ${(e as Error).message}`);
    }
  }

  private async activateDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
      await this.app.workspace.revealLeaf(leaf);
    }
  }
}
