import { ItemView, Modal, Notice, WorkspaceLeaf, setIcon, TFile } from "obsidian";
import { SetupWizard } from "./SetupWizard";
import type { FileCommit } from "../git/GitManager";
import type { GitManager } from "../git/GitManager";
import type GitHubSyncPlugin from "../main";
import type { PendingChanges, SyncPhase, SyncProgress } from "../types";
import { VAULT_REPO_ID } from "../types";
import { AddSubmoduleModal } from "./AddSubmoduleModal";
import { FileHistoryModal } from "./FileHistoryModal";
import { ConflictModal } from "./ConflictModal";
import { SyncPreviewModal } from "./SyncPreviewModal";
import { timeAgo } from "./StatusBar";
import { friendlyError } from "../errors";
import { L } from "../i18n";

export const DASHBOARD_VIEW_TYPE = "github-sync-dashboard";

interface RepoCardState {
  id: string;
  label: string;
  remote: string;
  phase: SyncPhase;
  phaseMessage: string;
  lastSynced: number | null;
  pendingChanges: number;
  errorMsg?: string;
  conflicts?: string[];
  expanded: boolean;
}

interface CardRefs {
  state: RepoCardState;
  dot: HTMLElement;
  meta: HTMLElement;
  phaseLabel: HTMLElement;
  errorRow: HTMLElement;
  errorText: HTMLElement;
  actions: HTMLElement;
  syncBtn: HTMLButtonElement;
  previewBtn: HTMLButtonElement;
}

export class SyncDashboard extends ItemView {
  private cards = new Map<string, CardRefs>();
  private listEl: HTMLElement | null = null;
  private historyEl: HTMLElement | null = null; // kept for main.ts compat; no longer rendered
  private emptyEl: HTMLElement | null = null;
  private tickHandle: number | null = null;

  // File history panel state
  private ghSectionEl: HTMLElement | null = null;
  private ghTitleEl: HTMLElement | null = null;
  private ghListEl: HTMLElement | null = null;
  private ghCurrentFile: string | null = null;
  private ghAnchorIdx: number | null = null;
  private ghRangeEndIdx: number | null = null;
  private ghCommits: FileCommit[] = [];
  private ghGitManager: GitManager | null = null;
  private ghRepoRelativePath: string | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: GitHubSyncPlugin) {
    super(leaf);
  }

  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  getDisplayText(): string { return "Agentic Git Sync"; }
  getIcon(): string { return "github"; }

  async onOpen(): Promise<void> {
    this.render();
    // Auto-refresh relative timestamps every 30s.
    this.tickHandle = window.setInterval(() => this.refreshTimestamps(), 30_000);
    // Probe pending changes once on open so card meta is accurate.
    void this.refreshPendingCounts();
    // Surface any pre-existing merge conflicts immediately on open.
    void this.plugin.checkExistingConflicts();

    // File history: track the active file
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => void this.ghRefresh(file))
    );
    void this.ghRefresh(this.app.workspace.getActiveFile());
  }

  async onClose(): Promise<void> {
    if (this.tickHandle) window.clearInterval(this.tickHandle);
    this.contentEl.empty();
    this.cards.clear();
  }

  // ── Public API used by plugin ───────────────────────────────

  onProgress(id: string, progress: SyncProgress): void {
    const card = this.cards.get(id);
    if (!card) return;
    card.state.phase = progress.phase;
    card.state.phaseMessage = progress.message ?? "";
    if (progress.phase === "synced") {
      card.state.lastSynced = Date.now();
      card.state.errorMsg = undefined;
      card.state.conflicts = undefined;
    }
    if (progress.phase === "error" || progress.phase === "conflict") {
      card.state.errorMsg = progress.message;
      card.state.conflicts = progress.conflicts;
    }
    this.applyCard(card);
  }

  refreshRepos(): void {
    this.render();
    void this.refreshPendingCounts();
  }

  // ── Render (one-time) ────────────────────────────────────────

  private render(): void {
    // Preserve live card states (conflict/error phases survive a refresh).
    const savedStates = new Map<string, Pick<RepoCardState, "phase" | "phaseMessage" | "errorMsg" | "conflicts" | "lastSynced" | "pendingChanges">>();
    for (const [id, refs] of this.cards) {
      const { phase, phaseMessage, errorMsg, conflicts, lastSynced, pendingChanges } = refs.state;
      savedStates.set(id, { phase, phaseMessage, errorMsg, conflicts, lastSynced, pendingChanges });
    }

    const { contentEl } = this;
    contentEl.empty();
    this.cards.clear();

    const root = contentEl.createDiv("ghs-dashboard");

    // Header
    const header = root.createDiv("ghs-dashboard-header");
    header.createEl("h4", { text: "Agentic Git Sync" });
    const headerActions = header.createDiv("ghs-dashboard-header-actions");
    const addSubBtn = headerActions.createEl("button", { cls: "ghs-icon-btn", attr: { title: L().settings.addSubTitle } });
    setIcon(addSubBtn, "plus");
    addSubBtn.onclick = () => new AddSubmoduleModal(this.app, this.plugin).open();

    const syncAllBtn = headerActions.createEl("button", { cls: "ghs-icon-btn", attr: { title: "Sync all now" } });
    setIcon(syncAllBtn, "refresh-cw");
    syncAllBtn.onclick = () => this.syncAll();

    // List
    this.listEl = root.createDiv("ghs-repo-list");
    this.emptyEl = null;

    const { settings } = this.plugin;
    if (settings.mainRepoUrl) {
      const saved = savedStates.get(VAULT_REPO_ID);
      this.addCard({
        id: VAULT_REPO_ID,
        label: "Main Vault",
        remote: settings.mainRepoUrl,
        phase: saved?.phase ?? "idle",
        phaseMessage: saved?.phaseMessage ?? "",
        errorMsg: saved?.errorMsg,
        conflicts: saved?.conflicts,
        lastSynced: saved?.lastSynced ?? null,
        pendingChanges: saved?.pendingChanges ?? 0,
        expanded: false,
      });
    }
    for (const sub of settings.submodules) {
      const saved = savedStates.get(sub.id);
      this.addCard({
        id: sub.id,
        label: sub.localPath,
        remote: sub.remoteUrl,
        phase: saved?.phase ?? "idle",
        phaseMessage: saved?.phaseMessage ?? "",
        errorMsg: saved?.errorMsg,
        conflicts: saved?.conflicts,
        lastSynced: saved?.lastSynced ?? null,
        pendingChanges: saved?.pendingChanges ?? 0,
        expanded: false,
      });
    }

    if (this.cards.size === 0) {
      this.emptyEl = this.listEl.createDiv("ghs-empty");
      const emptyIcon = this.emptyEl.createDiv({ cls: "ghs-empty-icon" });
      setIcon(emptyIcon, "git-branch");
      this.emptyEl.createEl("p", { text: "No repositories configured yet." });
      const openSettings = this.emptyEl.createEl("button", { text: L().dashboard.openSetupWizard, cls: "mod-cta" });
      openSettings.onclick = () => new SetupWizard(this.app, this.plugin).open();
    }

    // File History panel section
    this.ghSectionEl = root.createDiv("ghs-gh-section");
    const ghHeader = this.ghSectionEl.createDiv("ghs-gh-header");
    const ghIconWrap = ghHeader.createSpan("ghs-gh-icon");
    setIcon(ghIconWrap, "history");
    this.ghTitleEl = ghHeader.createSpan({ cls: "ghs-gh-title", text: "File History" });
    const expandBtn = ghHeader.createEl("button", { cls: "ghs-gh-expand-btn", attr: { title: "Open in full view" } });
    setIcon(expandBtn, "maximize-2");
    expandBtn.onclick = () => this.ghOpenModal();

    // Commit list
    this.ghListEl = this.ghSectionEl.createDiv("ghs-gh-list");

    // Restore displayed file name and commits if a file was already loaded
    // (render() is called during sync, and we must not wipe the user's view).
    if (this.ghCurrentFile) {
      const parts = this.ghCurrentFile.split("/");
      this.ghTitleEl.textContent = parts[parts.length - 1];
      this.ghTitleEl.title = this.ghCurrentFile;
    }
    if (this.ghCurrentFile && this.ghCommits.length > 0) {
      this.ghRenderList();
    } else {
      this.ghListEl.createDiv({ cls: "ghs-gh-empty", text: "Open a file to see its history." });
    }
  }

  private addCard(state: RepoCardState): void {
    if (!this.listEl) return;
    const card = this.listEl.createDiv("ghs-repo-card");

    const cardHeader = card.createDiv("ghs-repo-card-header");
    const title = cardHeader.createDiv("ghs-repo-card-title");
    const dot = title.createDiv({ cls: "ghs-status-dot" });
    title.createSpan({ text: state.label, cls: "ghs-repo-card-label" });
    const phaseLabel = title.createSpan({ cls: "ghs-repo-card-phase" });

    const actions = cardHeader.createDiv("ghs-repo-card-actions");
    const previewBtn = actions.createEl("button", {
      cls: "ghs-icon-btn",
      attr: { title: "Preview changes" },
    });
    setIcon(previewBtn, "eye");
    previewBtn.onclick = () => this.openPreview(state.id);

    const syncBtn = actions.createEl("button", {
      cls: "ghs-icon-btn",
      attr: { title: `Sync ${state.label}` },
    });
    setIcon(syncBtn, "refresh-cw");
    syncBtn.onclick = () => this.syncOne(state.id);

    // Submodule cards get a remove button — main vault is removed via
    // Settings. Cross-branch merges run automatically via upstreamBranch
    // during sync; no separate "Pull from..." button needed.
    if (state.id !== VAULT_REPO_ID) {
      const removeBtn = actions.createEl("button", {
        cls: "ghs-icon-btn",
        attr: { title: `Remove ${state.label}` },
      });
      setIcon(removeBtn, "trash-2");
      removeBtn.onclick = () => this.confirmRemove(state.id, state.label);
    }

    const meta = card.createDiv("ghs-repo-card-meta");

    const errorRow = card.createDiv("ghs-repo-card-error");
    errorRow.addClass("ghs-hidden");
    const errorIcon = errorRow.createSpan({ cls: "ghs-error-icon" });
    setIcon(errorIcon, "alert-circle");
    const errorText = errorRow.createSpan({ cls: "ghs-error-text" });
    const errorActions = errorRow.createDiv("ghs-error-actions");
    const resolveBtn = errorActions.createEl("button", { text: "Resolve", cls: "ghs-resolve-btn" });
    resolveBtn.onclick = () => this.openConflict(state.id);

    const refs: CardRefs = {
      state,
      dot,
      meta,
      phaseLabel,
      errorRow,
      errorText,
      actions,
      syncBtn,
      previewBtn,
    };
    this.cards.set(state.id, refs);
    this.applyCard(refs);
  }

  // ── Incremental updates ──────────────────────────────────────

  private applyCard(refs: CardRefs): void {
    const { state, dot, meta, phaseLabel, errorRow, errorText, syncBtn, previewBtn } = refs;

    // Status dot
    dot.removeClass("synced", "syncing", "error", "idle", "conflict");
    dot.addClass(this.dotClass(state.phase));

    // Phase label
    if (isInFlight(state.phase)) {
      phaseLabel.setText(state.phaseMessage || labelForPhase(state.phase));
      syncBtn.disabled = true;
      previewBtn.disabled = true;
    } else {
      phaseLabel.setText("");
      syncBtn.disabled = false;
      previewBtn.disabled = state.pendingChanges === 0;
    }

    // Meta line
    const parts: string[] = [];
    parts.push(formatRemote(state.remote));
    if (state.lastSynced) parts.push(timeAgo(state.lastSynced));
    if (state.pendingChanges > 0 && !isInFlight(state.phase))
      parts.push(`${state.pendingChanges} pending`);
    meta.setText(parts.join(" · "));

    // Error row
    const hasError = state.phase === "error" || state.phase === "conflict";
    errorRow.toggleClass("ghs-hidden", !hasError);
    errorRow.removeClass("conflict", "error");
    if (hasError) {
      errorRow.addClass(state.phase);
      errorText.setText(friendlyError(state.errorMsg ?? ""));
      const resolveBtn = errorRow.querySelector<HTMLButtonElement>(".ghs-resolve-btn");
      if (resolveBtn) resolveBtn.toggleClass("ghs-hidden", state.phase !== "conflict");
    }
  }

  private refreshTimestamps(): void {
    for (const refs of this.cards.values()) this.applyCard(refs);
  }

  private async refreshPendingCounts(): Promise<void> {
    for (const refs of this.cards.values()) {
      try {
        if (refs.state.id === VAULT_REPO_ID) {
          const changes = await this.plugin.gitManager.listChanges(
            this.plugin.settings.ignorePatterns
          );
          refs.state.pendingChanges = changes.total;
        } else {
          const sub = this.plugin.settings.submodules.find((s) => s.id === refs.state.id);
          if (sub) {
            const changes = await this.plugin.submoduleManager.listChanges(sub);
            refs.state.pendingChanges = changes.total;
          }
        }
        this.applyCard(refs);
      } catch {
        // ignore — repo may not be initialized yet
      }
    }
    void this.plugin.refreshStatusBarPending();
  }

  // ── File History panel ────────────────────────────────────────

  refreshHistory(): void { /* recent-activity removed; kept for caller compat */ }

  private async ghRefresh(file: TFile | null): Promise<void> {
    if (!this.ghListEl || !this.ghTitleEl) return;
    if (!file) return;
    if (file.path === this.ghCurrentFile) return;

    this.ghCurrentFile = file.path;
    this.ghAnchorIdx = null;
    this.ghRangeEndIdx = null;
    this.ghCommits = [];

    const parts = file.path.split("/");
    this.ghTitleEl.textContent = parts[parts.length - 1];
    this.ghTitleEl.title = file.path;

    this.ghListEl.empty();
    this.ghListEl.createDiv({ cls: "ghs-gh-empty", text: "Loading…" });

    const { gitManager, repoRelativePath } = this.plugin.resolveGitContext(file.path);
    this.ghGitManager = gitManager;
    this.ghRepoRelativePath = repoRelativePath;

    try {
      this.ghCommits = await gitManager.getFileHistory(repoRelativePath);
    } catch {
      this.ghListEl.empty();
      this.ghListEl.createDiv({ cls: "ghs-gh-empty", text: "Failed to load history." });
      return;
    }

    this.ghRenderList();
  }

  private ghSelectedRange(): [number, number] | null {
    if (this.ghAnchorIdx === null) return null;
    const end = this.ghRangeEndIdx ?? this.ghAnchorIdx;
    return [Math.min(this.ghAnchorIdx, end), Math.max(this.ghAnchorIdx, end)];
  }

  private ghRenderList(): void {
    if (!this.ghListEl) return;
    this.ghListEl.empty();

    if (this.ghCommits.length === 0) {
      this.ghListEl.createDiv({ cls: "ghs-gh-empty", text: "No commits found for this file." });
      return;
    }

    const range = this.ghSelectedRange();
    for (let i = 0; i < this.ghCommits.length; i++) {
      const selected = range !== null && i >= range[0] && i <= range[1];
      this.ghRenderCommitRow(this.ghListEl, this.ghCommits[i], i, selected);
    }
  }

  private ghRenderCommitRow(container: HTMLElement, commit: FileCommit, idx: number, selected: boolean): void {
    const row = container.createDiv("ghs-gh-row");
    if (selected) row.addClass("is-selected");

    const originIcon = row.createSpan({ cls: "ghs-gh-origin-icon" });
    originIcon.setAttribute("aria-label", commit.isLocal ? "Local commit" : "Pulled from remote");
    setIcon(originIcon, commit.isLocal ? "upload" : "download");
    originIcon.addClass(commit.isLocal ? "is-local" : "is-remote");

    row.createSpan({ cls: "ghs-gh-hash", text: commit.hash.slice(0, 7) });
    row.createSpan({ cls: "ghs-gh-date", text: ghFormatDate(commit.date) });

    row.addEventListener("click", (e: MouseEvent) => {
      if (e.shiftKey && this.ghAnchorIdx !== null) {
        this.ghRangeEndIdx = idx;
      } else {
        this.ghAnchorIdx = idx;
        this.ghRangeEndIdx = null;
      }
      this.ghRenderList();
      this.ghOpenModal();
    });
  }

  private ghOpenModal(): void {
    if (!this.ghGitManager || !this.ghRepoRelativePath || !this.ghCurrentFile) return;
    new FileHistoryModal(
      this.app,
      this.ghGitManager,
      this.ghRepoRelativePath,
      this.ghCurrentFile,
      this.ghCommits,
      this.ghAnchorIdx,
      this.ghRangeEndIdx,
    ).open();
  }

  // ── Actions ──────────────────────────────────────────────────

  private async syncAll(): Promise<void> {
    this.plugin.eventLog?.log({ kind: "user_action", action: "click_sync_all" });
    if (this.plugin.scheduler.isRunning) {
      new Notice("Sync already in progress.");
      return;
    }
    await this.plugin.scheduler.run();
    void this.refreshPendingCounts();
  }


  private async syncOne(id: string): Promise<void> {
    this.plugin.eventLog?.log({ kind: "user_action", action: "click_sync_one", repo: id });
    // Manual click — bypass the conflict block so the user can retry on demand.
    if (id === VAULT_REPO_ID) await this.plugin.scheduler.runVault(undefined, { force: true });
    else await this.plugin.scheduler.runSubmodule(id, undefined, { force: true });
    void this.refreshPendingCounts();
  }

  private async openPreview(id: string): Promise<void> {
    const card = this.cards.get(id);
    if (!card) return;
    try {
      let changes: PendingChanges;
      if (id === VAULT_REPO_ID) {
        changes = await this.plugin.gitManager.listChanges(
          this.plugin.settings.ignorePatterns
        );
      } else {
        const sub = this.plugin.settings.submodules.find((s) => s.id === id);
        if (!sub) return;
        changes = await this.plugin.submoduleManager.listChanges(sub);
      }
      if (changes.total === 0) {
        new Notice("No changes to preview.");
        return;
      }
      new SyncPreviewModal(this.app, card.state.label, changes, async (result) => {
        // Merge excluded paths into a one-shot ignore list for this sync.
        const oldIgnore = this.plugin.settings.ignorePatterns ?? [];
        this.plugin.settings.ignorePatterns = [...oldIgnore, ...result.excludedPaths];
        try {
          if (id === VAULT_REPO_ID) await this.plugin.scheduler.runVault(result.message);
          else await this.plugin.scheduler.runSubmodule(id, result.message);
        } finally {
          this.plugin.settings.ignorePatterns = oldIgnore;
        }
        void this.refreshPendingCounts();
      }).open();
    } catch (e) {
      new Notice(`Preview failed: ${(e as Error).message}`);
    }
  }

  private openConflict(id: string): void {
    this.plugin.eventLog?.log({ kind: "user_action", action: "click_resolve", repo: id });
    const card = this.cards.get(id);
    if (!card || !card.state.conflicts || card.state.conflicts.length === 0) return;
    const ops = this.plugin.getRepoOps(card.state.id);
    if (!ops) {
      new Notice(`Couldn't open conflict modal — repo not found.`);
      return;
    }
    new ConflictModal(
      this.app,
      ops,
      card.state.conflicts,
      () => {
        // User finished the resolution flow — clear the scheduler's conflict
        // block so the next auto-cycle attempts a sync. If the conflict
        // persists, the scheduler will re-block on the next failure.
        this.plugin.scheduler.unblock(card.state.id);
        card.state.phase = "idle";
        card.state.conflicts = undefined;
        card.state.errorMsg = undefined;
        this.applyCard(card);
        void this.refreshPendingCounts();
      },
      card.state.label,
      this.plugin.getAIClient(),
      async () => {
        this.plugin.eventLog?.log({
          kind: "user_action",
          action: "click_force_clean_resync",
          repo: card.state.id,
        });
        // Force clean & resync — bypass the scheduler block (this run is
        // user-initiated) and retry the failing repo immediately.
        this.plugin.scheduler.unblock(card.state.id);
        if (card.state.id === VAULT_REPO_ID) {
          await this.plugin.scheduler.runVault(undefined, { force: true });
        } else {
          await this.plugin.scheduler.runSubmodule(card.state.id, undefined, { force: true });
        }
        void this.refreshPendingCounts();
      },
    ).open();
  }

  private dotClass(phase: SyncPhase): string {
    if (phase === "synced") return "synced";
    if (phase === "error") return "error";
    if (phase === "conflict") return "conflict";
    if (isInFlight(phase)) return "syncing";
    return "idle";
  }

  private confirmRemove(id: string, label: string): void {
    new RemoveSubmoduleModal(
      this.app,
      label,
      async () => {
        await this.plugin.removeSubmodule(id);
      }
    ).open();
  }
}

class RemoveSubmoduleModal extends Modal {
  constructor(
    app: import("obsidian").App,
    private label: string,
    private onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Remove "${this.label}"?` });
    contentEl.createEl("p", {
      text: `This will delete the local folder "${this.label}" from your vault and remove the submodule registration. The remote repository on GitHub is not affected.`,
    });
    contentEl.createEl("p", {
      cls: "mod-warning",
      text: "Any uncommitted changes inside this folder will be lost.",
    });

    const footer = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const remove = footer.createEl("button", { text: "Remove", cls: "mod-warning" });
    remove.onclick = async () => {
      remove.disabled = true;
      cancel.disabled = true;
      remove.textContent = "Removing…";
      try {
        await this.onConfirm();
        this.close();
      } catch {
        remove.disabled = false;
        cancel.disabled = false;
        remove.textContent = "Remove";
      }
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function ghFormatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dateStr = date.getFullYear() === now.getFullYear()
    ? `${MONTHS[date.getMonth()]} ${date.getDate()}`
    : `${MONTHS[date.getMonth()]} '${String(date.getFullYear()).slice(2)}`;
  if (mins < 1) return `${dateStr} · just now`;
  if (mins < 60) return `${dateStr} · ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return `${dateStr} · ${hrs}h ${remMins}m ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${dateStr} · ${days}d ago`;
  const mos = Math.floor(days / 30);
  if (mos < 12) return `${dateStr} · ${mos}mo ago`;
  return `${dateStr} · ${Math.floor(mos / 12)}y ago`;
}

function isInFlight(p: SyncPhase): boolean {
  return p === "checking" || p === "pulling" || p === "committing" || p === "pushing";
}

function labelForPhase(p: SyncPhase): string {
  switch (p) {
    case "checking": return "Checking…";
    case "pulling": return "Pulling…";
    case "committing": return "Committing…";
    case "pushing": return "Pushing…";
    default: return "";
  }
}

function formatRemote(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}

