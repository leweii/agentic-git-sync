import { App, Modal, Notice, setIcon } from "obsidian";
import { L, tf } from "../i18n";

export interface CreatePRSubmitResult {
  ok: boolean;
  url?: string;
  existingUrl?: string;
  reason?: string;
}

export interface BranchDiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}
export interface BranchDiffHunk {
  header: string;
  lines: BranchDiffLine[];
}
export interface BranchDiffFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: BranchDiffHunk[];
  truncated: boolean;
}
export interface BranchDiff {
  files: BranchDiffFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface CreatePRModalOpts {
  head: string;
  base: string;
  defaultTitle: string;
  defaultBody?: string;
  /**
   * Optional AI summariser. Runs silently in the background when the
   * modal opens. Success replaces the field values (unless the user has
   * started typing) and unlocks a ✦ glyph for manual redrafts.
   */
  generate?: () => Promise<{ title: string; body: string } | null>;
  /**
   * Optional lazy loader for the changes panel. Fetched on first
   * expand so the modal stays cheap for users who skip the diff.
   */
  loadChanges?: () => Promise<BranchDiff>;
  submit: (title: string, body: string) => Promise<CreatePRSubmitResult>;
}

/**
 * Collect title/body, then drive the push+create-PR flow through the
 * caller-supplied `submit`. Keeps the modal open across transient
 * failures so the user can retry without re-typing.
 *
 * Visual design choices (see design-improve/pr-modal-2026-05-29):
 *   - Monospace eyebrow header in place of a chatbot-feeling title.
 *   - Float labels (uppercase, inside the field) instead of stacked
 *     "Title / Description" rows above each input.
 *   - AI activity is a shimmer on the field + a static ✦ glyph that
 *     doubles as the redraft control. No prose status text.
 *   - Collapsible changes panel ("N files changed · +X −Y") below the
 *     description, expanding to a GitHub-style file tree + inline diff.
 *   - Footer collapses to one weighted action; cancel is a text link.
 */
export class CreatePRModal extends Modal {
  private titleInput: HTMLInputElement | null = null;
  private bodyInput: HTMLTextAreaElement | null = null;
  private titleField: HTMLDivElement | null = null;
  private bodyField: HTMLDivElement | null = null;
  private aiGlyph: HTMLButtonElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLDivElement | null = null;

  // Changes panel
  private changesEl: HTMLDivElement | null = null;
  private changesToggle: HTMLButtonElement | null = null;
  private changesBody: HTMLDivElement | null = null;
  private changesExpanded = false;
  private changesLoaded = false;
  private changesData: BranchDiff | null = null;
  private activeFilePath: string | null = null;
  private empty = false;

  private generating = false;

  constructor(app: App, private opts: CreatePRModalOpts) {
    super(app);
    this.modalEl.addClass("ghs-create-pr-modal");
  }

  onOpen(): void {
    const t = L().pr;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-pr-modal");

    // ── Eyebrow header (replaces h3 + subtitle) ────────────────
    const eyebrow = contentEl.createDiv("ghs-pr-eyebrow");
    eyebrow.createSpan({ text: "pr", cls: "ghs-pr-eyebrow-tag" });
    eyebrow.createSpan({ text: " · " });
    eyebrow.createSpan({ text: this.opts.head, cls: "ghs-pr-eyebrow-branch" });
    eyebrow.createSpan({ text: " → " });
    eyebrow.createSpan({ text: this.opts.base, cls: "ghs-pr-eyebrow-branch" });

    // ── Body: title + description with float labels ────────────
    const body = contentEl.createDiv("ghs-pr-body");

    this.titleField = body.createDiv("ghs-pr-field");
    this.titleField.createSpan({ text: t.titleLabel, cls: "ghs-pr-float-label" });
    this.titleInput = this.titleField.createEl("input", {
      attr: { type: "text", placeholder: t.titlePlaceholder },
      cls: "ghs-pr-input",
    });
    this.titleInput.value = this.opts.defaultTitle;

    this.bodyField = body.createDiv("ghs-pr-field");
    this.bodyField.createSpan({ text: t.bodyLabel, cls: "ghs-pr-float-label" });
    this.bodyInput = this.bodyField.createEl("textarea", {
      attr: { placeholder: t.bodyPlaceholder, rows: "6" },
      cls: "ghs-pr-textarea",
    });
    if (this.opts.defaultBody) this.bodyInput.value = this.opts.defaultBody;

    // ── Changes panel (collapsed by default) ───────────────────
    if (this.opts.loadChanges) {
      this.changesEl = contentEl.createDiv("ghs-pr-changes");
      this.changesToggle = this.changesEl.createEl("button", {
        cls: "ghs-pr-changes-toggle",
      });
      const chev = this.changesToggle.createSpan({ cls: "ghs-pr-changes-chev" });
      setIcon(chev, "chevron-right");
      this.changesToggle.createSpan({
        cls: "ghs-pr-changes-summary",
        text: "…",
      });
      this.changesToggle.onclick = () => void this.toggleChanges();

      this.changesBody = this.changesEl.createDiv("ghs-pr-changes-body");
      this.changesBody.addClass("ghs-hidden");

      // Load the diff up-front so the pill shows the file/lines count
      // immediately, not just after the user clicks expand.
      void this.preloadChanges();
    }

    // ── Status + footer ────────────────────────────────────────
    this.statusEl = contentEl.createDiv("ghs-pr-status ghs-hidden");

    const footer = contentEl.createDiv("ghs-pr-footer");
    const cancel = footer.createEl("button", {
      text: L().common.cancel,
      cls: "ghs-pr-cancel-link",
    });
    cancel.onclick = () => this.close();
    this.submitBtn = footer.createEl("button", {
      text: t.submit,
      cls: "mod-cta ghs-pr-submit-btn",
    });
    this.submitBtn.onclick = () => void this.submit();

    // ── Focus + side-effects ───────────────────────────────────
    window.setTimeout(() => {
      this.titleInput?.focus();
      this.titleInput?.select();
    }, 0);

    if (this.opts.generate) void this.runGenerate();
  }

  // ── AI draft ───────────────────────────────────────────────

  private async runGenerate(opts: { manual?: boolean } = {}): Promise<void> {
    if (this.generating || !this.opts.generate) return;
    const titleBefore = this.titleInput?.value ?? "";
    const bodyBefore = this.bodyInput?.value ?? "";

    this.generating = true;
    this.removeGlyph();
    this.setDrafting(true);

    let result: { title: string; body: string } | null = null;
    try {
      result = await this.opts.generate();
    } catch (e) {
      console.warn("[agentic-git-sync] AI PR draft threw:", (e as Error).message ?? e);
      result = null;
    }

    this.setDrafting(false);
    this.generating = false;

    if (!result) return; // silent fallback

    const overwrite = opts.manual === true;
    if (this.titleInput && (overwrite || this.titleInput.value === titleBefore)) {
      this.titleInput.value = result.title;
    }
    if (this.bodyInput && (overwrite || this.bodyInput.value === bodyBefore)) {
      this.bodyInput.value = result.body;
    }
    if (!this.empty) this.installGlyph();
  }

  private setDrafting(on: boolean): void {
    this.titleField?.toggleClass("ghs-pr-field--drafting", on);
    this.bodyField?.toggleClass("ghs-pr-field--drafting", on);
  }

  private installGlyph(): void {
    if (!this.titleField || this.aiGlyph) return;
    const t = L().pr;
    this.aiGlyph = this.titleField.createEl("button", {
      cls: "ghs-pr-ai-glyph",
      text: "✦",
      attr: { title: t.aiTooltip, "aria-label": t.aiTooltip },
    });
    this.aiGlyph.onclick = (e) => {
      e.preventDefault();
      void this.runGenerate({ manual: true });
    };
  }

  private removeGlyph(): void {
    this.aiGlyph?.remove();
    this.aiGlyph = null;
  }

  // ── Changes panel ──────────────────────────────────────────

  private async toggleChanges(): Promise<void> {
    if (!this.changesEl || !this.changesBody) return;
    this.changesExpanded = !this.changesExpanded;
    this.changesEl.toggleClass("ghs-pr-changes--expanded", this.changesExpanded);
    this.modalEl.toggleClass("ghs-create-pr-modal--wide", this.changesExpanded);
    this.changesBody.toggleClass("ghs-hidden", !this.changesExpanded);
    if (this.changesExpanded && this.changesLoaded) {
      this.renderChangesContent();
    } else if (this.changesExpanded) {
      await this.preloadChanges();
      this.renderChangesContent();
    }
  }

  /**
   * Eagerly fetch the diff once on open so the pill summary reflects
   * the real file count instead of leaving the user staring at "…".
   * The expanded view still renders lazily on first toggle.
   *
   * Also gates the submit button: an empty diff means the branch is
   * already merged (or never diverged), so creating a PR would just be
   * a 422 from GitHub. Disable up-front instead of letting the user
   * mash Create PR.
   */
  private async preloadChanges(): Promise<void> {
    if (!this.opts.loadChanges || this.changesLoaded) return;
    try {
      this.changesData = await this.opts.loadChanges();
    } catch (e) {
      console.warn("[agentic-git-sync] loadChanges failed:", (e as Error).message ?? e);
      this.changesData = { files: [], totalAdditions: 0, totalDeletions: 0 };
    }
    this.changesLoaded = true;
    console.log(
      `[agentic-git-sync] PR changes: ${this.changesData.files.length} files, ` +
      `+${this.changesData.totalAdditions} −${this.changesData.totalDeletions}` +
      (this.changesData.files.length > 0
        ? `; sample: ${this.changesData.files.slice(0, 3).map((f) => f.path).join(", ")}`
        : ""),
    );
    this.renderChangesSummary();

    if (this.changesData.files.length === 0) {
      this.applyEmptyState();
    }
  }

  /**
   * Lock the modal into a "nothing to PR" state: disable submit with
   * a tooltip, swap the pill text to a friendly hint, hide the AI
   * glyph (no point regenerating a title for an empty PR). The user
   * can still close the modal cleanly.
   */
  private applyEmptyState(): void {
    if (this.empty) return;
    this.empty = true;
    const t = L().pr;

    if (this.submitBtn) {
      this.submitBtn.setAttribute("disabled", "true");
      this.submitBtn.setAttribute("title", t.submitDisabled);
      this.submitBtn.setAttribute("aria-disabled", "true");
    }

    if (this.changesToggle) {
      const summary = this.changesToggle.querySelector(".ghs-pr-changes-summary");
      if (summary) {
        summary.textContent = tf(t.nothingToMerge, this.opts.head, this.opts.base);
      }
      this.changesEl?.addClass("ghs-pr-changes--empty");
    }

    // No more redrafts on an empty diff.
    this.removeGlyph();
  }

  private renderChangesSummary(): void {
    if (!this.changesToggle || !this.changesData) return;
    const t = L().pr;
    const summary = this.changesToggle.querySelector(".ghs-pr-changes-summary");
    if (!summary) return;
    const n = this.changesData.files.length;
    const text = (n === 1 ? t.filesChangedOne : t.filesChangedMany);
    summary.textContent = tf(
      text,
      String(n),
      String(this.changesData.totalAdditions),
      String(this.changesData.totalDeletions),
    );
  }

  private renderChangesContent(): void {
    if (!this.changesBody || !this.changesData) return;
    this.changesBody.empty();
    const t = L().pr;

    if (this.changesData.files.length === 0) {
      this.changesBody.createDiv({
        cls: "ghs-pr-changes-empty",
        text: t.diffEmpty,
      });
      return;
    }

    const split = this.changesBody.createDiv("ghs-pr-changes-split");
    const fileList = split.createDiv("ghs-pr-file-list");
    const diffPane = split.createDiv("ghs-pr-diff-pane");

    const renderFile = (path: string) => {
      this.activeFilePath = path;
      const rows = fileList.querySelectorAll(".ghs-pr-file-row");
      rows.forEach((row) => {
        const el = row as HTMLElement;
        el.toggleClass("is-active", el.dataset.path === path);
      });
      this.renderDiffPane(diffPane, path);
    };

    for (const f of this.changesData.files) {
      const row = fileList.createEl("button", { cls: "ghs-pr-file-row" });
      row.dataset.path = f.path;
      row.createSpan({ cls: "ghs-pr-file-path", text: f.path });
      const stats = row.createSpan({ cls: "ghs-pr-file-stats" });
      stats.createSpan({ cls: "ghs-pr-add", text: `+${f.additions}` });
      stats.createSpan({ cls: "ghs-pr-del", text: `−${f.deletions}` });
      row.onclick = () => renderFile(f.path);
    }

    renderFile(this.changesData.files[0].path);
  }

  private renderDiffPane(pane: HTMLElement, path: string): void {
    pane.empty();
    if (!this.changesData) return;
    const t = L().pr;
    const file = this.changesData.files.find((f) => f.path === path);
    if (!file) return;

    if (file.hunks.length === 0) {
      pane.createDiv({ cls: "ghs-pr-diff-empty", text: t.diffEmpty });
      return;
    }

    for (const hunk of file.hunks) {
      const h = pane.createDiv("ghs-pr-diff-hunk");
      h.createDiv({ cls: "ghs-pr-diff-hunk-header", text: hunk.header });
      const body = h.createDiv("ghs-pr-diff-hunk-body");
      for (const line of hunk.lines) {
        const lineEl = body.createDiv(`ghs-pr-diff-line ghs-pr-diff-line--${line.kind}`);
        lineEl.createSpan({
          cls: "ghs-pr-diff-marker",
          text: line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ",
        });
        lineEl.createSpan({ cls: "ghs-pr-diff-text", text: line.text });
      }
    }
    if (file.truncated) {
      pane.createDiv({
        cls: "ghs-pr-diff-truncated",
        text: `… ${t.diffTruncated}`,
      });
    }
  }

  // ── Submit ─────────────────────────────────────────────────

  private async submit(): Promise<void> {
    const t = L().pr;
    if (this.empty) return; // defense in depth — button is also disabled
    const title = (this.titleInput?.value ?? "").trim();
    const body = (this.bodyInput?.value ?? "").trim();

    if (!title) {
      this.showStatus(t.titleRequired, "error");
      return;
    }

    this.setBusy(true);
    this.showStatus(t.pushing, "loading");

    const result = await this.opts.submit(title, body);

    if (result.ok && result.url) {
      this.renderSuccess(result.url, t.successNotice);
      return;
    }
    if (result.existingUrl) {
      this.renderSuccess(result.existingUrl, t.existsNotice);
      return;
    }

    this.setBusy(false);
    this.showStatus(tf(t.failedNotice, result.reason ?? ""), "error");
  }

  // ── Success view ───────────────────────────────────────────

  private renderSuccess(url: string, headline: string): void {
    const t = L().pr;
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.removeClass("ghs-create-pr-modal--wide");

    const header = contentEl.createDiv("ghs-pr-success-header");
    const icon = header.createSpan({ cls: "ghs-pr-success-icon" });
    setIcon(icon, "check");
    header.createEl("h3", { text: headline, cls: "ghs-pr-success-title" });

    const body = contentEl.createDiv("ghs-pr-body");
    const linkField = body.createDiv("ghs-pr-field");
    linkField.createSpan({ text: t.linkLabel, cls: "ghs-pr-float-label" });

    const linkRow = linkField.createDiv("ghs-pr-link-row");
    const linkInput = linkRow.createEl("input", {
      attr: { type: "text", readonly: "true", spellcheck: "false" },
      cls: "ghs-pr-link-input",
    });
    linkInput.value = url;
    linkInput.onclick = () => linkInput.select();

    const copyBtn = linkRow.createEl("button", {
      cls: "ghs-pr-link-action",
      attr: { title: t.copy, "aria-label": t.copy },
    });
    setIcon(copyBtn, "copy");
    copyBtn.onclick = () => void this.copyToClipboard(url, copyBtn);

    const openBtn = linkRow.createEl("button", {
      cls: "ghs-pr-link-action",
      attr: { title: t.openInBrowser, "aria-label": t.openInBrowser },
    });
    setIcon(openBtn, "external-link");
    openBtn.onclick = () => window.open(url, "_blank");

    const footer = contentEl.createDiv("ghs-pr-footer");
    const closeBtn = footer.createEl("button", {
      text: L().common.close,
      cls: "mod-cta ghs-pr-submit-btn",
    });
    closeBtn.onclick = () => this.close();

    window.setTimeout(() => {
      linkInput.focus();
      linkInput.select();
    }, 0);
  }

  private async copyToClipboard(text: string, btn: HTMLElement): Promise<void> {
    const t = L().pr;
    try {
      await navigator.clipboard.writeText(text);
      new Notice(t.copied);
      setIcon(btn, "check");
      window.setTimeout(() => setIcon(btn, "copy"), 1500);
    } catch {
      new Notice(t.copyFailed);
    }
  }

  // ── Utilities ──────────────────────────────────────────────

  private setBusy(busy: boolean): void {
    if (!this.submitBtn) return;
    if (busy) this.submitBtn.setAttribute("disabled", "true");
    else this.submitBtn.removeAttribute("disabled");
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
