import { App, Modal, Notice, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import type { SubmoduleConfig } from "../settings";
import { isValidGitHubUrl } from "../git/SubmoduleManager";

/**
 * Edit an existing submodule's metadata: remote URL, branch (incl.
 * auto-creating it on the remote if missing), optional auto-merge
 * source branch, and auto-sync toggle. Local path is fixed — changing
 * it would mean moving the working tree, which is out of scope.
 *
 * Saving:
 *   1. Validate inputs.
 *   2. Hand the diff to `plugin.updateSubmodule()`, which applies the
 *      git-level migration (rewriting `submodule.<path>.url` in
 *      `.gitmodules`, the submodule's `remote.origin.url`, and seeding
 *      the new branch on the remote via the API) and saves settings.
 *   3. Optionally trigger a sync so the change materializes immediately
 *      rather than on the next scheduled tick.
 */
export class EditSubmoduleModal extends Modal {
  private remoteUrl: string;
  private branch: string;
  private upstreamBranch: string;
  private autoSync: boolean;
  private saveBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLDivElement | null = null;

  constructor(
    app: App,
    private plugin: GitHubSyncPlugin,
    private config: SubmoduleConfig,
  ) {
    super(app);
    this.modalEl.addClass("ghs-edit-sub-modal");
    this.remoteUrl = config.remoteUrl;
    this.branch = config.branch;
    this.upstreamBranch = config.upstreamBranch ?? "";
    this.autoSync = config.autoSync;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-es-modal");

    // ── Header ────────────────────────────────────────────────
    const header = contentEl.createDiv("ghs-es-header");
    const titleRow = header.createDiv("ghs-es-title-row");
    setIcon(titleRow.createSpan({ cls: "ghs-es-title-icon" }), "settings-2");
    titleRow.createEl("h3", { text: `Edit "${this.config.localPath}"` });
    header.createEl("p", {
      cls: "ghs-es-subtitle",
      text: "Change the submodule's remote, branch, or upstream auto-merge source. The plugin migrates the local clone and pushes the result.",
    });

    // ── Form ──────────────────────────────────────────────────
    const body = contentEl.createDiv("ghs-es-body");

    this.formField(body, "Local path", (wrap) => {
      const input = wrap.createEl("input", { attr: { type: "text", readonly: "true" } });
      input.value = this.config.localPath;
      input.addClass("ghs-es-readonly");
      wrap.createDiv({ cls: "ghs-es-hint", text: "Cannot be changed — moving the working tree is out of scope." });
    });

    this.formField(body, "Remote URL", (wrap) => {
      const input = wrap.createEl("input", { attr: { type: "text", placeholder: "https://github.com/user/repo.git" } });
      input.value = this.remoteUrl;
      input.oninput = () => (this.remoteUrl = input.value.trim());
    });

    this.formField(body, "Branch", (wrap) => {
      const input = wrap.createEl("input", { attr: { type: "text", placeholder: "main" } });
      input.value = this.branch;
      input.oninput = () => (this.branch = input.value.trim());
      wrap.createDiv({
        cls: "ghs-es-hint",
        text: "If this branch doesn't exist on the remote yet, it'll be created from the repo's default branch.",
      });
    });

    // Upstream branch — team workflow only. Personal mode has a single
    // managed branch, so the field is hidden and any baseline is cleared
    // on save (see below).
    if (this.plugin.settings.usageMode === "team") {
      // Baseline is required in team mode; default to the working branch
      // ("work directly on the baseline") so the field is never empty.
      if (!this.upstreamBranch) this.upstreamBranch = this.branch;
      this.formField(body, "Upstream branch", (wrap) => {
        const input = wrap.createEl("input", { attr: { type: "text", placeholder: "main" } });
        input.value = this.upstreamBranch;
        input.oninput = () => (this.upstreamBranch = input.value.trim());
        wrap.createDiv({
          cls: "ghs-es-hint",
          text:
            "Every sync merges in this baseline branch before pushing. Set it the same as the branch above " +
            "to work directly on the baseline, or a different branch to absorb its updates into your own. " +
            "On conflict, the baseline wins — local edits are kept in git history (reflog).",
        });
      });
    }

    this.formField(body, "Auto-sync", (wrap) => {
      const toggle = wrap.createEl("input", { attr: { type: "checkbox" } });
      toggle.checked = this.autoSync;
      toggle.onchange = () => (this.autoSync = toggle.checked);
      wrap.createDiv({
        cls: "ghs-es-hint",
        text: "When off, this submodule is skipped by the scheduled sync timer (Sync now still includes it).",
      });
    });

    // ── Status row + footer ───────────────────────────────────
    this.statusEl = contentEl.createDiv("ghs-es-status ghs-hidden");

    const footer = contentEl.createDiv("ghs-es-footer");
    const cancel = footer.createEl("button", { text: "Cancel", cls: "ghs-es-cancel-btn" });
    cancel.onclick = () => this.close();
    this.saveBtn = footer.createEl("button", { text: "Save & sync", cls: "mod-cta ghs-es-save-btn" });
    this.saveBtn.onclick = () => void this.save();
  }

  private formField(
    parent: HTMLElement,
    label: string,
    build: (wrap: HTMLElement) => void,
  ): void {
    const wrap = parent.createDiv("ghs-es-field");
    wrap.createEl("label", { text: label });
    build(wrap);
  }

  private async save(): Promise<void> {
    // Validate
    if (!this.remoteUrl) {
      this.showStatus("Remote URL is required.", "error");
      return;
    }
    if (!isValidGitHubUrl(this.remoteUrl)) {
      this.showStatus("Doesn't look like a GitHub URL.", "error");
      return;
    }
    if (!this.branch) {
      this.showStatus("Branch is required.", "error");
      return;
    }
    const isTeam = this.plugin.settings.usageMode === "team";
    if (isTeam && !this.upstreamBranch) {
      this.showStatus("Upstream branch is required in team mode.", "error");
      return;
    }

    const changes = {
      remoteUrl: this.remoteUrl,
      branch: this.branch,
      // Team mode persists the baseline (may equal the working branch);
      // personal mode has no baseline concept.
      upstreamBranch: isTeam ? this.upstreamBranch || this.branch : undefined,
      autoSync: this.autoSync,
    };

    this.saveBtn?.setAttribute("disabled", "true");
    this.showStatus("Applying changes…", "loading");

    try {
      await this.plugin.updateSubmodule(this.config.id, changes);
      this.showStatus("Saved. Syncing…", "loading");
      try {
        await this.plugin.scheduler.runSubmodule(this.config.id);
      } catch { /* surfaces via dashboard */ }
      new Notice(`Updated "${this.config.localPath}".`);
      this.close();
    } catch (e) {
      this.saveBtn?.removeAttribute("disabled");
      this.showStatus(`Failed: ${(e as Error).message}`, "error");
    }
  }

  private showStatus(text: string, kind: "loading" | "success" | "error"): void {
    if (!this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.removeClass("ghs-hidden", "loading", "success", "error");
    this.statusEl.addClass(kind);
    const iconSpan = this.statusEl.createSpan();
    setIcon(
      iconSpan,
      kind === "success" ? "check-circle" : kind === "error" ? "alert-circle" : "loader-2",
    );
    this.statusEl.createSpan({ text });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
