import { App, Modal, Notice, requestUrl, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import type { SubmoduleConfig } from "../settings";
import { parseOwnerRepo } from "../git/githubApi";
import { GitConflictError } from "../git/GitManager";

interface RemoteBranch {
  name: string;
  isDefault?: boolean;
}

/**
 * Manual one-shot "pull from branch X" for a submodule. Lists the
 * submodule's remote branches via the GitHub API, lets the user pick
 * one, then runs `mergeFromBranch` on the submodule's GitManager —
 * which fetches origin/<picked>, merges it into the current working
 * branch, auto-resolves system files, surfaces real conflicts through
 * the existing ConflictModal flow, and pushes the result.
 *
 * Built for the workflow where a team member is on a feature branch
 * but wants to "catch up" with the team's main branch ad-hoc, not as
 * part of every sync. (For the always-on variant, set `upstreamBranch`
 * on the submodule config — that runs inside the normal sync.)
 */
export class PullFromBranchModal extends Modal {
  private branches: RemoteBranch[] = [];
  private loading = true;
  private selected: string | null = null;
  private listEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private confirmBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private plugin: GitHubSyncPlugin,
    private config: SubmoduleConfig,
  ) {
    super(app);
    this.modalEl.addClass("ghs-pull-branch-modal");
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-pb-modal");

    // ── Header ────────────────────────────────────────────────
    const header = contentEl.createDiv("ghs-pb-header");
    const titleRow = header.createDiv("ghs-pb-title-row");
    setIcon(titleRow.createSpan({ cls: "ghs-pb-title-icon" }), "git-pull-request");
    titleRow.createEl("h3", { text: `Pull into "${this.config.localPath}"` });
    header.createEl("p", {
      cls: "ghs-pb-subtitle",
      text:
        `Choose a remote branch to merge into ` +
        `"${this.config.branch}" — the plugin will merge and push automatically.`,
    });

    // ── Branch list ───────────────────────────────────────────
    this.listEl = contentEl.createDiv("ghs-pb-list");
    this.renderLoading();

    // ── Status (loading / success / error) ────────────────────
    this.statusEl = contentEl.createDiv("ghs-pb-status ghs-hidden");

    // ── Footer with actions ───────────────────────────────────
    const footer = contentEl.createDiv("ghs-pb-footer");
    const cancel = footer.createEl("button", { text: "Cancel", cls: "ghs-pb-cancel-btn" });
    cancel.onclick = () => this.close();
    this.confirmBtn = footer.createEl("button", {
      text: "Merge and push",
      cls: "mod-cta ghs-pb-confirm-btn",
    });
    this.confirmBtn.disabled = true;
    this.confirmBtn.onclick = () => void this.confirm();

    void this.loadBranches();
  }

  private renderLoading(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const row = this.listEl.createDiv("ghs-pb-loading");
    setIcon(row.createSpan(), "loader-2");
    row.createSpan({ text: "Loading branches…" });
  }

  private async loadBranches(): Promise<void> {
    const parsed = parseOwnerRepo(this.config.remoteUrl);
    const token = this.plugin.settings.githubToken;
    if (!parsed || !token) {
      this.loading = false;
      this.renderError("Couldn't list branches — missing GitHub URL or token.");
      return;
    }
    const { owner, repo } = parsed;

    try {
      const [branchesRes, repoRes] = await Promise.all([
        requestUrl({
          url: `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
          headers: { Authorization: `token ${token}`, "User-Agent": "ObsidianGitHubSync" },
          throw: false,
        }),
        requestUrl({
          url: `https://api.github.com/repos/${owner}/${repo}`,
          headers: { Authorization: `token ${token}`, "User-Agent": "ObsidianGitHubSync" },
          throw: false,
        }),
      ]);

      if (branchesRes.status !== 200) {
        this.renderError(`GitHub returned ${branchesRes.status} listing branches.`);
        return;
      }

      const defaultBranch =
        repoRes.status === 200
          ? ((repoRes.json as { default_branch?: string } | null)?.default_branch ?? null)
          : null;

      const list = branchesRes.json as Array<{ name: string }> | null;
      const all = Array.isArray(list) ? list : [];
      this.branches = all
        // Exclude the submodule's own working branch — merging it into
        // itself is a no-op and would be confusing.
        .filter((b) => b.name !== this.config.branch)
        .map((b) => ({ name: b.name, isDefault: b.name === defaultBranch }))
        .sort((a, b) => {
          if (a.isDefault) return -1;
          if (b.isDefault) return 1;
          return a.name.localeCompare(b.name);
        });
      this.loading = false;
      this.renderList();
    } catch (e) {
      this.renderError(`Couldn't list branches: ${(e as Error).message}`);
    }
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    if (this.branches.length === 0) {
      this.listEl.createDiv({
        cls: "ghs-pb-empty",
        text: `No other branches found on this remote.`,
      });
      return;
    }
    for (const b of this.branches) {
      const row = this.listEl.createDiv("ghs-pb-row");
      row.dataset.branch = b.name;
      const radio = row.createEl("input", {
        cls: "ghs-pb-radio",
        attr: { type: "radio", name: "ghs-pb-branch" },
      });
      const branchIcon = row.createSpan({ cls: "ghs-pb-branch-icon" });
      setIcon(branchIcon, "git-branch");
      const labelWrap = row.createDiv("ghs-pb-branch-label");
      labelWrap.createSpan({ cls: "ghs-pb-branch-name", text: b.name });
      if (b.isDefault) {
        labelWrap.createSpan({ cls: "ghs-pb-default-tag", text: "default" });
      }
      const pick = () => {
        this.selected = b.name;
        const others = this.listEl!.querySelectorAll<HTMLInputElement>("input[type=radio]");
        others.forEach((el) => { el.checked = false; });
        radio.checked = true;
        const rows = this.listEl!.querySelectorAll<HTMLDivElement>(".ghs-pb-row");
        rows.forEach((el) => { el.removeClass("is-selected"); });
        row.addClass("is-selected");
        if (this.confirmBtn) this.confirmBtn.disabled = false;
      };
      row.onclick = pick;
      radio.onclick = (e) => { e.stopPropagation(); pick(); };
    }
  }

  private renderError(msg: string): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const row = this.listEl.createDiv("ghs-pb-error");
    setIcon(row.createSpan(), "alert-circle");
    row.createSpan({ text: msg });
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

  private async confirm(): Promise<void> {
    if (!this.selected) return;
    const source = this.selected;
    this.confirmBtn?.setAttribute("disabled", "true");
    this.showStatus(`Merging origin/${source} into ${this.config.branch}…`, "loading");

    try {
      await this.plugin.submoduleManager.mergeFromBranch(this.config, source);
      this.showStatus(`Merged ${source} → ${this.config.branch} and pushed.`, "success");
      new Notice(`Merged "${source}" into "${this.config.branch}" on ${this.config.localPath}.`);
      this.close();
    } catch (e) {
      if (e instanceof GitConflictError) {
        // Surface to the dashboard so the existing ConflictModal flow takes over.
        this.plugin.surfaceConflict(this.config.id, e.conflicts);
        new Notice(`Merge produced conflicts — open the dashboard to resolve.`, 8000);
        this.close();
        return;
      }
      this.confirmBtn?.removeAttribute("disabled");
      this.showStatus(`Failed: ${(e as Error).message}`, "error");
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

