import { App, Modal, Notice, requestUrl, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { isValidGitHubUrl } from "../git/SubmoduleManager";
import { ensureRemoteHasCommits, type GitHubUser } from "../git/githubApi";

interface WizardState {
  githubToken: string;
  gitUser: string;
  gitEmail: string;
  repoUrl: string;
  branch: string;
}

export class SetupWizard extends Modal {
  private step = 0;
  private state: WizardState;
  private tokenStatus: "idle" | "loading" | "success" | "error" = "idle";
  private tokenUser = "";
  private tokenDebounce: number | null = null;

  constructor(app: App, private plugin: GitHubSyncPlugin) {
    super(app);
    this.modalEl.addClass("ghs-wizard-modal");
    this.state = {
      githubToken: plugin.settings.githubToken,
      gitUser: plugin.settings.gitUser,
      gitEmail: plugin.settings.gitEmail,
      repoUrl: plugin.settings.mainRepoUrl,
      branch: plugin.settings.mainRepoBranch || "main",
    };

    // Skip past steps the user has already completed:
    //   no creds          → start at Welcome (auto-open on first install)
    //   creds set, no repo → start at Repo (user opened from "Connect repository")
    //   everything set     → start at Repo so user can edit URL ("Reconfigure")
    const hasCreds =
      !!plugin.settings.githubToken &&
      !!plugin.settings.gitUser &&
      !!plugin.settings.gitEmail;
    if (hasCreds) this.step = 2;
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private get totalDots(): number { return 4; }
  private get dotIndex(): number { return this.step; }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-wizard");

    this.renderProgress();

    switch (this.step) {
      case 0: this.renderWelcome(); break;
      case 1: this.renderCredentials(); break;
      case 2: this.renderRepo(); break;
      case 3: this.renderDone(); break;
    }
  }

  private renderProgress(): void {
    const { contentEl } = this;
    const bar = contentEl.createDiv("ghs-wizard-progress");
    const current = this.dotIndex;
    for (let i = 0; i < this.totalDots; i++) {
      const dot = bar.createDiv("ghs-wizard-dot");
      if (i < current) dot.addClass("done");
      else if (i === current) dot.addClass("active");
    }
  }

  // ── Step 0: Welcome ──────────────────────────────────────────

  private renderWelcome(): void {
    const { contentEl } = this;

    const hero = contentEl.createDiv("ghs-wizard-hero");
    setIcon(hero.createDiv("ghs-wizard-hero-icon"), "github");
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- "Agentic Git Sync" is the proper product name
    hero.createEl("h2", { text: "Welcome to Agentic Git Sync" });
    hero.createEl("p", {
      text: "Back up your vault and sync it with GitHub. Credentials stay on this machine — everything else travels with the repo.",
    });

    const list = contentEl.createEl("ul", { cls: "ghs-feature-list" });
    for (const f of [
      { icon: "cloud", title: "Automatic backup", desc: "Push changes to GitHub on a schedule" },
      { icon: "refresh-cw", title: "Cross-machine sync", desc: "Pull the repo on any machine — config follows automatically" },
      { icon: "zap", title: "AI conflict resolution", desc: "Auto-resolve merge conflicts with DeepSeek or Gemini" },
    ]) {
      const li = list.createEl("li");
      setIcon(li.createSpan({ cls: "icon" }), f.icon);
      const text = li.createDiv();
      text.createEl("strong", { text: f.title });
      text.createEl("span", { text: ` — ${f.desc}` });
    }

    const footer = contentEl.createDiv("ghs-wizard-footer");
    footer.createSpan();
    this.btn(footer, "Get Started", true, () => this.goTo(1));
  }

  // ── Step 1: Credentials ──────────────────────────────────────

  private renderCredentials(): void {
    const { contentEl } = this;

    const hero = contentEl.createDiv("ghs-wizard-hero");
    setIcon(hero.createDiv("ghs-wizard-hero-icon"), "key");
    hero.createEl("h2", { text: "Your credentials" });
    hero.createEl("p", { text: "Stored locally — never committed to any repo." });

    // Token field with show/hide toggle + help link
    const tokenWrap = contentEl.createDiv("ghs-wizard-field");
    const labelRow = tokenWrap.createDiv("ghs-wizard-label-row");
    labelRow.createEl("label", { text: "GitHub personal access token" });
    const helpBtn = labelRow.createEl("button", {
      cls: "ghs-help-btn",
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- pronoun "I" must stay capitalized
      attr: { type: "button", "aria-label": "Where do I get a token?" },
    });
    setIcon(helpBtn, "help-circle");
    helpBtn.onclick = (e) => {
      e.preventDefault();
      window.open("https://github.com/settings/personal-access-tokens", "_blank");
    };
    const tokenRow = tokenWrap.createDiv("ghs-wizard-token-row");
    const tokenInput = tokenRow.createEl("input", {
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- token prefixes are technical identifiers
      attr: { type: "password", placeholder: "ghp_… or github_pat_…" },
    });
    tokenInput.value = this.state.githubToken;
    const eyeBtn = tokenRow.createEl("button", { cls: "ghs-eye-btn" });
    setIcon(eyeBtn, "eye");
    eyeBtn.onclick = () => {
      tokenInput.type = tokenInput.type === "password" ? "text" : "password";
    };
    const hint = tokenWrap.createDiv("ghs-hint");
    hint.appendText("Needs ");
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- "repo" is a GitHub scope identifier
    hint.createEl("code", { text: "repo" });
    hint.appendText(" scope. Don't have one? Click the ");
    const inlineHelp = hint.createEl("a", {
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- "? icon above" refers to a literal "?" button label
      text: "? icon above",
      attr: { href: "https://github.com/settings/personal-access-tokens" },
    });
    inlineHelp.onclick = (e) => {
      e.preventDefault();
      window.open("https://github.com/settings/personal-access-tokens", "_blank");
    };
    hint.appendText(" to create one.");

    const badge = contentEl.createDiv("ghs-wizard-badge-row");
    if (this.tokenStatus !== "idle") this.renderTokenBadge(badge);

    // Identity fields — auto-filled from GitHub after token verifies
    const nameInput = this.field(contentEl, "Your Name", "Jane Smith");
    nameInput.value = this.state.gitUser;

    const emailInput = this.field(contentEl, "Email", "jane@example.com");
    emailInput.value = this.state.gitEmail;

    tokenInput.oninput = () => {
      this.state.githubToken = tokenInput.value.trim();
      if (this.tokenDebounce) window.clearTimeout(this.tokenDebounce);
      if (!this.state.githubToken) {
        this.tokenStatus = "idle";
        this.renderTokenBadge(badge);
        return;
      }
      this.tokenDebounce = window.setTimeout(
        () => { void this.testToken(this.state.githubToken, badge, nameInput, emailInput); },
        600
      );
    };

    const footer = contentEl.createDiv("ghs-wizard-footer");
    this.btn(footer, "Back", false, () => this.goTo(0));
    this.btn(footer, "Next", true, async () => {
      this.state.githubToken = tokenInput.value.trim();
      this.state.gitUser = nameInput.value.trim();
      this.state.gitEmail = emailInput.value.trim();

      if (!this.state.githubToken) {
        new Notice("Please enter your GitHub token.");
        return;
      }
      if (!this.state.gitUser || !this.state.gitEmail) {
        new Notice("Name and email are required.");
        return;
      }

      this.plugin.settings.githubToken = this.state.githubToken;
      this.plugin.settings.gitUser = this.state.gitUser;
      this.plugin.settings.gitEmail = this.state.gitEmail;
      this.plugin.settings.setupComplete = true;
      await this.plugin.saveSettings();
      this.plugin.reinitGit();

      // Always advance to the Repo step. If the user already configured
      // a URL, they can review/edit and click Finish; or click "Skip for
      // now" to go straight to Done.
      this.goTo(2);
    });
  }

  private renderTokenBadge(el: HTMLElement): void {
    el.empty();
    if (this.tokenStatus === "idle") return;
    const cls = this.tokenStatus === "success" ? "success" : this.tokenStatus === "error" ? "error" : "loading";
    const b = el.createDiv({ cls: `ghs-status-badge ${cls}` });
    const icon = b.createSpan({ cls: "ghs-badge-icon" });
    if (this.tokenStatus === "loading") {
      setIcon(icon, "loader-2");
      b.createSpan({ text: "Verifying…" });
    } else if (this.tokenStatus === "success") {
      setIcon(icon, "check-circle");
      b.createSpan({ text: `Connected as @${this.tokenUser}` });
    } else {
      setIcon(icon, "alert-circle");
      b.createSpan({ text: "Invalid token — check permissions" });
    }
  }

  private async testToken(
    token: string,
    badgeEl: HTMLElement,
    nameInput: HTMLInputElement,
    emailInput: HTMLInputElement
  ): Promise<void> {
    this.tokenStatus = "loading";
    this.renderTokenBadge(badgeEl);
    try {
      const res = await requestUrl({
        url: "https://api.github.com/user",
        headers: { Authorization: `token ${token}`, "User-Agent": "ObsidianGitHubSync" },
        throw: false,
      });
      if (res.status === 200) {
        const user = res.json as GitHubUser;
        this.tokenUser = user.login;
        this.tokenStatus = "success";
        if (!nameInput.value && user.name) {
          nameInput.value = user.name;
          this.state.gitUser = user.name;
        }
        if (!emailInput.value && user.email) {
          emailInput.value = user.email;
          this.state.gitEmail = user.email;
        }
      } else {
        this.tokenStatus = "error";
      }
    } catch {
      this.tokenStatus = "error";
    }
    this.renderTokenBadge(badgeEl);
  }

  // ── Step 2: Connect Repository ───────────────────────────────

  private renderRepo(): void {
    const { contentEl } = this;

    const hero = contentEl.createDiv("ghs-wizard-hero");
    setIcon(hero.createDiv("ghs-wizard-hero-icon"), "git-branch");
    hero.createEl("h2", { text: "Connect a repository" });
    hero.createEl("p", {
      text: "Settings are saved to .github-sync.json and travel with the repo — teammates who clone it get the config automatically.",
    });

    const urlInput = this.field(contentEl, "GitHub Remote URL", "https://github.com/you/vault.git");
    urlInput.value = this.state.repoUrl;

    const urlBadge = contentEl.createDiv("ghs-wizard-badge-row");

    const branchInput = this.field(contentEl, "Branch", "main");
    branchInput.value = this.state.branch;

    const refreshUrlBadge = () => {
      urlBadge.empty();
      const v = urlInput.value.trim();
      if (!v) return;
      const ok = isValidGitHubUrl(v);
      const b = urlBadge.createDiv({ cls: `ghs-status-badge ${ok ? "success" : "error"}` });
      setIcon(b.createSpan({ cls: "ghs-badge-icon" }), ok ? "check-circle" : "alert-circle");
      b.createSpan({ text: ok ? "Looks like a valid GitHub URL" : "Doesn't look like a GitHub URL" });
    };

    urlInput.oninput = refreshUrlBadge;
    refreshUrlBadge();

    const footer = contentEl.createDiv("ghs-wizard-footer");
    const skip = footer.createEl("span", { cls: "ghs-skip", text: "Skip for now" });
    skip.onclick = () => this.goTo(3);

    const btnGroup = footer.createDiv("ghs-btn-group");
    this.btn(btnGroup, "Back", false, () => this.goTo(1));
    const finishBtn = this.btn(btnGroup, "Finish", true, async () => {
      const url = urlInput.value.trim();
      const branch = branchInput.value.trim() || "main";

      if (!url) { new Notice("Please enter a repository URL."); return; }
      if (!isValidGitHubUrl(url)) { new Notice("URL doesn't look like a GitHub repo."); return; }

      this.state.repoUrl = url;
      this.state.branch = branch;
      this.plugin.settings.mainRepoUrl = url;
      this.plugin.settings.mainRepoBranch = branch;
      await this.plugin.saveSettings();
      this.plugin.reinitGit();

      finishBtn.disabled = true;
      finishBtn.textContent = "Connecting…";

      try {
        // If the user just created an empty GitHub repo via the web UI,
        // seed it with a README via the API so git has a default branch
        // to push --set-upstream against. Silent no-op otherwise.
        finishBtn.textContent = "Preparing repository…";
        await ensureRemoteHasCommits(url, this.plugin.settings.githubToken);
        finishBtn.textContent = "Connecting…";

        // Update origin BEFORE sync. Without this, switching to a new repo
        // URL would still push/pull against whatever origin .git/config
        // already had — e.g., the vault used to point at repo A, the user
        // types repo B's URL into the wizard, sync runs `git pull origin`
        // and fails with 403 against repo A's URL.
        await this.plugin.gitManager.setOrigin(url, branch);
        await this.plugin.gitManager.sync({
          branch,
          remoteUrl: url,
          message: "chore: initial vault sync",
          ignorePatterns: this.plugin.settings.ignorePatterns,
        });
        this.goTo(3);
      } catch (e: unknown) {
        finishBtn.disabled = false;
        finishBtn.textContent = "Finish";
        const { GitConflictError } = await import("../git/GitManager");
        if (e instanceof GitConflictError) {
          new Notice(`Merge conflicts found in ${e.conflicts.length} file(s). Resolve them before syncing.`);
          const { ConflictModal } = await import("./ConflictModal");
          const ops = this.plugin.getRepoOps("__vault__");
          if (ops) new ConflictModal(this.app, ops, e.conflicts, () => {}, "Main Vault").open();
        } else {
          // Avoid the useless "[object Object]" that String() would
          // produce on a plain thrown object — JSON-stringify as a
          // last resort so the user gets something meaningful.
          const msg =
            e instanceof Error ? e.message :
            typeof e === "string" ? e :
            (() => { try { return JSON.stringify(e); } catch { return "unknown error"; } })();
          new Notice(`Connection failed: ${msg}`);
        }
      }
    });
  }

  // ── Step 3: Done ─────────────────────────────────────────────

  private renderDone(): void {
    const { contentEl } = this;

    const hero = contentEl.createDiv("ghs-wizard-hero");
    setIcon(hero.createDiv("ghs-wizard-hero-icon"), "check-circle");
    hero.createEl("h2", { text: "You're all set!" });
    hero.createEl("p", {
      text: this.state.repoUrl || this.plugin.settings.mainRepoUrl
        ? "GitHub Sync is configured and ready to go."
        : "Credentials saved. Connect a repository from the Settings page whenever you're ready.",
    });

    const list = contentEl.createEl("ul", { cls: "ghs-feature-list" });

    if (this.state.gitUser) {
      const li = list.createEl("li");
      setIcon(li.createSpan({ cls: "icon" }), "user");
      li.createEl("span", { text: `Signed in as ${this.state.gitUser}` });
    }

    const repoUrl = this.state.repoUrl || this.plugin.settings.mainRepoUrl;
    if (repoUrl) {
      const li = list.createEl("li");
      setIcon(li.createSpan({ cls: "icon" }), "git-branch");
      li.createEl("span", { text: `Vault → ${repoUrl}` });
    }

    const footer = contentEl.createDiv("ghs-wizard-footer");
    footer.createSpan();
    this.btn(footer, "Start Syncing", true, () => {
      this.close();
      void this.plugin.scheduler.run();
    });
  }

  // ── Helpers ──────────────────────────────────────────────────

  private field(parent: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    const wrapper = parent.createDiv("ghs-wizard-field");
    wrapper.createEl("label", { text: label });
    return wrapper.createEl("input", { attr: { type: "text", placeholder } });
  }

  private btn(parent: HTMLElement, text: string, cta: boolean, onClick: () => unknown): HTMLButtonElement {
    const b = parent.createEl("button", { text });
    if (cta) b.addClass("mod-cta");
    b.onclick = () => { void onClick(); };
    return b;
  }

  private goTo(step: number): void {
    this.step = step;
    this.render();
  }

  onClose(): void {
    if (this.tokenDebounce) window.clearTimeout(this.tokenDebounce);
    this.contentEl.empty();
  }
}
