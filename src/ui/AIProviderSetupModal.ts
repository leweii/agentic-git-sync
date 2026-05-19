import { App, Modal, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { L } from "../i18n";

export class AIProviderSetupModal extends Modal {
  private deepseek = "";
  private gemini = "";
  private saved = false;
  private errorEl: HTMLElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;

  constructor(
    app: App,
    private plugin: GitHubSyncPlugin,
    private onResolve: (saved: boolean) => void,
  ) {
    super(app);
    this.deepseek = plugin.settings.ai.deepseekToken;
    this.gemini = plugin.settings.ai.geminiToken;
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

    this.renderField(contentEl, {
      label: t.deepseekLabel,
      hint: t.deepseekDesc,
      hintHref: "https://platform.deepseek.com/api_keys",
      placeholder: "sk-…",
      initial: this.deepseek,
      onChange: (v) => {
        this.deepseek = v.trim();
        this.refresh();
      },
    });

    this.renderField(contentEl, {
      label: t.geminiLabel,
      hint: t.geminiDesc,
      hintHref: "https://aistudio.google.com/app/apikey",
      placeholder: "AIza…",
      initial: this.gemini,
      onChange: (v) => {
        this.gemini = v.trim();
        this.refresh();
      },
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
    const hasOne = this.deepseek.length > 0 || this.gemini.length > 0;
    this.saveBtn.disabled = !hasOne;
    if (this.errorEl) this.errorEl.addClass("ghs-hidden");
  }

  private async save(): Promise<void> {
    const t = L().settings;
    if (!this.deepseek && !this.gemini) {
      if (this.errorEl) {
        this.errorEl.removeClass("ghs-hidden");
        this.errorEl.setText(t.aiSetupNoKey);
      }
      return;
    }
    this.plugin.settings.ai.deepseekToken = this.deepseek;
    this.plugin.settings.ai.geminiToken = this.gemini;
    await this.plugin.saveSettings();
    this.saved = true;
    this.close();
  }
}
