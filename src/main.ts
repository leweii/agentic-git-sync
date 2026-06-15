import { Plugin, Notice, FileSystemAdapter, Platform, setIcon, TFolder } from "obsidian";
import type { TAbstractFile } from "obsidian";
import { fs, path } from "./node-builtins";
import { EventLog, sanitizeSecrets } from "./observability/EventLog";
import { GitHubSyncSettings, DEFAULT_SETTINGS, GitHubSyncSettingTab, migrateStaleModels } from "./settings";
import { GitManager } from "./git/GitManager";
import { SubmoduleManager } from "./git/SubmoduleManager";
import { ensureRemoteHasCommits, ensureRemoteBranch, isPushPermissionError, createPullRequest, parseOwnerRepo } from "./git/githubApi";
import { SyncScheduler } from "./sync/SyncScheduler";
import { StatusBar } from "./ui/StatusBar";
import { SyncDashboard, DASHBOARD_VIEW_TYPE } from "./ui/SyncDashboard";
import { generatePRSummary } from "./ai/PRSummary";
import { LocalChangesModal } from "./ui/LocalChangesModal";
import { FileHistoryModal } from "./ui/FileHistoryModal";
import { SwitchBranchModal } from "./ui/SwitchBranchModal";
import { GitNotInstalledModal } from "./ui/GitNotInstalledModal";
import { L, tf, setLang } from "./i18n";
import { friendlyError } from "./errors";
import { VAULT_REPO_ID } from "./types";
import { AppAuth } from "./auth/AppAuth";
import { PROTOCOL_ACTION } from "./auth/constants";
import { AIClient } from "./ai/AIClient";
import { OpenAIProvider } from "./ai/OpenAIProvider";
import { GeminiProvider } from "./ai/GeminiProvider";
import { ClaudeProvider } from "./ai/ClaudeProvider";
import { DeepSeekProvider } from "./ai/DeepSeekProvider";
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
import {
  readSecrets,
  writeSecrets,
  clearSecrets,
  extractSecrets,
  applySecrets,
  redactSecrets,
  settingsHaveInlineSecrets,
} from "./config/secretStore";

export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  gitManager: GitManager;
  submoduleManager: SubmoduleManager;
  scheduler: SyncScheduler;
  /** GitHub App auth: Connect flow, deep-link handling, token provider. */
  appAuth: AppAuth;
  /** Append-only JSONL log of everything the plugin does — see EventLog. */
  eventLog: EventLog;
  private statusBar: StatusBar;
  private pendingPollHandle: number | null = null;
  /**
   * True while a user-initiated sync is in flight (Sync Now command).
   * Used so that scheduler completion handlers can distinguish foreground
   * actions — which deserve a modal when the push hits a permissions wall
   * — from background autoSync ticks, which should fail silently into the
   * history rather than nagging every 30 minutes.
   */
  private userSyncIntent = false;
  private gitNotInstalledModalShown = false;

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

  /**
   * A GitHub token valid for `url`'s owner via the active auth method
   * (App installation token, or the PAT). Returns "" when no installation
   * / PAT covers the owner — REST helpers degrade gracefully (the git
   * transport surfaces the actionable auth error, and the UI guides
   * installing the app on that owner).
   */
  async tokenForUrl(url: string): Promise<string> {
    const owner = parseOwnerRepo(url)?.owner;
    if (!owner) return "";
    try {
      return await this.appAuth.getTokenForOwner(owner);
    } catch {
      return "";
    }
  }

  async onload() {
    await this.loadSettings();
    setLang(this.settings.language ?? "en");

    // GitHub App auth: provider + Connect/deep-link plumbing. Register the
    // protocol handler early so a callback that arrives during startup
    // isn't dropped.
    this.appAuth = new AppAuth(this);
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      void this.appAuth.handleCallback(params);
    });
    this.addCommand({
      id: "connect-github-app",
      name: "Connect GitHub App",
      callback: () => void this.appAuth.beginConnect(),
    });

    const vaultPath = this.getVaultPath();
    this.eventLog = new EventLog(vaultPath, this.app.vault.configDir);

    // If user already had settings in data.json but no .github-sync.json
    // yet, generate one — runs once, then a no-op forever after.
    this.app.workspace.onLayoutReady(() => this.migrateRepoConfigIfNeeded());

    this.initGit(vaultPath);

    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.statusBar.el.onclick = () => this.activateDashboard();

    this.buildScheduler();

    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new SyncDashboard(leaf, this));

    this.addRibbonIcon("github", "Agentic Git Sync", () => this.activateDashboard());

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: async () => {
        this.eventLog?.log({ kind: "user_action", action: "command_sync_now" });
        if (this.scheduler.isRunning) {
          new Notice("Sync already in progress.");
          return;
        }
        const silent = this.settings.ai.silentMode;
        if (!silent) new Notice("Sync started…");
        this.userSyncIntent = true;
        try {
          await this.scheduler.run();
        } finally {
          this.userSyncIntent = false;
        }
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

    this.addCommand({
      id: "file-history",
      name: "Show file history",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice("No active file."); return; }
        const { gitManager, repoRelativePath } = this.resolveGitContext(file.path);
        const commits = await gitManager.getFileHistory(repoRelativePath);
        new FileHistoryModal(this.app, gitManager, repoRelativePath, file.path, commits).open();
      },
    });

    this.addSettingTab(new GitHubSyncSettingTab(this.app, this));

    this.scheduler.start();

    // Poll pending change count every 2 minutes for the status-bar badge.
    this.pendingPollHandle = window.setInterval(() => { void this.refreshStatusBarPending(); }, 120_000);
    this.app.workspace.onLayoutReady(() => {
      void this.refreshStatusBarPending();
      void this.checkExistingConflicts();
      this.refreshSubmoduleIcons();
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshSubmoduleIcons())
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.handleFolderRename(file, oldPath))
    );

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

    // Stamp pluginid into .gitmodules entries that don't have one yet.
    // Must run before reconcile so id-based lookup works on all entries.
    await this.submoduleManager.ensurePluginIds(this.settings.submodules);

    // Reconcile plugin settings from .gitmodules — this handles both
    // OS-level renames (gitfile fingerprint path changed) and any manual
    // edits to .gitmodules (e.g. URL changed directly).
    await this.reconcileSubmoduleSettings();

    // For submodules whose folder no longer exists, try to locate them by
    // the .git gitfile fingerprint (OS-level rename that happened while
    // Obsidian was closed — reconcile won't find these because .gitmodules
    // was already updated by git, but the folder is at the new path).
    const renames = await this.submoduleManager.detectRenamedPaths(this.settings.submodules);
    for (const { config, newPath } of renames) {
      const oldPath = config.localPath;
      config.localPath = newPath;
      new Notice(`Git Sync: submodule path updated\n${oldPath} → ${newPath}`);
    }
    if (renames.length > 0) await this.saveSettings();

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
   * Read .gitmodules and update any plugin settings that have drifted.
   * Called on startup and after any operation that may have changed .gitmodules.
   */
  private async reconcileSubmoduleSettings(): Promise<void> {
    const reconciled = this.submoduleManager.reconcileConfigs(this.settings.submodules);
    let changed = false;
    for (let i = 0; i < reconciled.length; i++) {
      if (
        reconciled[i].localPath !== this.settings.submodules[i].localPath ||
        reconciled[i].remoteUrl !== this.settings.submodules[i].remoteUrl
      ) {
        changed = true;
        break;
      }
    }
    if (changed) {
      this.settings.submodules = reconciled;
      await this.saveSettings();
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
    const apiToken = await this.tokenForUrl(cleanUrl);
    await ensureRemoteHasCommits(cleanUrl, apiToken);

    // If the user typed a branch that doesn't exist on the remote yet,
    // materialise it from the repo's default branch via the GitHub API.
    // git push --set-upstream alone is insufficient when the default
    // branch is protected — protected-branch hooks reject the "create"
    // half too, so the user can never get past the first push without
    // either preexisting access or this API-side branch creation.
    try {
      const r = await ensureRemoteBranch(cleanUrl, cleanBranch, apiToken);
      if (r.created) {
        new Notice(tf(L().notices.branchCreated, cleanBranch, r.defaultBranch ?? "default"));
      }
    } catch (e) {
      // Non-fatal: fall through to the git push attempt, which will
      // surface the real error if branch creation truly isn't possible.
      console.warn("[agentic-git-sync] ensureRemoteBranch failed:", (e as Error).message);
    }

    await this.gitManager.setOrigin(cleanUrl, cleanBranch);
    // Flag this as a user-initiated sync so the scheduler's completion
    // listener will open the SwitchBranchModal if the push hits a
    // protected-branch / permission wall on the target branch.
    this.userSyncIntent = true;
    try {
      await this.scheduler.runVault("chore: initial vault sync");
    } catch (e) {
      // runVault swallows errors via emitComplete, but be defensive in
      // case a future refactor lets one escape.
      if (this.maybeOfferBranchSwitch((e as Error).message, cleanBranch)) return;
      throw e;
    } finally {
      this.userSyncIntent = false;
    }
  }

  /**
   * If a sync just failed because the user can't push to the configured
   * branch (typically a protected `main`), pop a modal letting them pick
   * a different branch — we'll create it on the remote from the default
   * branch and retry the sync. Returns true when the modal was opened.
   */
  private maybeShowGitNotInstalledModal(message: string): void {
    if (this.gitNotInstalledModalShown) return;
    if (!/spawn git ENOENT|ENOENT.*git|'git' is not recognized|git: command not found/i.test(message)) return;
    this.gitNotInstalledModalShown = true;
    new GitNotInstalledModal(this.app).open();
  }

  maybeOfferBranchSwitch(errorMessage: string, branch: string): boolean {
    if (!isPushPermissionError(errorMessage)) return false;
    if (!this.settings.mainRepoUrl) return false;
    new SwitchBranchModal(this.app, this, branch, errorMessage).open();
    return true;
  }

  /**
   * Register and clone a new submodule, then push the parent vault so
   * other machines pick it up. `submoduleManager.add()` only stages
   * .gitmodules + the submodule pointer locally; without a follow-up
   * vault sync those would just sit in the index until the next manual
   * sync. saveSettings() also writes .github-sync.json — same problem.
   *
   * Settings are persisted **before** the git op so a failed clone
   * (e.g. SSO-blocked token, missing org grant) doesn't throw the
   * user's input away. The submodule then shows up in the settings
   * list with a Test button so the user can diagnose and retry from
   * there. Idempotent on re-entry so the modal's recovery path can
   * safely call this method twice with the same config.
   */
  async addSubmodule(config: SubmoduleConfig): Promise<void> {
    const alreadyKnown = this.settings.submodules.some((s) => s.id === config.id);
    if (!alreadyKnown) {
      this.settings.submodules.push(config);
      await this.saveSettings();
      this.dashboard?.refreshRepos();
    }
    await this.submoduleManager.add(config);
    try {
      await this.scheduler.runVault(`chore: add submodule ${config.localPath}`);
    } catch { /* swallow — settings are saved either way */ }
    this.dashboard?.refreshRepos();
  }

  /**
   * Apply an in-place edit to a submodule's configuration. Handles:
   *   - Remote URL change → rewrites `.gitmodules` and the submodule's
   *     own `remote.origin.url`.
   *   - Branch change → seeds the new branch on the remote via the
   *     GitHub Refs API (no-op if it already exists), so the next sync
   *     can push/pull against it cleanly.
   *   - `upstreamBranch` / `autoSync` → persisted only; no git op.
   *
   * Saves settings (which also writes `.github-sync.json`). Caller is
   * expected to trigger a sync afterwards to materialize the changes
   * (the EditSubmoduleModal does this for the user).
   */
  async updateSubmodule(
    id: string,
    changes: {
      remoteUrl: string;
      branch: string;
      upstreamBranch?: string;
      autoSync: boolean;
    },
  ): Promise<void> {
    const idx = this.settings.submodules.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error("Submodule not found.");
    const before = this.settings.submodules[idx];

    // Git-level migration: remote URL change.
    if (changes.remoteUrl !== before.remoteUrl) {
      await this.submoduleManager.setRemoteUrl(before, changes.remoteUrl);
    }

    // Git-level migration: ensure the (possibly new) branch exists on
    // the remote so subsequent sync ops have a destination ref.
    if (changes.branch !== before.branch || changes.remoteUrl !== before.remoteUrl) {
      try {
        await ensureRemoteBranch(
          changes.remoteUrl,
          changes.branch,
          await this.tokenForUrl(changes.remoteUrl),
        );
      } catch (e) {
        // Non-fatal — the next sync's recovery agent can still handle it.
        console.warn("[agentic-git-sync] ensureRemoteBranch on update failed:", (e as Error).message);
      }
    }

    this.settings.submodules[idx] = {
      ...before,
      remoteUrl: changes.remoteUrl,
      branch: changes.branch,
      upstreamBranch: changes.upstreamBranch,
      autoSync: changes.autoSync,
    };
    await this.saveSettings();
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

  /**
   * Silently create a PR after a successful submodule sync.
   * Fires for both manual and scheduled syncs. Never throws.
   * Shows a Notice only when a brand-new PR is opened; skips quietly
   * if one already exists or there are no commits to merge.
   */
  async autoCreatePRForSubmodule(id: string): Promise<void> {
    if (this.settings.usageMode !== "team") return;
    const sub = this.settings.submodules.find((s) => s.id === id);
    if (!sub?.upstreamBranch || sub.upstreamBranch === sub.branch) return;

    const prToken = await this.tokenForUrl(sub.remoteUrl);
    if (!prToken) return;

    const head = sub.branch;
    const base = sub.upstreamBranch;
    const gm = this.submoduleManager.gitManagerFor(sub);

    let title: string;
    let body = "";
    try {
      const aiProviders = this.buildAIProviders();
      if (aiProviders.some((p) => p.isAvailable())) {
        const { commits, diffStat } = await gm.branchSummary(head, base);
        const summary = await generatePRSummary(aiProviders, { head, base, commits, diffStat });
        if (summary) {
          title = summary.title;
          body = summary.body;
        } else {
          title = (await gm.lastCommitSubject(head)) || `${head} → ${base}`;
        }
      } else {
        title = (await gm.lastCommitSubject(head)) || `${head} → ${base}`;
      }
    } catch {
      title = `${head} → ${base}`;
    }

    try {
      const result = await createPullRequest({ remoteUrl: sub.remoteUrl, token: prToken, head, base, title, body });
      if (result.ok && result.url) {
        new Notice(`PR opened · ${result.url}`, 10_000);
      }
      // "already exists" and "no commits between" → silent
    } catch (e) {
      console.warn("[agentic-git-sync] auto PR failed:", (e as Error).message ?? e);
    }
  }

  /**
   * Route a set of conflicts to the dashboard so the existing
   * Resolve-button + ConflictModal flow takes over. Used by ad-hoc
   * merge entry points (e.g., the manual "Pull from..." button) that
   * don't go through the scheduler's emit pipeline.
   */
  surfaceConflict(repoId: string, conflicts: string[]): void {
    this.dashboard?.onProgress(repoId, {
      phase: "conflict",
      message: `Merge conflict in ${conflicts.length} file(s). Click Resolve.`,
      conflicts,
    });
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
    // Pass AppAuth itself — it delegates to the active provider, so a later
    // Connect (PAT → App) takes effect without rebuilding the managers.
    const tokenProvider = this.appAuth;
    this.gitManager = new GitManager(
      vaultPath,
      this.settings.gitUser,
      this.settings.gitEmail,
      tokenProvider,
      configDir,
      providers,
      this.eventLog,
      VAULT_REPO_ID,
    );
    this.submoduleManager = new SubmoduleManager(
      vaultPath,
      this.settings.gitUser,
      this.settings.gitEmail,
      tokenProvider,
      configDir,
      providers,
      this.eventLog,
    );
  }

  /**
   * Configured providers in preference order: OpenAI → Gemini → Claude →
   * DeepSeek. Does NOT check the AI master switch — use buildAIProviders for
   * paths that must respect it; AIClient enforces it internally.
   */
  private providerList(): AIProvider[] {
    const ai = this.settings.ai;
    const providers: AIProvider[] = [];
    if (ai.openaiToken) {
      providers.push(new OpenAIProvider({ token: ai.openaiToken, model: ai.openaiModel }));
    }
    if (ai.geminiToken) {
      providers.push(new GeminiProvider({ token: ai.geminiToken, model: ai.geminiModel }));
    }
    if (ai.claudeToken) {
      providers.push(new ClaudeProvider({ token: ai.claudeToken, model: ai.claudeModel }));
    }
    if (ai.deepseekToken) {
      providers.push(new DeepSeekProvider({ token: ai.deepseekToken, model: ai.deepseekModel }));
    }
    return providers;
  }

  private buildAIProviders(): AIProvider[] {
    // The master AI switch must gate every LLM path. The ReAct error-recovery
    // agent sends git metadata (error text, file names, commit messages) to
    // the provider, so "AI disabled" has to mean no provider calls at all —
    // not just no conflict suggestions.
    if (!this.settings.ai.enabled) return [];
    return this.providerList();
  }

  reinitGit(): void {
    const vaultPath = this.getVaultPath();
    this.initGit(vaultPath);
    this.buildScheduler();
    this.scheduler.start();
    this.dashboard?.refreshRepos();
  }

  /**
   * (Re)create the scheduler and wire all its callbacks. Single source of
   * truth for the wiring — onload and reinitGit used to duplicate it, and
   * the copies drifted (reinitGit's onComplete lost the status-bar pending
   * refresh, so the badge went stale after every sync once the user had
   * touched settings or the setup wizard).
   */
  private buildScheduler(): void {
    // Replacing the scheduler must kill the old timer, or every reinit
    // leaks a live interval still syncing through stale closures.
    this.scheduler?.stop();
    this.scheduler = new SyncScheduler(
      this.gitManager,
      this.submoduleManager,
      () => this.settings,
      this.eventLog,
      (url) => this.tokenForUrl(url),
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
      if (result.ok === false) {
        this.maybeShowGitNotInstalledModal(result.error.message);
      }
      if (
        this.userSyncIntent &&
        id === VAULT_REPO_ID &&
        result.ok === false
      ) {
        this.maybeOfferBranchSwitch(
          result.error.message,
          this.settings.mainRepoBranch || "main"
        );
      }
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
    this.scheduler.setAutoPR((id) => this.autoCreatePRForSubmodule(id));
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

    const resolver = new AutoResolver(ops, client, 6 - ai.silentAutonomyLevel);
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
    await this.persistLocal();
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
    this.clearSubmoduleIcons();
  }

  resolveGitContext(vaultRelativePath: string): { gitManager: GitManager; repoRelativePath: string } {
    for (const sub of this.settings.submodules) {
      const prefix = sub.localPath.replace(/\/+$/, "") + "/";
      if (vaultRelativePath.startsWith(prefix)) {
        return {
          gitManager: this.submoduleManager.gitManagerFor(sub),
          repoRelativePath: vaultRelativePath.slice(prefix.length),
        };
      }
    }
    return { gitManager: this.gitManager, repoRelativePath: vaultRelativePath };
  }

  private handleFolderRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFolder)) return;
    const affected: Array<{ sub: SubmoduleConfig; oldSub: string; newSub: string }> = [];
    for (const sub of this.settings.submodules) {
      if (sub.localPath === oldPath) {
        affected.push({ sub, oldSub: oldPath, newSub: file.path });
      } else if (sub.localPath.startsWith(oldPath + "/")) {
        affected.push({ sub, oldSub: sub.localPath, newSub: file.path + sub.localPath.slice(oldPath.length) });
      }
    }
    if (affected.length === 0) return;

    // Update plugin settings immediately — reconcileConfigs can't handle renames
    // because after renameSubmodulePath the old path is gone from .gitmodules.
    for (const { sub, newSub } of affected) sub.localPath = newSub;
    void this.saveSettings();

    // Update all git config files to match the new path.
    for (const { sub, oldSub, newSub } of affected) {
      void this.submoduleManager.renameSubmodulePath(oldSub, newSub, sub.id)
        .then(() => { new Notice(`Git Sync: submodule path updated\n${oldSub} → ${newSub}`); })
        .catch((e: Error) => {
          new Notice(`Git Sync: git config repair failed: ${e.message}`);
        });
    }
  }

  private refreshSubmoduleIcons(): void {
    const subPaths = new Set(this.settings.submodules.map(s => s.localPath));
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const container = leaf.view.containerEl;
      // Remove stale icons first
      container.querySelectorAll(".ghs-submodule-icon").forEach(el => el.remove());
      for (const p of subPaths) {
        const titleEl = container.querySelector(
          `.nav-folder[data-path="${CSS.escape(p)}"] > .nav-folder-title`
        );
        if (!titleEl) continue;
        const icon = titleEl.createDiv({ cls: "ghs-submodule-icon" });
        setIcon(icon, "git-fork");
        // Insert before the text span so it sits between arrow and label
        const textSpan = titleEl.querySelector(".nav-folder-title-content");
        if (textSpan) titleEl.insertBefore(icon, textSpan);
      }
    }
  }

  private clearSubmoduleIcons(): void {
    activeDocument.querySelectorAll(".ghs-submodule-icon").forEach(el => el.remove());
  }

  async loadSettings() {
    // Local layer: secrets + machine state (data.json). loadData()
    // returns `unknown` (Obsidian doesn't know our shape); merge with
    // defaults to fill in any missing fields, then trust the union.
    const local = (await this.loadData()) as Partial<GitHubSyncSettings> | null;
    let merged: GitHubSyncSettings = Object.assign({}, DEFAULT_SETTINGS, local ?? {});

    // Installs that predate authMethod (pre-1.3.22) have a PAT saved but
    // no explicit method — keep them on "pat" instead of the new
    // "githubApp" default, or their working auth would silently break.
    if (local && local.authMethod === undefined && local.githubToken) {
      merged.authMethod = "pat";
    }

    // Migrate retired model names so users who installed an older
    // version don't get HTTP 404s when their saved provider model has
    // been sunset upstream. The model field has no UI yet, so any
    // value that matches a known old default is "stale by default,
    // not explicit choice" — safe to bump silently.
    merged.ai = migrateStaleModels({ ...DEFAULT_SETTINGS.ai, ...merged.ai });

    // Repo layer: structural config (.github-sync.json) overlays local
    try {
      const repoCfg = await readRepoConfig(this.app.vault.adapter, "");
      if (repoCfg) {
        merged = applyRepoConfig(merged, repoCfg);
        // Re-run migration after the repo overlay — .github-sync.json
        // saved by an older install can re-introduce a sunset model.
        merged.ai = migrateStaleModels(merged.ai);
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

    // Secret layer: credentials live in a per-device file OUTSIDE the vault
    // (see config/secretStore.ts) so they never travel with the synced repo.
    // The external store is the source of truth when present; otherwise we
    // bootstrap it from whatever was inline in data.json.
    const basePath = this.vaultBasePath();
    const inlineSecrets = settingsHaveInlineSecrets(local);
    if (basePath) {
      const stored = readSecrets(basePath);
      if (stored) applySecrets(merged, stored);
      this.settings = merged;
      // One-time migration / cleanup: if data.json still carried any secret
      // (old installs, or a copied vault), move it to the external store and
      // rewrite data.json without it. This is what de-fangs leaked configs.
      if (inlineSecrets || !stored) {
        await this.persistLocal();
      }
    } else {
      // No filesystem adapter (shouldn't happen on desktop): fall back to
      // keeping secrets inline so we never silently drop them.
      this.settings = merged;
    }
  }

  /** Absolute path of the open vault, or null if not a filesystem vault. */
  private vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /**
   * Persist machine-local state: secrets to the external per-device store,
   * everything else (redacted) to data.json. When no filesystem adapter is
   * available, falls back to writing the full settings inline.
   */
  private async persistLocal(): Promise<void> {
    const basePath = this.vaultBasePath();
    if (basePath) {
      try {
        writeSecrets(basePath, extractSecrets(this.settings));
      } catch (e) {
        console.warn("[github-sync] couldn't write secret store:", e);
      }
      await this.saveData(redactSecrets(this.settings));
    } else {
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.persistLocal();
    // Mirror repo-level fields into .github-sync.json so they travel
    // with the repo. Non-fatal if write fails (e.g., vault read-only).
    try {
      await writeRepoConfig(this.app.vault.adapter, "", settingsToRepoConfig(this.settings));
    } catch (e) {
      console.warn("[github-sync] couldn't write .github-sync.json:", e);
    }
    this.dashboard?.refreshRepos();
    this.refreshSubmoduleIcons();
  }

  /**
   * Hard reset for when the plugin is wedged. Does three things:
   *  1. Renames each submodule directory wholesale to <path>.reset-<ts>/
   *     — the directory, its working tree, its .git gitfile, and any
   *     repo-config files all move together. Effectively "remove the
   *     submodule" while keeping a recoverable backup.
   *  2. Renames the main vault's .git/ to .git.reset-<ts>/ and deletes the
   *     top-level .github-sync.json. The vault root itself stays.
   *  3. Rewrites data.json with DEFAULT_SETTINGS so the plugin starts fresh.
   *
   * User notes (markdown files in the main vault) are NEVER touched.
   * Submodule contents are MOVED (not deleted) — recover by renaming
   * <path>.reset-<ts>/ back to <path>/.
   *
   * Caller should prompt the user to disable + re-enable the plugin afterwards
   * so the in-memory GitManager / SubmoduleManager re-initialise cleanly.
   */
  /**
   * Build a self-contained bug report (manifest info + sanitised event logs).
   * Returns BOTH the full content and a backup file path. The caller embeds
   * the content directly in the mailto body — mailto: doesn't support
   * attachments, so inline is the only way the user gets a single-click flow.
   *
   * Privacy: event log is already sanitised (tokens stripped). data.json is
   * NEVER included.
   */
  async bundleBugReport(): Promise<{ filePath: string; content: string }> {
    const vaultPath = this.getVaultPath();
    const configDir = this.app.vault.configDir;
    const logDir = path.join(vaultPath, configDir, "plugins", "agentic-git-sync", "event-log");
    const reportDir = path.join(vaultPath, configDir, "plugins", "agentic-git-sync", "bug-reports");
    fs.mkdirSync(reportDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(reportDir, `bug-report-${ts}.txt`);

    const sections: string[] = [];
    sections.push("=== Agentic Git Sync — Bug Report ===");
    sections.push(`Time: ${new Date().toISOString()}`);
    sections.push(`Plugin: ${this.manifest.id}@${this.manifest.version}`);
    sections.push(`Obsidian: ${(this.app as unknown as { appVersion?: string }).appVersion ?? "unknown"}`);
    sections.push(`Platform: ${Platform.isWin ? "Windows" : Platform.isMacOS ? "macOS" : Platform.isLinux ? "Linux" : "unknown"}`);
    sections.push("");
    sections.push("=== Configured submodules ===");
    for (const s of this.settings.submodules) {
      sections.push(`  ${s.localPath}  branch=${s.branch}  upstream=${s.upstreamBranch ?? "(none)"}`);
    }
    sections.push("");
    sections.push("=== AI providers ===");
    sections.push(`  deepseek: ${this.settings.ai.deepseekToken ? this.settings.ai.deepseekModel : "(not configured)"}`);
    sections.push(`  gemini:   ${this.settings.ai.geminiToken ? this.settings.ai.geminiModel : "(not configured)"}`);
    sections.push(`  openai:   ${this.settings.ai.openaiToken ? this.settings.ai.openaiModel : "(not configured)"}`);
    sections.push("");

    try {
      const files = fs.readdirSync(logDir)
        .filter((n) => n.endsWith(".jsonl"))
        .sort();
      for (const f of files) {
        sections.push(`=== ${f} ===`);
        try {
          sections.push(fs.readFileSync(path.join(logDir, f), "utf8"));
        } catch (e) {
          sections.push(`<could not read: ${(e as Error).message}>`);
        }
        sections.push("");
      }
      if (files.length === 0) {
        sections.push("=== (no event log files found) ===");
      }
    } catch {
      sections.push("=== (event log directory missing) ===");
    }

    // Belt-and-braces: log lines are sanitized at write time, but files from
    // before that fix (7-day retention) may still carry credentials.
    const content = sanitizeSecrets(sections.join("\n"));
    fs.writeFileSync(file, content);
    this.eventLog?.log({
      kind: "user_action",
      action: "bundle_bug_report",
      reportFile: file,
      contentChars: content.length,
    });
    return { filePath: file, content };
  }

  /**
   * One-click bug-report flow: bundle log, open user's mail client prefilled
   * to lewei.me@gmail.com with the log content inline in the body. Returns
   * a status the UI uses to surface an appropriate Notice.
   */
  async openBugReportEmail(): Promise<{
    ok: boolean;
    truncated: boolean;
    filePath: string;
    error?: string;
  }> {
    this.eventLog?.log({ kind: "user_action", action: "click_report_bug" });
    let bundle: { filePath: string; content: string };
    try {
      bundle = await this.bundleBugReport();
    } catch (e) {
      return { ok: false, truncated: false, filePath: "", error: (e as Error).message };
    }

    const intro =
      "Briefly, what went wrong:\n\n\n\n" +
      "Steps to reproduce (if you can):\n\n\n\n" +
      "---\n" +
      "Below is an auto-generated diagnostic dump. Tokens were stripped.\n" +
      "---\n\n";
    const trimmed = trimForMailto(bundle.content, intro);
    const body = encodeURIComponent(intro + trimmed.content);
    const subject = encodeURIComponent("Agentic Git Sync — bug report");
    const mailto = `mailto:lewei.me@gmail.com?subject=${subject}&body=${body}`;

    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    if (req) {
      try {
        const electron = req("electron") as {
          shell?: { openExternal?: (url: string) => Promise<void> };
        };
        await electron?.shell?.openExternal?.(mailto);
        return { ok: true, truncated: trimmed.truncated, filePath: bundle.filePath };
      } catch (e) {
        return {
          ok: false,
          truncated: trimmed.truncated,
          filePath: bundle.filePath,
          error: (e as Error).message,
        };
      }
    }
    return {
      ok: false,
      truncated: trimmed.truncated,
      filePath: bundle.filePath,
      error: "Electron shell unavailable",
    };
  }

  async resetEverything(): Promise<{ backupPaths: string[]; cleared: string[] }> {
    this.eventLog?.log({ kind: "user_action", action: "reset_plugin" });
    const vaultPath = this.getVaultPath();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPaths: string[] = [];
    const cleared: string[] = [];

    // Snapshot submodule local paths before settings get reset.
    const subPaths = this.settings.submodules.map((s) => s.localPath);

    // 1. Each submodule directory moves wholesale to <path>.reset-<ts>/
    for (const subPath of subPaths) {
      const abs = path.join(vaultPath, subPath);
      try {
        fs.statSync(abs);
        const backup = `${abs}.reset-${ts}`;
        fs.renameSync(abs, backup);
        backupPaths.push(backup);
      } catch { /* directory missing — skip */ }
    }

    // 2. Main vault .git/ + top-level repo config
    const mainGit = path.join(vaultPath, ".git");
    try {
      fs.statSync(mainGit);
      const backup = path.join(vaultPath, `.git.reset-${ts}`);
      fs.renameSync(mainGit, backup);
      backupPaths.push(backup);
    } catch { /* no .git at root — skip */ }

    const mainCfg = path.join(vaultPath, REPO_CONFIG_FILENAME);
    try {
      fs.unlinkSync(mainCfg);
      cleared.push(mainCfg);
    } catch { /* absent — skip */ }

    // 3. Reset in-memory + on-disk settings to defaults. saveData() (not
    // saveSettings()) — we deliberately skip the .github-sync.json write
    // because we just deleted it. Also delete the external secret store so
    // the reset truly erases credentials, not just the redacted data.json.
    const basePath = this.vaultBasePath();
    if (basePath) clearSecrets(basePath);
    this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as GitHubSyncSettings;
    await this.saveData(this.settings);
    this.dashboard?.refreshRepos();
    return { backupPaths, cleared };
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
    return new AIClient(this.providerList(), {
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

/**
 * mailto: body budget. macOS Mail handles ~50 KB encoded reliably; we aim
 * for ~30 KB raw to stay safely inside that. The full content is always
 * saved to disk so the user can recover the trimmed parts if needed.
 */
const MAX_BODY_CHARS = 30_000;

function trimForMailto(content: string, intro: string): { content: string; truncated: boolean } {
  const budget = MAX_BODY_CHARS - intro.length;
  if (content.length <= budget) return { content, truncated: false };

  const eventsStart = content.indexOf("=== ");
  const headerEnd = eventsStart > 0 ? content.indexOf("=== ", eventsStart + 1) : -1;
  const headerPart = headerEnd > 0 ? content.slice(0, headerEnd) : "";
  const eventsPart = headerEnd > 0 ? content.slice(headerEnd) : content;

  const eventsBudget = budget - headerPart.length - 200;
  if (eventsBudget <= 0) {
    return { content: content.slice(0, budget) + "\n\n[...truncated]", truncated: true };
  }
  const tail = eventsPart.slice(-eventsBudget);
  const firstNl = tail.indexOf("\n");
  const trimmedTail = firstNl >= 0 ? tail.slice(firstNl + 1) : tail;
  return {
    content:
      headerPart +
      `[...older events trimmed to fit email — full content saved locally]\n\n` +
      trimmedTail,
    truncated: true,
  };
}
