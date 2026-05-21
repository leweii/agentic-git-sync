import { App, Modal, Notice, PluginSettingTab, Setting, requestUrl, setIcon } from "obsidian";
import type GitHubSyncPlugin from "./main";
import type { SyncHistoryEntry } from "./types";
import { L, setLang, tf, type Lang } from "./i18n";
import { isValidGitHubUrl } from "./git/SubmoduleManager";
import { checkRepoAccess, type GitHubUser } from "./git/githubApi";
import { AIProviderSetupModal } from "./ui/AIProviderSetupModal";
import { EditSubmoduleModal } from "./ui/EditSubmoduleModal";
import { SetupWizard } from "./ui/SetupWizard";

export interface SubmoduleConfig {
  id: string;
  localPath: string;
  remoteUrl: string;
  branch: string;
  /**
   * Optional "always merge in" source branch. When set and different
   * from `branch`, every sync fetches `origin/<upstreamBranch>` and
   * merges it into the working branch before pushing. Lets a team
   * member working on `jakob-edits` automatically pick up changes
   * teammates pushed to `main`. Conflicts surface via the normal
   * ConflictModal flow.
   */
  upstreamBranch?: string;
  autoSync: boolean;
  syncInterval: number;
}

export interface AISettings {
  enabled: boolean;
  silentMode: boolean;
  silentMinConfidence: number;
  deepseekToken: string;
  deepseekModel: string;
  geminiToken: string;
  geminiModel: string;
  sendFilePaths: boolean;
  sendGitMetadata: boolean;
  sendSurroundingContext: boolean;
  excludePatterns: string[];
}

export interface GitHubSyncSettings {
  setupComplete: boolean;
  language: Lang;
  syncOnStartup: boolean;
  autoSyncInterval: number;
  gitUser: string;
  gitEmail: string;
  githubToken: string;
  mainRepoUrl: string;
  mainRepoBranch: string;
  submodules: SubmoduleConfig[];
  ignorePatterns: string[];
  historyLimit: number;
  syncHistory: SyncHistoryEntry[];
  confirmBeforeSync: boolean;
  ai: AISettings;
}

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
  setupComplete: false,
  language: "en",
  syncOnStartup: true,
  autoSyncInterval: 30,
  gitUser: "",
  gitEmail: "",
  githubToken: "",
  mainRepoUrl: "",
  mainRepoBranch: "main",
  submodules: [],
  // The config-dir pattern is injected at load time from
  // app.vault.configDir (it isn't necessarily ".obsidian").
  ignorePatterns: [
    ".DS_Store",
    ".trash/**",
  ],
  historyLimit: 20,
  syncHistory: [],
  confirmBeforeSync: false,
  ai: {
    enabled: true,
    silentMode: false,
    silentMinConfidence: 3,
    deepseekToken: "",
    deepseekModel: "deepseek-v4-flash",
    geminiToken: "",
    geminiModel: "gemini-1.5-flash",
    sendFilePaths: true,
    sendGitMetadata: true,
    sendSurroundingContext: true,
    excludePatterns: [".env", ".env.*", "secrets/**", "*.private.md", "private/**", "**/credentials.*"],
  },
};

export class GitHubSyncSettingTab extends PluginSettingTab {
  plugin: GitHubSyncPlugin;

  constructor(app: App, plugin: GitHubSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ghs-settings");

    this.renderSilentHero(containerEl);
    this.renderRepository(containerEl);
    this.renderAccount(containerEl);
    this.renderAI(containerEl);
    this.renderGeneral(containerEl);
  }

  // ── Smart-sync hero (signature feature) ──────────────────────

  private renderSilentHero(parent: HTMLElement): void {
    const t = L().settings;
    const ai = this.plugin.settings.ai;
    const hasKey = !!(ai.deepseekToken || ai.geminiToken);

    const hero = parent.createDiv("ghs-silent-hero");
    if (ai.silentMode) hero.addClass("is-active");

    const left = hero.createDiv("ghs-silent-left");
    const icon = left.createDiv("ghs-silent-icon");
    setIcon(icon, "zap");

    const text = left.createDiv("ghs-silent-text");
    text.createDiv({ cls: "ghs-silent-title", text: t.silentTitle });

    const badge = text.createDiv({
      cls: `ghs-silent-badge ${hasKey ? "ready" : "warn"}`,
    });
    setIcon(badge.createSpan(), hasKey ? "check-circle" : "alert-circle");
    badge.createSpan({ text: hasKey ? t.silentBadgeReady : t.silentBadgeNoKey });

    const right = hero.createDiv("ghs-silent-right");
    const toggleWrap = right.createEl("div", { cls: "checkbox-container" });
    const toggleInput = toggleWrap.createEl("input", { type: "checkbox" });
    toggleInput.checked = ai.silentMode;
    if (ai.silentMode) toggleWrap.addClass("is-enabled");

    const setSilent = async (on: boolean) => {
      this.plugin.settings.ai.silentMode = on;
      await this.plugin.saveSettings();
      this.display();
    };

    const handleToggle = async () => {
      const nextOn = toggleInput.checked;
      const a = this.plugin.settings.ai;
      const currentHasKey = !!(a.deepseekToken || a.geminiToken);
      if (nextOn && !currentHasKey) {
        // Revert visually until user finishes the setup modal
        toggleInput.checked = false;
        toggleWrap.removeClass("is-enabled");
        new AIProviderSetupModal(this.app, this.plugin, (saved: boolean) => {
          if (saved) {
            this.plugin.settings.ai.silentMode = true;
            void this.plugin.saveSettings().then(() => this.display());
          } else {
            this.display();
          }
        }).open();
        return;
      }
      toggleWrap.toggleClass("is-enabled", nextOn);
      await setSilent(nextOn);
    };

    toggleInput.onchange = handleToggle;
    toggleWrap.onclick = (e) => {
      if (e.target === toggleInput) return;
      toggleInput.checked = !toggleInput.checked;
      toggleInput.dispatchEvent(new Event("change"));
    };

    if (ai.silentMode) {
      const tuning = hero.createDiv("ghs-silent-tuning");
      const label = tuning.createDiv("ghs-silent-tuning-label");
      label.setText(t.confidenceLabel);
      const slider = tuning.createEl("input", { type: "range" });
      slider.min = "1";
      slider.max = "5";
      slider.step = "1";
      slider.value = String(ai.silentMinConfidence);
      const valueEl = tuning.createDiv("ghs-silent-tuning-value");
      valueEl.setText(String(ai.silentMinConfidence));
      slider.oninput = () => valueEl.setText(slider.value);
      slider.onchange = async () => {
        this.plugin.settings.ai.silentMinConfidence = parseInt(slider.value, 10);
        await this.plugin.saveSettings();
      };
    }
  }

  // ── 1. Repository ────────────────────────────────────────────

  private renderRepository(parent: HTMLElement): void {
    const t = L().settings;
    const card = this.sectionHeader(parent, t.sectionRepo);

    // Prominent wizard launcher. The wizard used to auto-pop on every
    // load; now it's strictly opt-in and lives here so users who want
    // it can always find it.
    new Setting(card)
      .setName(t.runSetupWizard)
      .setDesc(t.runSetupWizardDesc)
      .addButton((b) =>
        b.setButtonText(t.runSetupWizard).setCta().onClick(() => {
          new SetupWizard(this.app, this.plugin).open();
        })
      );

    const s = this.plugin.settings;
    let urlInputEl: HTMLInputElement | null = null;
    let branchInputEl: HTMLInputElement | null = null;
    const statusEl = createDiv("ghs-inline-badge ghs-repo-status");
    statusEl.addClass("ghs-hidden");

    const isValidUrl = (u: string) => isValidGitHubUrl(u.trim());

    // Editable URL field.
    new Setting(card)
      .setName(t.repoUrlLabel)
      .setDesc(t.repoUrlDesc)
      .addText((tx) => {
        urlInputEl = tx.inputEl;
        tx.setPlaceholder(t.repoUrlPlaceholder)
          .setValue(s.mainRepoUrl)
          .onChange((v) => {
            this.plugin.settings.mainRepoUrl = v.trim();
          });
        tx.inputEl.addClass("ghs-token-input");
      });

    // Editable branch field.
    new Setting(card)
      .setName(t.repoBranchLabel)
      .addText((tx) => {
        branchInputEl = tx.inputEl;
        tx.setPlaceholder(t.repoBranchPlaceholder)
          .setValue(s.mainRepoBranch || "main")
          .onChange((v) => {
            this.plugin.settings.mainRepoBranch = v.trim() || "main";
          });
      });

    // Auto-sync interval (editable inline, replaces the old "Reconfigure" button).
    new Setting(card)
      .setName(s.autoSyncInterval > 0
        ? tf(t.autoSyncEvery, s.autoSyncInterval)
        : t.autoSyncDisabled)
      .addSlider((sl) =>
        sl.setLimits(0, 120, 5)
          .setValue(s.autoSyncInterval)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.autoSyncInterval = v;
            await this.plugin.saveSettings();
            this.plugin.scheduler.start();
            this.display();
          })
      );

    // Connect / Save & sync button.
    new Setting(card)
      .setName("")
      .addButton((b) => {
        const initial = s.mainRepoUrl ? t.repoSaveAndSync : t.repoInitialize;
        b.setButtonText(initial).setCta().onClick(async () => {
          const url = urlInputEl?.value.trim() ?? "";
          const branch = branchInputEl?.value.trim() || "main";
          if (!url) { new Notice(t.repoUrlInvalid); return; }
          if (!isValidUrl(url)) { new Notice(t.repoUrlInvalid); return; }

          b.setDisabled(true);
          b.setButtonText(t.repoConnecting);
          this.showRepoStatus(statusEl, "loading", t.repoConnecting);

          try {
            await this.plugin.connectMainRepo(url, branch);
            this.showRepoStatus(statusEl, "valid", t.repoConnected);
            b.setDisabled(false);
            b.setButtonText(t.repoSaveAndSync);
          } catch (e) {
            this.showRepoStatus(statusEl, "invalid", tf(t.repoConnectFailed, (e as Error).message));
            b.setDisabled(false);
            b.setButtonText(initial);
          }
        });
      });
    card.appendChild(statusEl);

    // Submodules list — its own card, separate from the connected-repo card.
    if (s.submodules.length > 0) {
      const subsCard = this.sectionHeader(parent, t.repoSubmodules, { count: s.submodules.length });
      for (const sub of s.submodules) {
        const desc = sub.upstreamBranch
          ? `${sub.remoteUrl} · ${sub.branch} ← ${sub.upstreamBranch}`
          : `${sub.remoteUrl} · ${sub.branch}`;
        new Setting(subsCard)
          .setName(sub.localPath)
          .setDesc(desc)
          .addExtraButton((b) =>
            b.setIcon("pencil")
              .setTooltip("Edit submodule")
              .onClick(() => {
                new EditSubmoduleModal(this.app, this.plugin, sub).open();
              })
          )
          .addExtraButton((b) =>
            b.setIcon("trash-2")
              .setTooltip("Remove submodule")
              .onClick(() => this.confirmRemoveSubmodule(sub.id, sub.localPath))
          );
      }
    }
  }

  private confirmRemoveSubmodule(id: string, label: string): void {
    const modal = new (class extends Modal {
      constructor(app: App, private onConfirm: () => Promise<void>) { super(app); }
      onOpen(): void {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: `Remove submodule "${label}"?` });
        contentEl.createEl("p", {
          text:
            "This deinitialises the submodule and deletes its working tree from the vault. " +
            "The remote repository on GitHub is not touched.",
          cls: "ghs-confirm-desc",
        });
        const actions = contentEl.createDiv("ghs-confirm-actions");
        const cancel = actions.createEl("button", { text: "Cancel" });
        cancel.onclick = () => this.close();
        const confirm = actions.createEl("button", { text: "Remove", cls: "mod-warning" });
        confirm.onclick = async () => {
          confirm.setAttribute("disabled", "true");
          try {
            await this.onConfirm();
            this.close();
          } catch { /* notice surfaced by removeSubmodule */ }
        };
      }
      onClose(): void { this.contentEl.empty(); }
    })(this.app, async () => {
      await this.plugin.removeSubmodule(id);
      this.display();
    });
    modal.open();
  }

  private showRepoStatus(badge: HTMLElement, kind: "loading" | "valid" | "invalid", text: string): void {
    badge.empty();
    badge.removeClass("ghs-hidden");
    badge.removeClass("loading", "valid", "invalid");
    badge.addClass(kind);
    setIcon(
      badge.createSpan(),
      kind === "loading" ? "loader-2" : kind === "valid" ? "check-circle" : "alert-circle"
    );
    badge.createSpan({ text });
  }

  // ── 2. Account (token + identity) ────────────────────────────

  private renderAccount(parent: HTMLElement): void {
    const t = L().settings;
    const card = this.sectionHeader(parent, t.sectionAccount);

    let tokenInputEl: HTMLInputElement | null = null;
    const testBadge = createDiv("ghs-inline-badge ghs-test-badge");
    testBadge.addClass("ghs-hidden");

    new Setting(card)
      .setName(t.tokenLabel)
      .addExtraButton((b) =>
        b.setIcon("help-circle").setTooltip(t.tokenHelp).onClick(() => {
          window.open("https://github.com/settings/personal-access-tokens", "_blank");
        })
      )
      .addExtraButton((b) =>
        b.setIcon("eye").setTooltip(t.tokenShowHide).onClick(() => {
          if (!tokenInputEl) return;
          tokenInputEl.type = tokenInputEl.type === "password" ? "text" : "password";
        })
      )
      .addText((text) => {
        tokenInputEl = text.inputEl;
        text.inputEl.type = "password";
        text
          .setPlaceholder(t.tokenPlaceholder)
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (v) => {
            this.plugin.settings.githubToken = v;
            await this.plugin.saveSettings();
            this.plugin.reinitGit();
          });
      })
      .addButton((b) =>
        b.setButtonText(L().common.test).onClick(() => this.testConnection(testBadge))
      );
    card.appendChild(testBadge);

    new Setting(card)
      .setName(t.nameLabel)
      .addText((text) =>
        text
          .setPlaceholder(t.namePlaceholder)
          .setValue(this.plugin.settings.gitUser)
          .onChange(async (v) => {
            this.plugin.settings.gitUser = v;
            await this.plugin.saveSettings();
            this.plugin.reinitGit();
          })
      );

    new Setting(card)
      .setName(t.emailLabel)
      .addText((text) =>
        text
          .setPlaceholder(t.emailPlaceholder)
          .setValue(this.plugin.settings.gitEmail)
          .onChange(async (v) => {
            this.plugin.settings.gitEmail = v;
            await this.plugin.saveSettings();
            this.plugin.reinitGit();
          })
      );
  }

  // ── 3. AI providers (keys only) ──────────────────────────────

  private renderAI(parent: HTMLElement): void {
    const t = L().settings;
    const card = this.sectionHeader(parent, t.sectionAI);

    let dsInputEl: HTMLInputElement | null = null;
    new Setting(card)
      .setName(t.deepseekLabel)
      .addExtraButton((b) =>
        b.setIcon("eye").setTooltip(t.tokenShowHide).onClick(() => {
          if (!dsInputEl) return;
          dsInputEl.type = dsInputEl.type === "password" ? "text" : "password";
        })
      )
      .addText((text) => {
        dsInputEl = text.inputEl;
        text.inputEl.type = "password";
        text
          // eslint-disable-next-line obsidianmd/ui/sentence-case -- "sk-" is the DeepSeek token prefix
          .setPlaceholder("sk-…")
          .setValue(this.plugin.settings.ai.deepseekToken)
          .onChange(async (v) => {
            this.plugin.settings.ai.deepseekToken = v.trim();
            await this.plugin.saveSettings();
          });
      });

    let gmInputEl: HTMLInputElement | null = null;
    new Setting(card)
      .setName(t.geminiLabel)
      .addExtraButton((b) =>
        b.setIcon("eye").setTooltip(t.tokenShowHide).onClick(() => {
          if (!gmInputEl) return;
          gmInputEl.type = gmInputEl.type === "password" ? "text" : "password";
        })
      )
      .addText((text) => {
        gmInputEl = text.inputEl;
        text.inputEl.type = "password";
        text
          // eslint-disable-next-line obsidianmd/ui/sentence-case -- "AIza" is the Gemini key prefix
          .setPlaceholder("AIza…")
          .setValue(this.plugin.settings.ai.geminiToken)
          .onChange(async (v) => {
            this.plugin.settings.ai.geminiToken = v.trim();
            await this.plugin.saveSettings();
          });
      });
  }

  // ── 4. General (language + tools) ────────────────────────────

  private renderGeneral(parent: HTMLElement): void {
    const t = L().settings;
    const card = this.sectionHeader(parent, t.sectionGeneral);

    new Setting(card)
      .setName(t.sectionLanguage)
      .addDropdown((dd) =>
        dd
          .addOption("en", t.languageEn)
          .addOption("zh", t.languageZh)
          .setValue(this.plugin.settings.language ?? "en")
          .onChange(async (v) => {
            this.plugin.settings.language = v as Lang;
            setLang(v as Lang);
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(card)
      .setName(t.clearHistory)
      .addButton((b) =>
        b.setButtonText(L().common.clear).setWarning().onClick(async () => {
          this.plugin.settings.syncHistory = [];
          await this.plugin.saveSettings();
          new Notice(t.historyCleared);
        })
      );
  }

  // ── Helpers ──────────────────────────────────────────────────

  /**
   * Render a section heading and return the card container that
   * holds the section's items. Callers add their Setting() rows
   * (and any inline status elements) to the returned card rather
   * than to `parent`, so each section visually renders as a
   * single rounded-bordered block — separator-by-spacing rather
   * than separator-by-rule. See `.ghs-card` in styles.css.
   *
   * Pass `count` to append a muted parenthesised count after the
   * title (e.g., "Submodules (2)") — used where a section has a
   * variable number of items worth surfacing at a glance.
   */
  private sectionHeader(
    parent: HTMLElement,
    title: string,
    opts?: { desc?: string; count?: number },
  ): HTMLElement {
    const setting = new Setting(parent).setHeading();
    setting.nameEl.empty();
    setting.nameEl.createSpan({ text: title });
    if (opts?.count !== undefined) {
      setting.nameEl.createSpan({ cls: "ghs-section-count", text: `(${opts.count})` });
    }
    if (opts?.desc) setting.setDesc(opts.desc);
    return parent.createDiv("ghs-card");
  }

  private async testConnection(container: HTMLElement): Promise<void> {
    const t = L().settings;
    container.empty();
    container.removeClass("ghs-hidden");
    container.addClass("ghs-diag-container");

    const token = this.plugin.settings.githubToken;
    if (!token) {
      this.addDiagRow(container, t.testNoToken, "error");
      return;
    }

    // ── Step 1: Token /user ─────────────────────────────────────
    const tokenRow = this.addDiagRow(container, t.testVerifying, "loading");
    let login = "";
    try {
      const res = await requestUrl({
        url: "https://api.github.com/user",
        headers: { Authorization: `token ${token}`, "User-Agent": "ObsidianGitHubSync" },
        throw: false,
      });
      if (res.status === 200) {
        login = (res.json as GitHubUser).login;
        this.setDiagRow(tokenRow, tf(t.testConnected, login), "success");
      } else {
        this.setDiagRow(tokenRow, tf(t.testReturned, res.status), "error");
        return;
      }
    } catch (e) {
      this.setDiagRow(tokenRow, tf(t.testFailed, (e as Error).message), "error");
      return;
    }

    // ── Steps 2 + 3: per-repo checks ────────────────────────────
    const targets: Array<{ label: string; url: string }> = [];
    if (this.plugin.settings.mainRepoUrl) {
      targets.push({ label: "Main vault", url: this.plugin.settings.mainRepoUrl });
    }
    for (const sub of this.plugin.settings.submodules) {
      targets.push({ label: sub.localPath, url: sub.remoteUrl });
    }
    if (targets.length === 0) {
      this.addDiagRow(container, "No repositories configured to check.", "success");
      return;
    }

    for (const { label, url } of targets) {
      // 2: GitHub API repo-access check
      const apiRow = this.addDiagRow(container, `${label} — checking repo access…`, "loading");
      const access = await checkRepoAccess(url, token);
      if (!access.ok) {
        this.setDiagRow(apiRow, `${label} — ${access.reason} (HTTP ${access.status})`, "error");
        continue; // skip git step if API can't even see it
      }
      const pushTag = access.canPush ? "read+write" : "read only";
      const emptyTag = access.isEmpty ? ", empty (will auto-init)" : "";
      this.setDiagRow(apiRow, `${label} — ${access.fullName} (${pushTag}${emptyTag})`, "success");

      // 3: git ls-remote via plugin's GitManager (real auth path)
      const gitRow = this.addDiagRow(container, `${label} — testing git auth…`, "loading");
      const ls = await this.plugin.gitManager.testRemote(url);
      if (ls.ok) {
        this.setDiagRow(gitRow, `${label} — git auth OK`, "success");
      } else {
        this.setDiagRow(gitRow, `${label} — git auth failed: ${ls.message}`, "error");
      }
    }
  }

  private addDiagRow(
    container: HTMLElement,
    text: string,
    status: "success" | "error" | "loading",
  ): HTMLElement {
    const row = container.createDiv({ cls: `ghs-status-badge ${status}` });
    setIcon(row.createSpan(), status === "success" ? "check-circle" : status === "error" ? "alert-circle" : "loader-2");
    row.createSpan({ text });
    return row;
  }

  private setDiagRow(
    row: HTMLElement,
    text: string,
    status: "success" | "error" | "loading",
  ): void {
    row.empty();
    row.removeClass("success", "error", "loading");
    row.addClass(status);
    setIcon(row.createSpan(), status === "success" ? "check-circle" : status === "error" ? "alert-circle" : "loader-2");
    row.createSpan({ text });
  }
}
