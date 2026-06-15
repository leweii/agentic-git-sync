import { App, Modal, Notice, PluginSettingTab, Setting, TextComponent, requestUrl, setIcon } from "obsidian";
import type GitHubSyncPlugin from "./main";
import type { SyncHistoryEntry } from "./types";
import { L, setLang, tf, type Lang } from "./i18n";
import { checkRepoAccess, fetchRepoDefaultBranch, type GitHubUser } from "./git/githubApi";
import { AddSubmoduleModal } from "./ui/AddSubmoduleModal";
import { RepoPickerModal } from "./ui/RepoPickerModal";
import { AIProviderSetupModal } from "./ui/AIProviderSetupModal";
import { EditSubmoduleModal } from "./ui/EditSubmoduleModal";
import { SetupWizard } from "./ui/SetupWizard";
import type { AIProvider } from "./ai/AIProvider";
import { testAIProvider } from "./ai/AIProvider";
import { OpenAIProvider } from "./ai/OpenAIProvider";
import { GeminiProvider } from "./ai/GeminiProvider";
import { ClaudeProvider } from "./ai/ClaudeProvider";
import { DeepSeekProvider } from "./ai/DeepSeekProvider";

export interface SubmoduleConfig {
  id: string;
  localPath: string;
  remoteUrl: string;
  branch: string;
  /**
   * Baseline branch (team mode only; undefined in personal mode). Set
   * to the repo's default branch when a submodule is added. When it
   * differs from `branch`, every sync fetches `origin/<upstreamBranch>`
   * and merges it into the working branch before pushing — letting a
   * team member on `jakob-edits` automatically pick up changes teammates
   * pushed to `main`. When it equals `branch`, the merge is a no-op and
   * the user is simply working directly on the baseline. Conflicts on
   * the cross-branch merge auto-resolve in favour of the baseline.
   */
  upstreamBranch?: string;
  autoSync: boolean;
  syncInterval: number;
}

export interface AISettings {
  enabled: boolean;
  silentMode: boolean;
  silentAutonomyLevel: number;
  // Order here reflects the UI / runtime preference order:
  // OpenAI → Gemini → Claude → DeepSeek.
  openaiToken: string;
  openaiModel: string;
  geminiToken: string;
  geminiModel: string;
  claudeToken: string;
  claudeModel: string;
  deepseekToken: string;
  deepseekModel: string;
  sendFilePaths: boolean;
  sendGitMetadata: boolean;
  sendSurroundingContext: boolean;
  excludePatterns: string[];
}

/**
 * Personal: solo user. Hides the per-submodule "upstream branch" field
 * in modals — that's a team workflow (track a teammate's branch, absorb
 * their changes).
 * Team: shows upstream-branch UI so users on a personal branch can
 * declare which shared branch (e.g., main) to keep merging in.
 */
export type UsageMode = "personal" | "team";

/** How the plugin authenticates to GitHub. */
export type AuthMethod = "githubApp" | "pat";

/** One installation of the Agentic Git Sync GitHub App (an account the app is on). */
export interface GitHubAppInstallation {
  id: number;
  accountLogin: string;
  accountType: "User" | "Organization";
}

/**
 * One connected GitHub identity (a backend session). Most users have
 * exactly one; a second appears only when syncing repos owned by a
 * different GitHub identity (DESIGN.md §6A, case B).
 */
export interface GitHubAppConnection {
  sessionId: string;
  login: string;
  installations: GitHubAppInstallation[];
}

export interface GitHubAppSettings {
  connections: GitHubAppConnection[];
}

export interface GitHubSyncSettings {
  setupComplete: boolean;
  language: Lang;
  usageMode: UsageMode;
  syncOnStartup: boolean;
  autoSyncInterval: number;
  gitUser: string;
  gitEmail: string;
  /** Default auth path. PAT is the "advanced/offline" fallback. */
  authMethod: AuthMethod;
  /**
   * Personal access token — only used when authMethod === "pat". SECRET:
   * persisted to the per-device secret store (config/secretStore.ts),
   * never to data.json or .github-sync.json.
   */
  githubToken: string;
  /**
   * Per-device random id (base64url), generated on first connect. Bound
   * into the backend session so a leaked sessionId alone can't mint
   * tokens. SECRET: kept in the per-device secret store outside the vault
   * (never written to data.json or .github-sync.json).
   */
  deviceId: string;
  /**
   * GitHub App connections. SECRET (each connection carries a backend
   * sessionId): kept in the per-device secret store outside the vault,
   * never in data.json or .github-sync.json.
   */
  githubApp: GitHubAppSettings;
  mainRepoUrl: string;
  mainRepoBranch: string;
  submodules: SubmoduleConfig[];
  ignorePatterns: string[];
  historyLimit: number;
  syncHistory: SyncHistoryEntry[];
  confirmBeforeSync: boolean;
  ai: AISettings;
}

/**
 * Maps retired/sunset provider model names to their current
 * replacements. Used by loadSettings() to silently upgrade saved
 * `ai.*Model` values from older installs — since the model field
 * has no UI yet, any saved value matching a previous default is
 * "default-inherited, not explicit choice."
 *
 * Add a row here when bumping a default in DEFAULT_SETTINGS so
 * existing data.json + .github-sync.json files migrate cleanly
 * instead of leaving users with a 404 from the provider API.
 */
const STALE_MODEL_REPLACEMENTS: Record<string, string> = {
  "gemini-1.5-flash":    "gemini-2.5-flash",
  "gemini-1.5-flash-8b": "gemini-2.5-flash",
  "gemini-2.0-flash":    "gemini-2.5-flash",
  // `gemini-3-flash` was set as a default during development but the
  // model never shipped under that public ID — installs that briefly
  // ran with it now 404 on every probe. Roll forward to the real
  // current-gen flash model.
  "gemini-3-flash":      "gemini-2.5-flash",
  "gpt-4o-mini":         "gpt-5.5",
  "gpt-4.1-mini":        "gpt-5.5",
  "gpt-4.1-nano":        "gpt-5.5",
  // `deepseek-v4-flash` was the placeholder default in early builds but
  // never existed on the DeepSeek API — requests 400 on "unknown model".
  // Roll forward to the documented chat alias.
  "deepseek-v4-flash":   "deepseek-chat",
};

export function migrateStaleModels(ai: AISettings): AISettings {
  const replace = (v: string) => STALE_MODEL_REPLACEMENTS[v] ?? v;
  // claudeModel may be missing on data.json files saved before 1.3.x — fall
  // back to the default so loadSettings produces a usable AISettings shape.
  const claudeModel = typeof ai.claudeModel === "string" && ai.claudeModel
    ? ai.claudeModel
    : "claude-sonnet-4-5";
  const claudeToken = typeof ai.claudeToken === "string" ? ai.claudeToken : "";
  return {
    ...ai,
    openaiModel: replace(ai.openaiModel),
    geminiModel: replace(ai.geminiModel),
    claudeToken,
    claudeModel: replace(claudeModel),
    deepseekModel: replace(ai.deepseekModel),
  };
}

export const DEFAULT_SETTINGS: GitHubSyncSettings = {
  setupComplete: false,
  language: "en",
  usageMode: "personal",
  syncOnStartup: true,
  autoSyncInterval: 30,
  gitUser: "",
  gitEmail: "",
  // Fresh installs land on the GitHub App tab — it's the recommended
  // path now that the Connect flow is complete. Existing PAT installs
  // are kept on "pat" by a migration guard in loadSettings().
  authMethod: "githubApp",
  githubToken: "",
  deviceId: "",
  githubApp: { connections: [] },
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
    silentAutonomyLevel: 3,
    openaiToken: "",
    openaiModel: "gpt-5.5",
    geminiToken: "",
    geminiModel: "gemini-2.5-flash",
    claudeToken: "",
    claudeModel: "claude-sonnet-4-5",
    deepseekToken: "",
    deepseekModel: "deepseek-chat",
    sendFilePaths: true,
    sendGitMetadata: true,
    sendSurroundingContext: true,
    excludePatterns: [".env", ".env.*", "secrets/**", "*.private.md", "private/**", "**/credentials.*"],
  },
};

export class GitHubSyncSettingTab extends PluginSettingTab {
  plugin: GitHubSyncPlugin;
  private readonly _onConnected = () => this.display();

  constructor(app: App, plugin: GitHubSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ghs-settings");
    this.plugin.appAuth.addConnectedListener(this._onConnected);

    this.renderSilentHero(containerEl);
    this.renderAccount(containerEl);
    this.renderRepository(containerEl);
    this.renderAI(containerEl);
    this.renderGeneral(containerEl);
    this.renderSaveBar(containerEl);
  }

  hide(): void {
    this.plugin.appAuth.removeConnectedListener(this._onConnected);
  }

  /**
   * Page-level Save & close. Stands alone at the bottom — settings are
   * already auto-saved on every change, so this button is just a visible
   * "I'm done" affordance plus a shortcut to dismiss the modal.
   */
  private renderSaveBar(parent: HTMLElement): void {
    const t = L().settings;
    const bar = parent.createDiv("ghs-save-bar");
    const btn = bar.createEl("button", { text: t.saveAndClose, cls: "mod-cta" });
    btn.onclick = async () => {
      await this.plugin.saveSettings();
      new Notice(t.settingsSaved);
      const setting = (this.app as unknown as { setting?: { close: () => void } }).setting;
      setting?.close();
    };
  }

  // ── Smart-sync hero (signature feature) ──────────────────────

  private renderSilentHero(parent: HTMLElement): void {
    const t = L().settings;
    const ai = this.plugin.settings.ai;
    const hasKey = !!(ai.openaiToken || ai.geminiToken || ai.claudeToken || ai.deepseekToken);

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
      const currentHasKey = !!(a.openaiToken || a.geminiToken || a.claudeToken || a.deepseekToken);
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
      slider.value = String(ai.silentAutonomyLevel);
      const valueEl = tuning.createDiv("ghs-silent-tuning-value");
      valueEl.setText(String(ai.silentAutonomyLevel));
      slider.oninput = () => valueEl.setText(slider.value);
      slider.onchange = async () => {
        this.plugin.settings.ai.silentAutonomyLevel = parseInt(slider.value, 10);
        await this.plugin.saveSettings();
      };
    }

    // Setup wizard lives in the hero so a new user has a single
    // jumping-off point: enable smart sync and/or run the guided
    // token + repo connection flow without scrolling.
    const action = hero.createDiv("ghs-silent-action");
    action.createDiv({ cls: "ghs-silent-action-label", text: t.runSetupWizardDesc });
    const wizardBtn = action.createEl("button", {
      text: t.runSetupWizard,
      cls: "mod-cta",
    });
    wizardBtn.onclick = () => new SetupWizard(this.app, this.plugin, () => this.display()).open();
  }

  // ── 1. Repository ────────────────────────────────────────────

  private renderRepository(parent: HTMLElement): void {
    const t = L().settings;
    const card = this.sectionHeader(parent, t.sectionRepo);

    const s = this.plugin.settings;

    // Forward reference to the branch field so the URL field can auto-fill
    // it. Assigned below when the branch Setting is built.
    let branchInput: TextComponent | null = null;
    // Track manual edits — once the user types their own branch, their
    // intent wins and we stop overwriting it with the detected default.
    let branchUserEdited = !!s.mainRepoBranch && s.mainRepoBranch !== "main";

    // Debounced default-branch detection: after the URL changes to something
    // valid, ask GitHub for the repo's actual default branch (main, master,
    // develop, …) and pre-fill the Branch field — guessing wrong causes a
    // cryptic "src refspec does not match" on first push.
    let detectTimer: number | null = null;
    let lastDetectedUrl = "";
    const detectDefaultBranch = (url: string): void => {
      if (detectTimer !== null) window.clearTimeout(detectTimer);
      detectTimer = window.setTimeout(() => {
        void (async () => {
          if (url === lastDetectedUrl) return;
          lastDetectedUrl = url;
          const def = await fetchRepoDefaultBranch(url, this.plugin.settings.githubToken);
          if (def && !branchUserEdited && branchInput !== null) {
            // setValue() doesn't fire onChange, so persist explicitly.
            branchInput.setValue(def);
            this.plugin.settings.mainRepoBranch = def;
            await this.plugin.saveSettings();
          }
        })();
      }, 400);
    };

    // Editable URL field. Persists on each keystroke so the global Save
    // button at the bottom is purely a "close" convenience, not the
    // load-bearing persistence step.
    new Setting(card)
      .setName(t.repoUrlLabel)
      .setDesc(t.repoUrlDesc)
      .addText((tx) => {
        tx.setPlaceholder(t.repoUrlPlaceholder)
          .setValue(s.mainRepoUrl)
          .onChange(async (v) => {
            const url = v.trim();
            this.plugin.settings.mainRepoUrl = url;
            await this.plugin.saveSettings();
            if (url) detectDefaultBranch(url);
          });
        tx.inputEl.addClass("ghs-token-input");
        // Browse repos the GitHub App can access (App mode only).
        if (this.plugin.settings.authMethod === "githubApp") {
          this.addRepoBrowseButton(tx.inputEl, async (cloneUrl) => {
            tx.setValue(cloneUrl);
            this.plugin.settings.mainRepoUrl = cloneUrl;
            await this.plugin.saveSettings();
            detectDefaultBranch(cloneUrl);
          });
        }
      });

    // Editable branch field.
    new Setting(card)
      .setName(t.repoBranchLabel)
      .addText((tx) => {
        branchInput = tx;
        tx.setPlaceholder(t.repoBranchPlaceholder)
          .setValue(s.mainRepoBranch || "main")
          .onChange(async (v) => {
            branchUserEdited = true;
            this.plugin.settings.mainRepoBranch = v.trim() || "main";
            await this.plugin.saveSettings();
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

    // Submodules list — its own card, separate from the connected-repo card.
    // Always shown so the Add button is reachable even when the list is empty.
    const subsCard = this.sectionHeader(parent, t.repoSubmodules, { count: s.submodules.length });
    for (const sub of s.submodules) {
      const desc = sub.upstreamBranch
        ? `${sub.remoteUrl} · ${sub.branch} ← ${sub.upstreamBranch}`
        : `${sub.remoteUrl} · ${sub.branch}`;
      // Held outside `new Setting()` so the per-submodule diagnostic
      // rows render under the row, not inline with the buttons.
      const subStatusEl = createDiv("ghs-diag-container ghs-submodule-status");
      subStatusEl.addClass("ghs-hidden");
      new Setting(subsCard)
        .setName(sub.localPath)
        .setDesc(desc)
        .addExtraButton((b) =>
          b.setIcon("plug-zap")
            .setTooltip("Test connection")
            .onClick(() => this.testSingleSubmodule(sub, subStatusEl))
        )
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
      subsCard.appendChild(subStatusEl);
    }
    new Setting(subsCard)
      .addButton((b) =>
        b.setCta()
          .setIcon("plus")
          .setButtonText(L().dashboard.addRepository)
          .onClick(() => new AddSubmoduleModal(this.app, this.plugin).open())
      );
  }

  /**
   * Run the same two-step check as the global Test connection button
   * (GitHub API repo access + `git ls-remote` through the real auth
   * path) but scoped to one submodule. Used after AddSubmoduleModal
   * persists a config whose clone failed: the user clicks here to see
   * *why* — token unset, SSO block, missing org grant, etc. — without
   * having to re-test every other repo.
   */
  private async testSingleSubmodule(
    sub: SubmoduleConfig,
    container: HTMLElement,
  ): Promise<void> {
    const t = L().settings;
    container.empty();
    container.removeClass("ghs-hidden");

    const token = this.plugin.settings.githubToken;
    if (!token) {
      this.addDiagRow(container, t.testNoToken, "error");
      return;
    }

    const apiRow = this.addDiagRow(
      container,
      `${sub.localPath} — checking repo access…`,
      "loading",
    );
    const access = await checkRepoAccess(sub.remoteUrl, token);
    if (!access.ok) {
      this.setDiagRow(
        apiRow,
        `${sub.localPath} — ${access.reason} (HTTP ${access.status})`,
        "error",
      );
      return;
    }
    const pushTag = access.canPush ? "read+write" : "read only";
    const emptyTag = access.isEmpty ? ", empty (will auto-init)" : "";
    this.setDiagRow(
      apiRow,
      `${sub.localPath} — ${access.fullName} (${pushTag}${emptyTag})`,
      "success",
    );

    const gitRow = this.addDiagRow(
      container,
      `${sub.localPath} — testing git auth…`,
      "loading",
    );
    const ls = await this.plugin.gitManager.testRemote(sub.remoteUrl);
    if (ls.ok) {
      this.setDiagRow(gitRow, `${sub.localPath} — git auth OK`, "success");
    } else {
      this.setDiagRow(
        gitRow,
        `${sub.localPath} — git auth failed: ${ls.message}`,
        "error",
      );
    }
  }

  private confirmRemoveSubmodule(id: string, label: string): void {
    const modal = new (class extends Modal {
      constructor(app: App, private onConfirm: () => Promise<void>) { super(app); }
      onOpen(): void {
        const { contentEl } = this;
        new Setting(contentEl).setName(`Remove submodule "${label}"?`).setHeading();
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

  // ── 2. Account (token + identity) ────────────────────────────

  /**
   * GitHub App connection UI (Layer 4): a one-click Connect + per-identity
   * status with Disconnect/Refresh. The PAT row below remains as an
   * advanced/offline fallback. After authorizing in the browser the deep
   * link updates settings; the Refresh button re-renders this tab if it
   * was left open.
   */
  /** Append a "browse repos" button right after an input, opening the picker. */
  private addRepoBrowseButton(
    inputEl: HTMLInputElement,
    onPick: (cloneUrl: string) => void | Promise<void>,
  ): void {
    const btn = createEl("button", {
      cls: "ghs-browse-btn clickable-icon",
      attr: { type: "button", "aria-label": "Browse repositories" },
    });
    setIcon(btn, "search");
    btn.onclick = () =>
      new RepoPickerModal(this.app, this.plugin, (cloneUrl) => void onPick(cloneUrl)).open();
    inputEl.insertAdjacentElement("afterend", btn);
  }

  private renderGitHubAppRow(card: HTMLElement): void {
    const conns = this.plugin.settings.githubApp?.connections ?? [];

    if (conns.length === 0) {
      // Disconnected: single row describing the option + connect CTA.
      const desc = createFragment();
      desc.appendText("Connect once, no token to manage. ");
      const installLink = desc.createEl("a", { text: "Install the app on GitHub →" });
      installLink.setAttribute("href", "https://github.com/apps/agentic-git-sync");
      installLink.setAttribute("target", "_blank");
      installLink.setAttribute("rel", "noopener");
      const s = new Setting(card)
        .setDesc(desc)
        .addButton((b) =>
          b.setCta().setButtonText("Connect with GitHub App →").onClick(() => {
            void this.plugin.appAuth.beginConnect();
          })
        );
      setIcon(s.nameEl.createSpan({ cls: "ghs-app-name-icon" }), "github");
      s.nameEl.createSpan({ text: "GitHub App" });
      s.nameEl.createSpan({ cls: "ghs-app-recommended", text: "Recommended" });
      return;
    }

    // Connected: one compact row per account — ✓ @login / Access: orgs.
    for (const c of conns) {
      const accessList =
        c.installations.map((i) => i.accountLogin).join(", ") || "no installations yet";
      const s = new Setting(card)
        .setDesc(`Access: ${accessList}`)
        .addExtraButton((b) =>
          b.setIcon("refresh-cw").setTooltip("Refresh installations").onClick(async () => {
            try {
              await this.plugin.appAuth.refreshInstallations(c.login);
            } catch (e) {
              new Notice(`Couldn't refresh: ${(e as Error).message}`);
            }
            this.display();
          })
        )
        .addButton((b) =>
          b.setWarning().setButtonText("Disconnect").onClick(async () => {
            await this.plugin.appAuth.disconnect(c.login);
            this.display();
          })
        );
      setIcon(s.nameEl.createSpan({ cls: "ghs-app-conn-icon" }), "check-circle");
      s.nameEl.createSpan({ text: `@${c.login}` });
    }

    // Tertiary action: connect a second GitHub identity (rare — only needed
    // when syncing repos owned by a different GitHub account).
    const addRow = card.createDiv("ghs-app-add-row");
    const addBtn = addRow.createEl("button", {
      cls: "ghs-app-add-btn",
      text: "+ Connect more GitHub accounts",
      attr: { title: "Only needed when syncing repos owned by a different GitHub identity" },
    });
    addBtn.onclick = () => void this.plugin.appAuth.beginConnect();
  }

  private renderAccount(parent: HTMLElement): void {
    const t = L().settings;
    const card = this.sectionHeader(parent, t.sectionAccount);

    const authMethod = this.plugin.settings.authMethod;

    // ── Tab bar ────────────────────────────────────────────────
    const tabBar = card.createDiv("ghs-auth-tabs");
    const appTab = tabBar.createEl("button", {
      text: "GitHub App",
      cls: "ghs-auth-tab" + (authMethod === "githubApp" ? " is-active" : ""),
      attr: { type: "button" },
    });
    const patTab = tabBar.createEl("button", {
      text: "Personal Access Token",
      cls: "ghs-auth-tab" + (authMethod === "pat" ? " is-active" : ""),
      attr: { type: "button" },
    });

    const switchTo = async (method: AuthMethod) => {
      this.plugin.settings.authMethod = method;
      await this.plugin.saveSettings();
      this.display();
    };
    appTab.onclick = () => void switchTo("githubApp");
    patTab.onclick = () => void switchTo("pat");

    // ── Tab content ────────────────────────────────────────────
    const tabContent = card.createDiv("ghs-auth-tab-content");

    if (authMethod === "githubApp") {
      this.renderGitHubAppRow(tabContent);
    } else {
      let tokenInputEl: HTMLInputElement | null = null;
      let tokenDebounce: number | null = null;

      const testBadge = tabContent.createDiv("ghs-inline-badge ghs-test-badge ghs-hidden");

      const renderBadge = (status: "loading" | "success" | "error", login?: string) => {
        testBadge.empty();
        testBadge.removeClass("ghs-hidden", "success", "error", "loading");
        testBadge.addClass(status);
        if (status === "loading") {
          setIcon(testBadge.createSpan(), "loader");
          testBadge.createSpan({ text: " Verifying…" });
        } else if (status === "success") {
          setIcon(testBadge.createSpan(), "check-circle-2");
          testBadge.createSpan({ text: ` Connected as @${login}` });
        } else {
          setIcon(testBadge.createSpan(), "x-circle");
          testBadge.createSpan({ text: " Invalid token — check permissions" });
        }
      };

      const fetchIdentity = async (token: string) => {
        if (token.length < 10) { testBadge.addClass("ghs-hidden"); return; }
        renderBadge("loading");
        try {
          const res = await requestUrl({
            url: "https://api.github.com/user",
            headers: { Authorization: `token ${token}`, "User-Agent": "ObsidianGitHubSync" },
            throw: false,
          });
          if (res.status === 200) {
            const user = res.json as GitHubUser;
            renderBadge("success", user.login);
            await this.plugin.saveSettings();
            this.plugin.reinitGit();
          } else {
            renderBadge("error");
          }
        } catch {
          renderBadge("error");
        }
      };

      const tokenSetting = new Setting(tabContent)
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
              if (tokenDebounce) window.clearTimeout(tokenDebounce);
              tokenDebounce = window.setTimeout(() => { void fetchIdentity(v.trim()); }, 600);
            });
        })
        .addExtraButton((b) =>
          b.setIcon("plug-zap")
            .setTooltip(L().common.test)
            .onClick(() => this.testConnection(testBadge))
        );
      tokenSetting.settingEl.addClass("ghs-key-row");
      tabContent.appendChild(testBadge);
    }

    // ── Git identity (needed by both auth methods for commits) ──
    new Setting(card)
      .setName(t.nameLabel)
      .addText((text) => {
        text
          .setPlaceholder(t.namePlaceholder)
          .setValue(this.plugin.settings.gitUser)
          .onChange(async (v) => {
            this.plugin.settings.gitUser = v;
            await this.plugin.saveSettings();
            this.plugin.reinitGit();
          });
      });

    new Setting(card)
      .setName(t.emailLabel)
      .addText((text) => {
        text
          .setPlaceholder(t.emailPlaceholder)
          .setValue(this.plugin.settings.gitEmail)
          .onChange(async (v) => {
            this.plugin.settings.gitEmail = v;
            await this.plugin.saveSettings();
            this.plugin.reinitGit();
          });
      });
  }

  // ── 3. AI providers (keys only) ──────────────────────────────

  private renderAI(parent: HTMLElement): void {
    const t = L().settings;
    const card = this.sectionHeader(parent, t.sectionAI);

    this.renderAIProviderRow(card, {
      label: t.openaiLabel,
      placeholder: "sk-…",
      getToken: () => this.plugin.settings.ai.openaiToken,
      setToken: (v) => { this.plugin.settings.ai.openaiToken = v; },
      buildProvider: () =>
        new OpenAIProvider({
          token: this.plugin.settings.ai.openaiToken,
          model: this.plugin.settings.ai.openaiModel,
        }),
    });

    this.renderAIProviderRow(card, {
      label: t.geminiLabel,
      placeholder: "AIza…",
      getToken: () => this.plugin.settings.ai.geminiToken,
      setToken: (v) => { this.plugin.settings.ai.geminiToken = v; },
      buildProvider: () =>
        new GeminiProvider({
          token: this.plugin.settings.ai.geminiToken,
          model: this.plugin.settings.ai.geminiModel,
        }),
    });

    this.renderAIProviderRow(card, {
      label: t.claudeLabel,
      placeholder: "sk-ant-…",
      getToken: () => this.plugin.settings.ai.claudeToken,
      setToken: (v) => { this.plugin.settings.ai.claudeToken = v; },
      buildProvider: () =>
        new ClaudeProvider({
          token: this.plugin.settings.ai.claudeToken,
          model: this.plugin.settings.ai.claudeModel,
        }),
    });

    this.renderAIProviderRow(card, {
      label: t.deepseekLabel,
      placeholder: "sk-…",
      getToken: () => this.plugin.settings.ai.deepseekToken,
      setToken: (v) => { this.plugin.settings.ai.deepseekToken = v; },
      buildProvider: () =>
        new DeepSeekProvider({
          token: this.plugin.settings.ai.deepseekToken,
          model: this.plugin.settings.ai.deepseekModel,
        }),
    });
  }

  /**
   * Render one AI provider row: eye toggle, password input, Test button.
   * The status badge below holds the test result so the user can see
   * which provider's check passed/failed without a Notice toast disappearing.
   */
  private renderAIProviderRow(
    card: HTMLElement,
    opts: {
      label: string;
      placeholder: string;
      getToken: () => string;
      setToken: (v: string) => void;
      buildProvider: () => AIProvider;
    },
  ): void {
    const t = L().settings;
    let inputEl: HTMLInputElement | null = null;
    const badge = createDiv("ghs-inline-badge ghs-ai-test-badge");
    badge.addClass("ghs-hidden");

    const keySetting = new Setting(card)
      .setName(opts.label)
      .addExtraButton((b) =>
        b.setIcon("eye").setTooltip(t.tokenShowHide).onClick(() => {
          if (!inputEl) return;
          inputEl.type = inputEl.type === "password" ? "text" : "password";
        })
      )
      .addText((text) => {
        inputEl = text.inputEl;
        text.inputEl.type = "password";
        text
          .setPlaceholder(opts.placeholder)
          .setValue(opts.getToken())
          .onChange(async (v) => {
            opts.setToken(v.trim());
            await this.plugin.saveSettings();
            // Stale badge from a previous test would be misleading now.
            badge.empty();
            badge.addClass("ghs-hidden");
          });
      })
      .addExtraButton((b) =>
        b.setIcon("plug-zap")
          .setTooltip(L().common.test)
          .onClick(() => this.runAITest(opts.buildProvider, badge))
      );
    keySetting.settingEl.addClass("ghs-key-row");
    card.appendChild(badge);
  }

  private async runAITest(
    buildProvider: () => AIProvider,
    badge: HTMLElement,
  ): Promise<void> {
    badge.empty();
    badge.removeClass("ghs-hidden", "valid", "invalid", "loading");
    badge.addClass("loading");
    setIcon(badge.createSpan(), "loader-2");
    badge.createSpan({ text: L().settings.testVerifying });

    const result = await testAIProvider(buildProvider());
    badge.empty();
    badge.removeClass("loading", "valid", "invalid");
    badge.addClass(result.ok ? "valid" : "invalid");
    setIcon(badge.createSpan(), result.ok ? "check-circle" : "alert-circle");
    badge.createSpan({ text: result.ok ? "OK" : `Failed: ${result.message}` });
  }

  // ── 4. General (language + tools) ────────────────────────────

  private renderGeneral(parent: HTMLElement): void {
    const t = L().settings;
    const card = this.sectionHeader(parent, t.sectionGeneral);

    new Setting(card)
      .setName(t.sectionUsageMode)
      .setDesc(t.usageModeDesc)
      .addDropdown((dd) =>
        dd
          .addOption("personal", t.usageModePersonal)
          .addOption("team", t.usageModeTeam)
          .setValue(this.plugin.settings.usageMode ?? "personal")
          .onChange(async (v) => {
            this.plugin.settings.usageMode = v as "personal" | "team";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(card)
      .setName(t.sectionLanguage)
      .addDropdown((dd) =>
        dd
          .addOption("en", t.languageEn)
          .addOption("zh", t.languageZh)
          .addOption("zh-tw", t.languageZhTw)
          .addOption("ja", t.languageJa)
          .setValue(this.plugin.settings.language ?? "en")
          .onChange(async (v) => {
            this.plugin.settings.language = v as Lang;
            setLang(v as Lang);
            await this.plugin.saveSettings();
            this.display();
          })
      );

    // Order is intentional: most-frequently-used at the top, destructive at
    // the bottom. Language and event log are everyday tools; clear history
    // is occasional; reset is the nuclear option.
    new Setting(card)
      .setName(t.eventLog)
      .setDesc(t.eventLogDesc)
      .addButton((b) =>
        b.setButtonText(t.openLogFolder).onClick(() => {
          const dir = this.plugin.eventLog?.directory;
          if (!dir) {
            new Notice(t.eventLogNotReady);
            return;
          }
          const req = (window as unknown as { require?: (m: string) => unknown }).require;
          if (req) {
            try {
              const electron = req("electron") as { shell?: { openPath?: (p: string) => void } };
              electron?.shell?.openPath?.(dir);
              return;
            } catch { /* fall through to manual-path Notice */ }
          }
          new Notice(tf(t.logFolderCopied, dir), 8000);
        })
      )
      .addButton((b) =>
        b.setButtonText(t.reportBug).setCta().onClick(async () => {
          const result = await this.plugin.openBugReportEmail();
          if (!result.ok) {
            new Notice(
              result.filePath
                ? tf(t.bugReportNoMail, result.filePath)
                : tf(t.bugReportNoFile, result.error ?? "unknown error"),
              15000,
            );
            return;
          }
          new Notice(
            result.truncated
              ? tf(t.bugReportTruncated, result.filePath)
              : t.bugReportOpened,
            8000,
          );
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

    new Setting(card)
      .setName(t.resetPlugin)
      .setDesc(t.resetPluginDesc)
      .addButton((b) =>
        b.setButtonText(t.resetButton).setWarning().onClick(() => this.confirmResetPlugin())
      );
  }

  /**
   * Two-step destructive confirmation. The user must type RESET before the
   * action button enables — this is the equivalent of `rm -rf` for the
   * plugin's git state, and a misclick would force the user to manually
   * reconnect every repo.
   */
  private confirmResetPlugin(): void {
    const plugin = this.plugin;
    const refresh = () => this.display();
    const subCount = plugin.settings.submodules.length;

    const t = L().settings;
    const modal = new (class extends Modal {
      onOpen(): void {
        const { contentEl } = this;
        new Setting(contentEl).setName(t.resetModalTitle).setHeading();
        const intro = contentEl.createEl("p", { cls: "ghs-confirm-desc" });
        intro.createSpan({ text: t.resetModalIntro });
        const list = contentEl.createEl("ul");
        list.createEl("li", { text: t.resetModalEraseSettings });
        list.createEl("li", { text: t.resetModalRenameGit });
        if (subCount > 0) {
          list.createEl("li", {
            text: subCount === 1
              ? t.resetModalRenameSubsOne
              : tf(t.resetModalRenameSubsMany, subCount),
          });
        }
        list.createEl("li", { text: t.resetModalDeleteConfig });
        contentEl.createEl("p", { text: t.resetModalNotesNotice, cls: "ghs-confirm-desc" });
        contentEl.createEl("p", { text: t.resetModalDisableEnable, cls: "ghs-confirm-desc" });

        const typedHint = contentEl.createEl("p", { cls: "ghs-confirm-desc" });
        typedHint.createSpan({ text: t.resetModalTypeToConfirm });
        typedHint.createEl("code", { text: "RESET" });
        typedHint.createSpan({ text: t.resetModalTypeToConfirmAfter });

        const input = contentEl.createEl("input", { type: "text", cls: "ghs-confirm-input" });
        input.placeholder = "RESET";

        const actions = contentEl.createDiv("ghs-confirm-actions");
        const cancel = actions.createEl("button", { text: t.resetModalCancel });
        cancel.onclick = () => this.close();
        const confirm = actions.createEl("button", { text: t.resetModalConfirm, cls: "mod-warning" });
        confirm.setAttribute("disabled", "true");
        input.oninput = () => {
          if (input.value.trim() === "RESET") confirm.removeAttribute("disabled");
          else confirm.setAttribute("disabled", "true");
        };
        confirm.onclick = async () => {
          confirm.setAttribute("disabled", "true");
          try {
            const result = await plugin.resetEverything();
            this.close();
            new Notice(tf(t.resetCompleteNotice, result.backupPaths.length), 8000);
            refresh();
          } catch (e) {
            confirm.removeAttribute("disabled");
            new Notice(tf(t.resetFailedNotice, (e as Error).message));
          }
        };
        window.setTimeout(() => input.focus(), 0);
      }
      onClose(): void { this.contentEl.empty(); }
    })(this.app);
    modal.open();
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
