import { App, Modal, Notice, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { L, tf } from "../i18n";
import { ensureRemoteBranch } from "../git/githubApi";

/**
 * Surfaced when a push fails because the user lacks write access on the
 * target branch (most commonly: pushing to a protected `main`). Lets them
 * pick a new branch — the plugin materialises that branch on the remote
 * from the default branch's tip via the GitHub Git Refs API and re-runs
 * the vault sync against it.
 */
export class SwitchBranchModal extends Modal {
  private inputEl: HTMLInputElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private plugin: GitHubSyncPlugin,
    private currentBranch: string,
    private errorMessage: string,
  ) {
    super(app);
    this.modalEl.addClass("ghs-switch-branch-modal");
  }

  onOpen(): void {
    const t = L().switchBranch;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-switch-branch");

    const header = contentEl.createDiv("ghs-sb-header");
    const iconWrap = header.createDiv("ghs-sb-icon");
    setIcon(iconWrap, "alert-triangle");
    header.createEl("h3", { text: tf(t.title, this.currentBranch) });

    contentEl.createEl("p", {
      cls: "ghs-sb-desc",
      text: tf(t.desc, this.currentBranch),
    });

    if (this.errorMessage) {
      const errBox = contentEl.createDiv("ghs-sb-error");
      errBox.setText(this.errorMessage);
    }

    const label = contentEl.createEl("label", {
      cls: "ghs-sb-label",
      text: t.newBranchLabel,
    });
    this.inputEl = label.createEl("input", { attr: { type: "text" } });
    this.inputEl.placeholder = this.suggestedBranchName();
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.confirm();
      }
    });

    this.statusEl = contentEl.createDiv("ghs-sb-status ghs-hidden");

    const actions = contentEl.createDiv("ghs-sb-actions");
    const cancelBtn = actions.createEl("button", { text: L().common.cancel });
    cancelBtn.onclick = () => this.close();

    this.confirmBtn = actions.createEl("button", {
      text: t.confirmCta,
      cls: "mod-cta",
    });
    this.confirmBtn.onclick = () => void this.confirm();

    setTimeout(() => this.inputEl?.focus(), 0);
  }

  private suggestedBranchName(): string {
    const gitUser = (this.plugin.settings.gitUser || "").trim();
    if (!gitUser) return "my-vault";
    return `${gitUser.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")}/vault`;
  }

  private async confirm(): Promise<void> {
    const t = L().switchBranch;
    const raw = (this.inputEl?.value ?? "").trim();
    const branch = raw || this.suggestedBranchName();
    if (!branch || branch === this.currentBranch) {
      this.showStatus(t.sameBranch, "error");
      return;
    }
    if (!/^[\w./-]+$/.test(branch)) {
      this.showStatus(t.invalidBranch, "error");
      return;
    }

    this.confirmBtn?.setAttribute("disabled", "true");
    this.showStatus(t.working, "loading");

    try {
      const remoteUrl = this.plugin.settings.mainRepoUrl;
      if (!remoteUrl) throw new Error("No repository connected.");

      const result = await ensureRemoteBranch(
        remoteUrl,
        branch,
        await this.plugin.tokenForUrl(remoteUrl),
      );

      this.plugin.settings.mainRepoBranch = branch;
      await this.plugin.saveSettings();
      this.plugin.reinitGit();

      this.showStatus(
        result.created
          ? tf(t.createdFrom, branch, result.defaultBranch ?? "main")
          : tf(t.switchedTo, branch),
        "success",
      );

      await this.plugin.scheduler.runVault();
      new Notice(tf(t.syncedOnNewBranch, branch));
      this.close();
    } catch (e) {
      this.confirmBtn?.removeAttribute("disabled");
      this.showStatus(tf(t.failed, (e as Error).message), "error");
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
