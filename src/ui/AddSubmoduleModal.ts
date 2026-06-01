import { App, Modal, Notice, requestUrl, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { isValidGitHubUrl, normalizeRepoPath } from "../git/SubmoduleManager";
import { ensureRemoteHasCommits } from "../git/githubApi";
import { L, tf } from "../i18n";

export class AddSubmoduleModal extends Modal {
  private localPath = "";
  private remoteUrl = "";
  private branch = "main";
  private upstreamBranch = "";
  private upstreamEdited = false;
  private defaultBranch = "";
  private upInput: HTMLInputElement | null = null;
  private isTeamMode: boolean;
  private remoteStatus: "idle" | "loading" | "valid" | "invalid" = "idle";
  private remoteMsg = "";
  private remoteIsEmpty = false;
  private remoteDebounce: number | null = null;
  private pathStatus: "idle" | "ok" | "collision" = "idle";
  private submitBtn: HTMLButtonElement | null = null;

  constructor(app: App, private plugin: GitHubSyncPlugin) {
    super(app);
    this.isTeamMode = this.plugin.settings.usageMode === "team";
  }

  onOpen(): void {
    const { contentEl } = this;
    const t = L().settings;
    contentEl.empty();
    contentEl.addClass("ghs-add-modal");

    contentEl.createEl("h3", { text: t.addSubTitle });
    contentEl.createEl("p", { cls: "ghs-add-sub", text: t.addSubDesc });

    // ── Local path ─────────────────────────────────────────────
    const pathWrap = contentEl.createDiv("ghs-wizard-field");
    pathWrap.createEl("label", { text: t.addSubLocalPath });
    const pathHint = pathWrap.createDiv("ghs-field-hint");
    pathHint.setText(t.addSubLocalPathHint);
    const pathInput = pathWrap.createEl("input", { attr: { placeholder: t.addSubLocalPathPh } });
    const pathBadge = pathWrap.createDiv("ghs-inline-badge");
    pathBadge.addClass("ghs-hidden");
    pathInput.oninput = () => {
      this.localPath = normalizeRepoPath(pathInput.value.trim());
      this.checkPath(pathBadge);
      this.refreshSubmit();
    };

    // ── Remote URL ─────────────────────────────────────────────
    const urlWrap = contentEl.createDiv("ghs-wizard-field");
    urlWrap.createEl("label", { text: t.addSubRemoteUrl });
    const urlInput = urlWrap.createEl("input", { attr: { placeholder: t.addSubRemoteUrlPh } });
    const urlBadge = urlWrap.createDiv("ghs-inline-badge");
    urlBadge.addClass("ghs-hidden");
    urlInput.oninput = () => {
      this.remoteUrl = urlInput.value.trim();
      if (this.remoteDebounce) window.clearTimeout(this.remoteDebounce);
      if (!this.remoteUrl) {
        this.remoteStatus = "idle";
        this.renderRemoteBadge(urlBadge);
        this.refreshSubmit();
        return;
      }
      if (!isValidGitHubUrl(this.remoteUrl)) {
        this.remoteStatus = "invalid";
        this.remoteMsg = t.addSubUrlInvalid;
        this.renderRemoteBadge(urlBadge);
        this.refreshSubmit();
        return;
      }
      this.remoteStatus = "loading";
      this.renderRemoteBadge(urlBadge);
      this.remoteDebounce = window.setTimeout(() => { void this.probeRemote(urlBadge); }, 500);
    };

    // ── Branch ─────────────────────────────────────────────────
    const branchWrap = contentEl.createDiv("ghs-wizard-field");
    const branchLabelRow = branchWrap.createDiv("ghs-field-label-row");
    branchLabelRow.createEl("label", { text: t.addSubBranch });
    const teamBtn = branchLabelRow.createEl("button", {
      cls: `ghs-chip${this.isTeamMode ? " active" : ""}`,
      text: t.addSubTeamMode,
    });
    setIcon(teamBtn.createSpan({ cls: "ghs-chip-icon" }), "users");
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- "main" is a branch name, not UI prose
    const branchInput = branchWrap.createEl("input", { attr: { placeholder: "main" } });
    branchInput.value = "main";
    branchInput.oninput = () => (this.branch = branchInput.value.trim() || "main");

    // Upstream branch — always in DOM, shown only in team mode.
    const upWrap = contentEl.createDiv("ghs-wizard-field");
    if (!this.isTeamMode) upWrap.addClass("ghs-hidden");
    upWrap.createEl("label", { text: t.addSubUpstream });
    const upHint = upWrap.createDiv("ghs-field-hint");
    upHint.setText(t.addSubUpstreamHint);
    const upInput = upWrap.createEl("input", { attr: { placeholder: t.addSubUpstreamPh } });
    this.upInput = upInput;
    upInput.oninput = () => {
      this.upstreamBranch = upInput.value.trim();
      this.upstreamEdited = true;
      this.refreshSubmit();
    };
    // Team mode requires a baseline branch — never empty. Seed it with the
    // working-branch default now; probeRemote upgrades this to the repo's
    // real default branch once known (unless the user has typed their own).
    if (this.isTeamMode) {
      this.upstreamBranch = this.branch;
      upInput.value = this.branch;
    }

    teamBtn.onclick = () => {
      this.isTeamMode = !this.isTeamMode;
      teamBtn.toggleClass("active", this.isTeamMode);
      upWrap.toggleClass("ghs-hidden", !this.isTeamMode);
      if (this.isTeamMode) {
        if (!this.upstreamEdited) {
          this.upstreamBranch = this.defaultBranch || this.branch;
          upInput.value = this.upstreamBranch;
        }
      } else {
        this.upstreamBranch = "";
        upInput.value = "";
      }
      this.refreshSubmit();
    };

    // ── Footer ─────────────────────────────────────────────────
    const footer = contentEl.createDiv("ghs-wizard-footer");
    const cancel = footer.createEl("button", { text: t.addSubCancel });
    cancel.onclick = () => this.close();
    const submit = footer.createEl("button", { text: t.addSubAdd, cls: "mod-cta" });
    submit.disabled = true;
    submit.onclick = () => this.submit();
    this.submitBtn = submit;
  }

  private renderRemoteBadge(el: HTMLElement): void {
    el.empty();
    if (this.remoteStatus === "idle") {
      el.addClass("ghs-hidden");
      return;
    }
    el.removeClass("ghs-hidden");
    el.removeClass("valid", "invalid", "loading");
    el.addClass(this.remoteStatus);
    const iconWrap = el.createSpan();
    if (this.remoteStatus === "loading") setIcon(iconWrap, "loader-2");
    else if (this.remoteStatus === "valid") setIcon(iconWrap, "check-circle");
    else setIcon(iconWrap, "alert-circle");
    el.createSpan({ text: this.remoteMsg });
  }

  private async probeRemote(badge: HTMLElement): Promise<void> {
    const t = L().settings;
    const token = this.plugin.settings.githubToken;
    const match = this.remoteUrl.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/);
    if (!match) {
      this.remoteStatus = "invalid";
      this.remoteMsg = t.addSubUrlParse;
      this.renderRemoteBadge(badge);
      this.refreshSubmit();
      return;
    }
    const [, owner, repo] = match;
    const headers = token
      ? { Authorization: `token ${token}`, "User-Agent": "ObsidianGitHubSync" }
      : { "User-Agent": "ObsidianGitHubSync" };
    try {
      const res = await requestUrl({
        url: `https://api.github.com/repos/${owner}/${repo}`,
        headers,
        throw: false,
      });
      if (res.status === 200) {
        const commits = await requestUrl({
          url: `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`,
          headers,
          throw: false,
        });
        this.remoteIsEmpty = commits.status === 409;
        this.remoteStatus = "valid";
        this.remoteMsg = tf(t.addSubRemoteFound, `${owner}/${repo}`);
        // Auto-fill the baseline branch with the repo's default branch
        // unless the user has already typed their own value.
        this.defaultBranch = (res.json?.default_branch as string) || "";
        if (this.isTeamMode && !this.upstreamEdited && this.defaultBranch && this.upInput) {
          this.upstreamBranch = this.defaultBranch;
          this.upInput.value = this.defaultBranch;
        }
      } else if (res.status === 404) {
        this.remoteStatus = "invalid";
        this.remoteMsg = t.addSubRepoNotFound;
      } else if (res.status === 401 || res.status === 403) {
        this.remoteStatus = "invalid";
        this.remoteMsg = t.addSubNoAccess;
      } else {
        this.remoteStatus = "invalid";
        this.remoteMsg = tf(t.addSubHttpStatus, res.status);
      }
    } catch {
      this.remoteStatus = "valid";
      this.remoteMsg = t.addSubOfflineOk;
    }
    this.renderRemoteBadge(badge);
    this.refreshSubmit();
  }

  private checkPath(badge: HTMLElement): void {
    const t = L().settings;
    badge.empty();
    if (!this.localPath) {
      badge.addClass("ghs-hidden");
      this.pathStatus = "idle";
      return;
    }
    const taken = this.plugin.settings.submodules.some((s) => s.localPath === this.localPath);
    if (taken) {
      this.pathStatus = "collision";
      badge.removeClass("ghs-hidden");
      badge.removeClass("valid");
      badge.addClass("invalid");
      const iconWrap = badge.createSpan();
      setIcon(iconWrap, "alert-circle");
      badge.createSpan({ text: t.addSubPathTaken });
    } else {
      this.pathStatus = "ok";
      badge.removeClass("ghs-hidden");
      badge.removeClass("invalid");
      badge.addClass("valid");
      const iconWrap = badge.createSpan();
      setIcon(iconWrap, "check-circle");
      badge.createSpan({ text: t.addSubPathOk });
    }
  }

  private refreshSubmit(): void {
    if (!this.submitBtn) return;
    // Probe failures (404, SSO block, token scope, offline) are common
    // and don't always mean the submodule is unusable — sometimes the
    // user just hasn't authorized the token for the org yet. We let
    // them save the config anyway and diagnose from Settings → Test.
    // Still gate on basic syntactic checks to avoid persisting typos.
    const urlSyntaxOk =
      this.remoteUrl.length > 0 && isValidGitHubUrl(this.remoteUrl);
    const ok =
      this.localPath.length > 0 &&
      this.pathStatus === "ok" &&
      urlSyntaxOk &&
      // Team mode requires a baseline branch; it may equal the local branch.
      (!this.isTeamMode || this.upstreamBranch.length > 0);
    this.submitBtn.disabled = !ok;
  }

  private async submit(): Promise<void> {
    const config = {
      id: cryptoRandomId(),
      localPath: this.localPath,
      remoteUrl: this.remoteUrl,
      branch: this.branch,
      // Team mode always records a baseline branch (defaulting to the
      // working branch, which means "work directly on the baseline").
      // Personal mode has no baseline concept.
      upstreamBranch: this.isTeamMode ? this.upstreamBranch || this.branch : undefined,
      autoSync: true,
      syncInterval: this.plugin.settings.autoSyncInterval,
    };

    const t = L().settings;
    if (this.submitBtn) {
      this.submitBtn.disabled = true;
      this.submitBtn.textContent = t.addSubAdding;
    }
    try {
      if (this.remoteIsEmpty) {
        if (this.submitBtn) this.submitBtn.textContent = t.addSubPreparing;
        await ensureRemoteHasCommits(this.remoteUrl, this.plugin.settings.githubToken);
        this.remoteIsEmpty = false;
      }
      await this.plugin.addSubmodule(config);
      new Notice(tf(t.addSubAdded, this.localPath));
      this.close();
    } catch (e) {
      const raw = (e as Error).message ?? "";
      if (
        !this.remoteIsEmpty &&
        /yet to be born|unable to checkout submodule/i.test(raw)
      ) {
        try {
          if (this.submitBtn) this.submitBtn.textContent = t.addSubPreparing;
          await ensureRemoteHasCommits(this.remoteUrl, this.plugin.settings.githubToken);
          await this.plugin.addSubmodule(config);
          new Notice(tf(t.addSubAdded, this.localPath));
          this.close();
          return;
        } catch (retryErr) {
          this.finishWithSavedButUncloned(config.localPath, (retryErr as Error).message);
          return;
        }
      }
      this.finishWithSavedButUncloned(config.localPath, raw);
    }
  }

  /**
   * `plugin.addSubmodule` persists the config to settings *before*
   * attempting the git clone, so a clone failure leaves the user with
   * a saved-but-not-yet-cloned submodule. Close the modal anyway and
   * point the user at the per-submodule Test button in settings —
   * silently leaving the modal open would imply "nothing happened",
   * but the config really did save.
   */
  private finishWithSavedButUncloned(localPath: string, reason: string): void {
    // Raw git errors here can be very long (lock file paths, multi-line
    // hints). The settings page's per-submodule Test button is where the
    // user actually diagnoses — log the full reason for debugging and
    // keep the toast to a short acknowledgement.
    console.warn("[agentic-git-sync] submodule saved but clone failed:", reason);
    new Notice(tf(L().settings.addSubSaved, localPath));
    this.close();
  }

  onClose(): void {
    if (this.remoteDebounce) window.clearTimeout(this.remoteDebounce);
    this.contentEl.empty();
  }
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
