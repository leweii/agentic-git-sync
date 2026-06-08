import { App, Modal, Notice, requestUrl, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { isValidGitHubUrl } from "../git/SubmoduleManager";
import { ensureRemoteHasCommits, fetchRepoDefaultBranch, type GitHubUser } from "../git/githubApi";
import { L } from "../i18n";
import { RepoPickerModal } from "./RepoPickerModal";

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
    const w = L().wizard;
    const s = L().settings;

    const hero = contentEl.createDiv("ghs-wizard-hero");
    setIcon(hero.createDiv("ghs-wizard-hero-icon"), "github");
    hero.createEl("h2", { text: w.welcomeTitle });
    hero.createEl("p", { text: w.welcomeDesc });

    const list = contentEl.createEl("ul", { cls: "ghs-feature-list" });
    for (const f of [
      { icon: "cloud",      title: w.feat1Title, desc: w.feat1Desc },
      { icon: "refresh-cw", title: w.feat2Title, desc: w.feat2Desc },
      { icon: "zap",        title: w.feat3Title, desc: w.feat3Desc },
    ]) {
      const li = list.createEl("li");
      setIcon(li.createSpan({ cls: "icon" }), f.icon);
      const text = li.createDiv();
      text.createEl("strong", { text: f.title });
      text.createEl("span", { text: ` — ${f.desc}` });
    }

    // Usage-mode chooser sits BELOW the feature list — the welcome message
    // gets read first; the toggle is the last decision before Get Started.
    // Saved immediately so revisiting the wizard reflects the choice.
    const modeWrap = contentEl.createDiv("ghs-wizard-mode");
    modeWrap.createEl("label", { text: s.sectionUsageMode, cls: "ghs-wizard-mode-label" });
    const seg = modeWrap.createDiv("ghs-wizard-mode-seg");
    const setMode = async (m: "personal" | "team") => {
      this.plugin.settings.usageMode = m;
      await this.plugin.saveSettings();
      personalBtn.toggleClass("active", m === "personal");
      teamBtn.toggleClass("active", m === "team");
    };
    const personalBtn = seg.createEl("button", { text: s.usageModePersonal, cls: "ghs-wizard-mode-btn" });
    personalBtn.onclick = () => setMode("personal");
    const teamBtn = seg.createEl("button", { text: s.usageModeTeam, cls: "ghs-wizard-mode-btn" });
    teamBtn.onclick = () => setMode("team");
    const current = this.plugin.settings.usageMode ?? "personal";
    personalBtn.toggleClass("active", current === "personal");
    teamBtn.toggleClass("active", current === "team");
    modeWrap.createEl("div", { cls: "ghs-wizard-mode-desc", text: s.usageModeDesc });

    const footer = contentEl.createDiv("ghs-wizard-footer");
    footer.createSpan();
    this.btn(footer, w.getStarted, true, () => this.goTo(1));
  }

  // ── Step 1: Credentials ──────────────────────────────────────

  private renderCredentials(): void {
    const { contentEl } = this;
    const w = L().wizard;
    const c = L().common;

    const hero = contentEl.createDiv("ghs-wizard-hero");
    setIcon(hero.createDiv("ghs-wizard-hero-icon"), "key");
    hero.createEl("h2", { text: w.credTitle });
    hero.createEl("p", { text: w.credDesc });

    const options = contentEl.createDiv("ghs-auth-options");

    // ── Option A: GitHub App ──────────────────────────────────
    const appConns = this.plugin.settings.githubApp?.connections ?? [];
    const isAppConnected = appConns.length > 0;

    const optA = options.createDiv(
      "ghs-auth-option" + (isAppConnected ? " is-connected" : " is-primary"),
    );
    const optAHead = optA.createDiv("ghs-auth-option-header");
    const optALabel = optAHead.createDiv("ghs-auth-option-label");
    optALabel.createSpan({ cls: "ghs-auth-option-letter", text: "A" });
    optALabel.createSpan({ text: "GitHub App" });
    if (!isAppConnected) {
      optAHead.createSpan({ cls: "ghs-auth-recommended", text: "Recommended" });
    } else {
      const connBadge = optAHead.createDiv("ghs-auth-connected-badge");
      setIcon(connBadge.createSpan(), "check-circle");
      connBadge.createSpan({
        text: `Connected as @${appConns.map((conn) => conn.login).join(", @")}`,
      });
    }
    optA.createDiv({
      cls: "ghs-auth-option-desc",
      text: isAppConnected
        ? "App connected — fill in your name and email below, then click Next."
        : "One click. Opens GitHub in your browser, then returns here automatically.",
    });
    const appBtn = optA.createEl("button", {
      cls: "mod-cta",
      attr: { type: "button" },
      text: isAppConnected ? "Reconnect" : "Connect with GitHub App →",
    });
    appBtn.onclick = () => void this.plugin.appAuth.beginConnect();

    // ── OR divider ────────────────────────────────────────────
    options.createDiv("ghs-auth-or").createSpan({ text: "OR" });

    // ── Option B: Personal Access Token ──────────────────────
    const optB = options.createDiv("ghs-auth-option");
    const optBHead = optB.createDiv("ghs-auth-option-header");
    const optBLabel = optBHead.createDiv("ghs-auth-option-label");
    optBLabel.createSpan({ cls: "ghs-auth-option-letter ghs-auth-option-letter--b", text: "B" });
    optBLabel.createSpan({ text: w.tokenLabel });
    const helpBtn = optBHead.createEl("button", {
      cls: "ghs-help-btn",
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- pronoun "I" must stay capitalized
      attr: { type: "button", "aria-label": "Where do I get a token?" },
    });
    setIcon(helpBtn, "help-circle");
    helpBtn.onclick = (e) => {
      e.preventDefault();
      window.open("https://github.com/settings/personal-access-tokens", "_blank");
    };

    const tokenRow = optB.createDiv("ghs-wizard-token-row");
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
    const hint = optB.createDiv("ghs-hint");
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- "repo" is a GitHub scope identifier
    hint.createEl("code", { text: "repo" });
    hint.appendText(" " + w.tokenScope);

    const badge = contentEl.createDiv("ghs-wizard-badge-row");
    if (this.tokenStatus !== "idle") this.renderTokenBadge(badge);

    // Identity fields — auto-filled from GitHub after token verifies
    const nameInput = this.field(contentEl, w.nameLabel, w.namePlaceholder);
    nameInput.value = this.state.gitUser;

    const emailInput = this.field(contentEl, w.emailLabel, w.emailPlaceholder);
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
        600,
      );
    };

    const footer = contentEl.createDiv("ghs-wizard-footer");
    this.btn(footer, c.back, false, () => this.goTo(0));
    this.btn(footer, c.next, true, async () => {
      this.state.githubToken = tokenInput.value.trim();
      this.state.gitUser = nameInput.value.trim();
      this.state.gitEmail = emailInput.value.trim();

      const appConnected =
        this.plugin.settings.authMethod === "githubApp" &&
        (this.plugin.settings.githubApp?.connections ?? []).length > 0;
      if (!appConnected && !this.state.githubToken) {
        new Notice(w.tokenRequired);
        return;
      }
      if (!this.state.gitUser || !this.state.gitEmail) {
        new Notice(w.nameEmailReq);
        return;
      }

      this.plugin.settings.githubToken = this.state.githubToken;
      this.plugin.settings.gitUser = this.state.gitUser;
      this.plugin.settings.gitEmail = this.state.gitEmail;
      this.plugin.settings.setupComplete = true;
      await this.plugin.saveSettings();
      this.plugin.reinitGit();

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

    const t = L().wizard;
    const c = L().common;
    const hero = contentEl.createDiv("ghs-wizard-hero");
    setIcon(hero.createDiv("ghs-wizard-hero-icon"), "git-branch");
    hero.createEl("h2", { text: t.repoTitle });
    hero.createEl("p", { text: t.repoDesc });

    // Build URL row manually so we can append the browse button inline.
    const urlWrap = contentEl.createDiv("ghs-wizard-field");
    urlWrap.createEl("label", { text: t.repoUrlLabel });
    const urlRow = urlWrap.createDiv("ghs-url-row");
    const urlInput = urlRow.createEl("input", { attr: { type: "text", placeholder: t.repoUrlPlaceholder } });
    urlInput.value = this.state.repoUrl;
    if (this.plugin.settings.authMethod === "githubApp") {
      const browse = urlRow.createEl("button", {
        cls: "ghs-browse-btn clickable-icon",
        attr: { type: "button", "aria-label": "Browse repositories" },
      });
      setIcon(browse, "search");
      browse.onclick = () =>
        new RepoPickerModal(this.app, this.plugin, (cloneUrl) => {
          urlInput.value = cloneUrl;
          urlInput.dispatchEvent(new Event("input"));
        }).open();
    }

    const urlBadge = contentEl.createDiv("ghs-wizard-badge-row");

    const branchInput = this.field(contentEl, t.branchLabel, "main");
    branchInput.value = this.state.branch;

    // Track whether the user manually edited the branch field. If they did,
    // we stop auto-filling from the GitHub default — their intent wins.
    let branchUserEdited = this.state.branch !== "" && this.state.branch !== "main";
    branchInput.addEventListener("input", () => { branchUserEdited = true; });

    // Debounced default-branch detection: after the URL looks valid, ask
    // GitHub for the repo's actual default branch (main, master, develop, …)
    // and pre-fill the Branch field unless the user has typed something custom.
    let detectTimer: number | null = null;
    let lastDetectedUrl = "";
    const detectDefaultBranch = (url: string) => {
      if (detectTimer !== null) window.clearTimeout(detectTimer);
      detectTimer = window.setTimeout(async () => {
        if (url === lastDetectedUrl) return;
        lastDetectedUrl = url;
        const def = await fetchRepoDefaultBranch(url, this.state.githubToken);
        if (def && !branchUserEdited) {
          branchInput.value = def;
          this.state.branch = def;
        }
      }, 400);
    };

    const refreshUrlBadge = () => {
      urlBadge.empty();
      const v = urlInput.value.trim();
      if (!v) return;
      const ok = isValidGitHubUrl(v);
      const b = urlBadge.createDiv({ cls: `ghs-status-badge ${ok ? "success" : "error"}` });
      setIcon(b.createSpan({ cls: "ghs-badge-icon" }), ok ? "check-circle" : "alert-circle");
      b.createSpan({ text: ok ? t.validUrl : t.invalidUrl });
      if (ok) detectDefaultBranch(v);
    };

    urlInput.oninput = refreshUrlBadge;
    refreshUrlBadge();

    const footer = contentEl.createDiv("ghs-wizard-footer");
    const skip = footer.createEl("span", { cls: "ghs-skip", text: c.skip });
    skip.onclick = () => this.goTo(3);

    const btnGroup = footer.createDiv("ghs-btn-group");
    this.btn(btnGroup, c.back, false, () => this.goTo(1));
    const finishBtn = this.btn(btnGroup, c.finish, true, async () => {
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
