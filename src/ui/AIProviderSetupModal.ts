import { App, Modal, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { L } from "../i18n";
import type { AISettings } from "../settings";

/** Onboarding covers the four household names; the full pi provider
 * catalog is available in Settings → AI. */
const MODAL_PROVIDERS = ["openai", "google", "anthropic", "deepseek"] as const;

function getToken(ai: AISettings, id: string): string {
  return ai.providers.find((p) => p.provider === id)?.token ?? "";
}

function setToken(ai: AISettings, id: string, token: string): void {
  const existing = ai.providers.find((p) => p.provider === id);
  if (existing) {
    existing.token = token;
  } else if (token) {
    ai.providers.push({ provider: id, token, model: "", baseUrl: "" });
  }
}

export class AIProviderSetupModal extends Modal {
  private openai = "";
  private gemini = "";
  private claude = "";
  private deepseek = "";
  private saved = false;
  private errorEl: HTMLElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private plugin: GitHubSyncPlugin,
    private onResolve: (saved: boolean) => void,
  ) {
    super(app);
    this.openai = getToken(plugin.settings.ai, "openai");
    this.gemini = getToken(plugin.settings.ai, "google");
    this.claude = getToken(plugin.settings.ai, "anthropic");
    this.deepseek = getToken(plugin.settings.ai, "deepseek");
  }

  onOpen(): void {
    const t = L().settings;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-ai-setup-modal");

    const header = contentEl.createDiv("ghs-ai-setup-header");
    const iconWrap = header.createDiv("ghs-ai-setup-icon");
    setIcon(iconWrap, "sparkles");
    const headerBody = header.createDiv();
    headerBody.createEl("h3", { text: t.aiSetupTitle });
    headerBody.createEl("p", { text: t.aiSetupDesc, cls: "ghs-ai-setup-sub" });

    // Order: OpenAI → Gemini → Claude → DeepSeek
    this.renderField(contentEl, {
      label: t.openaiLabel,
      hint: t.openaiDesc,
      hintHref: "https://platform.openai.com/api-keys",
      placeholder: "sk-…",
      initial: this.openai,
      onChange: (v) => { this.openai = v.trim(); this.refresh(); },
    });

    this.renderField(contentEl, {
      label: t.geminiLabel,
      hint: t.geminiDesc,
      hintHref: "https://aistudio.google.com/app/apikey",
      placeholder: "AIza…",
      initial: this.gemini,
      onChange: (v) => { this.gemini = v.trim(); this.refresh(); },
    });

    this.renderField(contentEl, {
      label: t.claudeLabel,
      hint: t.claudeDesc,
      hintHref: "https://console.anthropic.com/settings/keys",
      placeholder: "sk-ant-…",
      initial: this.claude,
      onChange: (v) => { this.claude = v.trim(); this.refresh(); },
    });

    this.renderField(contentEl, {
      label: t.deepseekLabel,
      hint: t.deepseekDesc,
      hintHref: "https://platform.deepseek.com/api_keys",
      placeholder: "sk-…",
      initial: this.deepseek,
      onChange: (v) => { this.deepseek = v.trim(); this.refresh(); },
    });

    this.errorEl = contentEl.createDiv("ghs-ai-setup-error");
    this.errorEl.addClass("ghs-hidden");

    const footer = contentEl.createDiv("ghs-ai-setup-footer");
    const skip = footer.createEl("button", {
      text: t.aiSetupSkip,
      cls: "ghs-ai-setup-skip",
    });
    skip.onclick = () => this.close();

    this.saveBtn = footer.createEl("button", {
      text: t.aiSetupCta,
      cls: "mod-cta",
    });
    this.saveBtn.onclick = () => this.save();

    this.refresh();
  }

  onClose(): void {
    this.onResolve(this.saved);
    this.contentEl.empty();
  }

  private renderField(
    parent: HTMLElement,
    o: {
      label: string;
      hint: string;
      hintHref: string;
      placeholder: string;
      initial: string;
      onChange: (v: string) => void;
    },
  ): void {
    const t = L().settings;
    const wrap = parent.createDiv("ghs-wizard-field");
    wrap.createEl("label", { text: o.label });

    const hint = wrap.createDiv("ghs-field-hint");
    hint.appendText(o.hint + " · ");
    const link = hint.createEl("a", { text: t.aiSetupHintLink, href: o.hintHref });
    link.setAttr("target", "_blank");

    const row = wrap.createDiv("ghs-wizard-token-row");
    const input = row.createEl("input", { attr: { placeholder: o.placeholder } });
    input.type = "password";
    input.value = o.initial;
    input.oninput = () => o.onChange(input.value);

    const eye = row.createEl("button", { cls: "ghs-eye-btn" });
    setIcon(eye, "eye");
    eye.onclick = () => {
      input.type = input.type === "password" ? "text" : "password";
    };
  }

  private refresh(): void {
    if (!this.saveBtn) return;
    const hasOne =
      this.openai.length > 0 ||
      this.gemini.length > 0 ||
      this.claude.length > 0 ||
      this.deepseek.length > 0;
    this.saveBtn.disabled = !hasOne;
    if (this.errorEl) this.errorEl.addClass("ghs-hidden");
  }

  private async save(): Promise<void> {
    const t = L().settings;
    if (!this.openai && !this.gemini && !this.claude && !this.deepseek) {
      if (this.errorEl) {
        this.errorEl.removeClass("ghs-hidden");
        this.errorEl.setText(t.aiSetupNoKey);
      }
      return;
    }
    const values: Record<(typeof MODAL_PROVIDERS)[number], string> = {
      openai: this.openai,
      google: this.gemini,
      anthropic: this.claude,
      deepseek: this.deepseek,
    };
    for (const id of MODAL_PROVIDERS) setToken(this.plugin.settings.ai, id, values[id]);
    await this.plugin.saveSettings();
    this.saved = true;
    this.close();
  }
}
