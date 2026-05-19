import { App, Modal, Notice, requestUrl, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { isValidGitHubUrl, normalizeRepoPath } from "../git/SubmoduleManager";
import { ensureRemoteHasCommits } from "../git/githubApi";

export class AddSubmoduleModal extends Modal {
  private localPath = "";
  private remoteUrl = "";
  private branch = "main";
  private remoteStatus: "idle" | "loading" | "valid" | "invalid" = "idle";
  private remoteMsg = "";
  private remoteIsEmpty = false;
  private remoteDebounce: number | null = null;
  private pathStatus: "idle" | "ok" | "collision" = "idle";
  private submitBtn: HTMLButtonElement | null = null;

  constructor(app: App, private plugin: GitHubSyncPlugin) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-add-modal");

    contentEl.createEl("h3", { text: "Add submodule" });
    contentEl.createEl("p", {
      cls: "ghs-add-sub",
      text: "Map a folder in your vault to a GitHub repository (submodule).",
    });

    // ── Local path ─────────────────────────────────────────────
    const pathWrap = contentEl.createDiv("ghs-wizard-field");
    pathWrap.createEl("label", { text: "Local path" });
    const pathHint = pathWrap.createDiv("ghs-field-hint");
    pathHint.setText("Folder relative to vault root (e.g. Projects/work)");
    const pathInput = pathWrap.createEl("input", { attr: { placeholder: "Projects/work" } });
    const pathBadge = pathWrap.createDiv("ghs-inline-badge");
    pathBadge.addClass("ghs-hidden");
    pathInput.oninput = () => {
      this.localPath = normalizeRepoPath(pathInput.value.trim());
      this.checkPath(pathBadge);
      this.refreshSubmit();
    };

    // ── Remote URL ─────────────────────────────────────────────
    const urlWrap = contentEl.createDiv("ghs-wizard-field");
    urlWrap.createEl("label", { text: "GitHub remote URL" });
    const urlInput = urlWrap.createEl("input", {
      attr: { placeholder: "https://github.com/user/repo.git" },
    });
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
        this.remoteMsg = "Doesn't look like a GitHub URL";
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
    branchWrap.createEl("label", { text: "Branch" });
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- "main" is a branch name, not UI prose
    const branchInput = branchWrap.createEl("input", { attr: { placeholder: "main" } });
    branchInput.value = "main";
    branchInput.oninput = () => (this.branch = branchInput.value.trim() || "main");

    // ── Footer ─────────────────────────────────────────────────
    const footer = contentEl.createDiv("ghs-wizard-footer");
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const submit = footer.createEl("button", { text: "Add", cls: "mod-cta" });
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
    // Try GitHub API to confirm reachability. Falls back to URL-only validation if token missing.
    const token = this.plugin.settings.githubToken;
    const match = this.remoteUrl.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/);
    if (!match) {
      this.remoteStatus = "invalid";
      this.remoteMsg = "Couldn't parse owner/repo";
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
        // Repo exists, but `git submodule add` will fail with
        // "branch yet to be born" if it has no commits. GitHub returns
        // 409 on /commits for empty repos — flag it so submit() can
        // silently auto-initialize the remote before adding.
        const commits = await requestUrl({
          url: `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`,
          headers,
          throw: false,
        });
        this.remoteIsEmpty = commits.status === 409;
        this.remoteStatus = "valid";
        this.remoteMsg = `Found ${owner}/${repo}`;
      } else if (res.status === 404) {
        this.remoteStatus = "invalid";
        this.remoteMsg = "Repository not found";
      } else if (res.status === 401 || res.status === 403) {
        this.remoteStatus = "invalid";
        this.remoteMsg = "Token can't access this repo";
      } else {
        this.remoteStatus = "invalid";
        this.remoteMsg = `GitHub returned ${res.status}`;
      }
    } catch {
      // Network failure — accept URL-level validation and let user proceed.
      this.remoteStatus = "valid";
      this.remoteMsg = "Couldn't verify (offline?), but URL looks OK";
    }
    this.renderRemoteBadge(badge);
    this.refreshSubmit();
  }

  private checkPath(badge: HTMLElement): void {
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
      badge.createSpan({ text: "A submodule already exists at this path" });
    } else {
      this.pathStatus = "ok";
      badge.removeClass("ghs-hidden");
      badge.removeClass("invalid");
      badge.addClass("valid");
      const iconWrap = badge.createSpan();
      setIcon(iconWrap, "check-circle");
      badge.createSpan({ text: "Path is available" });
    }
  }

  private refreshSubmit(): void {
    if (!this.submitBtn) return;
    const ok =
      this.localPath.length > 0 &&
      this.pathStatus === "ok" &&
      this.remoteUrl.length > 0 &&
      this.remoteStatus === "valid";
    this.submitBtn.disabled = !ok;
  }

  private async submit(): Promise<void> {
    const config = {
      id: cryptoRandomId(),
      localPath: this.localPath,
      remoteUrl: this.remoteUrl,
      branch: this.branch,
      autoSync: true,
      syncInterval: this.plugin.settings.autoSyncInterval,
    };

    if (this.submitBtn) {
      this.submitBtn.disabled = true;
      this.submitBtn.textContent = "Adding…";
    }
    try {
      if (this.remoteIsEmpty) {
        if (this.submitBtn) this.submitBtn.textContent = "Preparing repository…";
        await ensureRemoteHasCommits(this.remoteUrl, this.plugin.settings.githubToken);
        this.remoteIsEmpty = false;
      }
      await this.plugin.addSubmodule(config);
      new Notice(`Added "${this.localPath}"`);
      this.close();
    } catch (e) {
      const raw = (e as Error).message ?? "";
      // Belt-and-braces: probeRemote's offline fallback can let an empty
      // repo through. If we land here with that error, try auto-init then
      // retry the submodule add once.
      if (
        !this.remoteIsEmpty &&
        /yet to be born|unable to checkout submodule/i.test(raw)
      ) {
        try {
          if (this.submitBtn) this.submitBtn.textContent = "Preparing repository…";
          await ensureRemoteHasCommits(this.remoteUrl, this.plugin.settings.githubToken);
          await this.plugin.addSubmodule(config);
          new Notice(`Added "${this.localPath}"`);
          this.close();
          return;
        } catch (retryErr) {
          new Notice(`Failed: ${(retryErr as Error).message}`, 8000);
        }
      } else {
        new Notice(`Failed: ${raw}`, 8000);
      }
      if (this.submitBtn) {
        this.submitBtn.disabled = false;
        this.submitBtn.textContent = "Add";
      }
    }
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
