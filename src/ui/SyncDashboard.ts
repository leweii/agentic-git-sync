import { ItemView, Modal, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import type { PendingChanges, SyncHistoryEntry, SyncPhase, SyncProgress } from "../types";
import { VAULT_REPO_ID } from "../types";
import { AddSubmoduleModal } from "./AddSubmoduleModal";
import { ConflictModal } from "./ConflictModal";
import { SyncPreviewModal } from "./SyncPreviewModal";
import { timeAgo } from "./StatusBar";
import { friendlyError } from "../errors";

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
  private historyEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private tickHandle: number | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: GitHubSyncPlugin) {
    super(leaf);
  }

  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  // eslint-disable-next-line obsidianmd/ui/sentence-case -- "Agentic Git Sync" is the proper product name
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

  refreshHistory(): void {
    if (this.historyEl) this.renderHistory(this.historyEl);
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
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- "Agentic Git Sync" is the proper product name
    header.createEl("h4", { text: "Agentic Git Sync" });
    const syncAllBtn = header.createEl("button", { cls: "ghs-icon-btn", attr: { title: "Sync all now" } });
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
      const openSettings = this.emptyEl.createEl("button", { text: "Open settings", cls: "mod-cta" });
      openSettings.onclick = () => {
        // app.setting is an undocumented runtime property exposed by
        // Obsidian (used by many community plugins to open the Settings
        // pane). Cast to a narrow shape rather than `any` so accidental
        // misuse elsewhere still type-errors.
        const appWithSetting = this.app as unknown as { setting?: { open?: () => void } };
        appWithSetting.setting?.open?.();
      };
    }

    // History
    const historySection = root.createDiv("ghs-history-section");
    const historyHeader = historySection.createDiv("ghs-history-header");
    historyHeader.createEl("h5", { text: "Recent activity" });
    this.historyEl = historySection.createDiv("ghs-history-list");
    this.renderHistory(this.historyEl);

    // Footer
    const footer = root.createDiv("ghs-dashboard-footer");
    const addBtn = footer.createEl("button", { cls: "ghs-add-btn" });
    const plusIcon = addBtn.createSpan();
    setIcon(plusIcon, "plus");
    addBtn.createSpan({ text: "Add Submodule" });
    addBtn.onclick = () => new AddSubmoduleModal(this.app, this.plugin).open();
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

    // Submodule cards get a remove button — main vault is removed via Settings.
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
    const copyBtn = errorActions.createEl("button", { text: "Copy", attr: { title: "Copy error" } });
    copyBtn.onclick = () => {
      const msg = this.cards.get(state.id)?.state.errorMsg ?? "";
      void navigator.clipboard.writeText(msg).then(() => new Notice("Error copied"));
    };
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

  // ── History ──────────────────────────────────────────────────

  private renderHistory(parent: HTMLElement): void {
    parent.empty();
    const history = this.plugin.settings.syncHistory ?? [];
    if (history.length === 0) {
      parent.createDiv({ cls: "ghs-history-empty", text: "No syncs yet." });
      return;
    }
    for (const entry of history.slice(0, 5)) this.renderHistoryRow(parent, entry);
  }

  private renderHistoryRow(parent: HTMLElement, entry: SyncHistoryEntry): void {
    const row = parent.createDiv(`ghs-history-row ${entry.status}`);
    const iconWrap = row.createSpan("ghs-history-icon");
    setIcon(iconWrap, entry.status === "success" ? "check-circle" : "alert-circle");
    const body = row.createDiv("ghs-history-body");
    const top = body.createDiv("ghs-history-top");
    top.createSpan({ cls: "ghs-history-repo", text: entry.repoLabel });
    top.createSpan({ cls: "ghs-history-time", text: timeAgo(entry.time) });
    body.createDiv({ cls: "ghs-history-msg", text: entry.message });
  }

  // ── Actions ──────────────────────────────────────────────────

  private async syncAll(): Promise<void> {
    if (this.plugin.scheduler.isRunning) {
      new Notice("Sync already in progress.");
      return;
    }
    await this.plugin.scheduler.run();
    void this.refreshPendingCounts();
  }

  private async syncOne(id: string): Promise<void> {
    if (id === VAULT_REPO_ID) await this.plugin.scheduler.runVault();
    else await this.plugin.scheduler.runSubmodule(id);
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
        card.state.phase = "idle";
        card.state.conflicts = undefined;
        card.state.errorMsg = undefined;
        this.applyCard(card);
        void this.refreshPendingCounts();
      },
      card.state.label,
      this.plugin.getAIClient()
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
