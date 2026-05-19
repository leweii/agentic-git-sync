import { App, Modal, Notice, setIcon } from "obsidian";
import type { ConflictRepoOps } from "../sync/ConflictRepoOps";
import type { AIClient, AISuggestResult } from "../ai/AIClient";
import type { AISuggestion } from "../ai/AIProvider";
import {
  parseConflict,
  applyResolutions,
  extractHunks,
  isFullyResolved,
  getContextLines,
  type ConflictHunk,
  type ConflictSegment,
  type HunkResolution,
} from "../sync/ConflictParser";

type AIHunkState =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "result"; suggestion: AISuggestion; providerName: string }
  | { kind: "error"; message: string };

interface FileState {
  path: string;
  segments: ConflictSegment[];
  hunks: ConflictHunk[];
  resolutions: Map<string, HunkResolution>;
  aiByHunk: Map<string, AIHunkState>;
  persisted: boolean;
}

export class ConflictModal extends Modal {
  private files: FileState[] = [];
  private currentFile = 0;
  private currentHunk = 0;
  private editMode = false;
  private editText = "";
  private repoLabel: string;
  private aiClient: AIClient | null;

  constructor(
    app: App,
    private ops: ConflictRepoOps,
    private conflictPaths: string[],
    private onResolved: () => void,
    repoLabel = "Main Vault",
    aiClient: AIClient | null = null
  ) {
    super(app);
    this.repoLabel = repoLabel;
    this.aiClient = aiClient;
    this.modalEl.addClass("ghs-cv2-modal");
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({ cls: "ghs-cv2-loading", text: "Loading conflicts…" });
    await this.loadFiles();
    this.render();
    this.maybeTriggerAI();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  // ── Loading ───────────────────────────────────────────────

  private async loadFiles(): Promise<void> {
    this.files = [];
    for (const path of this.conflictPaths) {
      try {
        const content = await this.ops.readFile(path);
        const segments = parseConflict(content);
        const hunks = extractHunks(segments);
        if (hunks.length === 0) continue;
        this.files.push({
          path,
          segments,
          hunks,
          resolutions: new Map(),
          aiByHunk: new Map(),
          persisted: false,
        });
      } catch (e) {
        new Notice(`Couldn't load ${path}: ${(e as Error).message}`);
      }
    }
  }

  // ── State helpers ─────────────────────────────────────────

  private file(): FileState { return this.files[this.currentFile]; }
  private hunk(): ConflictHunk { return this.file().hunks[this.currentHunk]; }

  private aiState(): AIHunkState {
    return this.file().aiByHunk.get(this.hunk().id) ?? { kind: "idle" };
  }

  private fileResolved(f: FileState): boolean {
    return isFullyResolved(f.segments, f.resolutions);
  }

  private allResolved(): boolean {
    return this.files.every((f) => this.fileResolved(f));
  }

  private fileStatus(f: FileState, idx: number): "current" | "clean" | "partial" | "unresolved" {
    if (idx === this.currentFile) return "current";
    const done = f.hunks.filter((h) => {
      const r = f.resolutions.get(h.id);
      return r && r.kind !== "skip";
    }).length;
    if (done === f.hunks.length) return "clean";
    if (done > 0) return "partial";
    return "unresolved";
  }

  private totalHunks(): number {
    return this.files.reduce((s, f) => s + f.hunks.length, 0);
  }

  private resolvedHunks(): number {
    return this.files.reduce((s, f) => {
      return s + f.hunks.filter((h) => {
        const r = f.resolutions.get(h.id);
        return r && r.kind !== "skip";
      }).length;
    }, 0);
  }

  // ── AI orchestration ──────────────────────────────────────

  private aiAvailable(): boolean {
    return !!this.aiClient && this.aiClient.isEnabled();
  }

  private aiAllowedForCurrentFile(): boolean {
    if (!this.aiClient) return false;
    return this.aiClient.isPathAllowed(this.file().path);
  }

  private maybeTriggerAI(): void {
    if (!this.aiAvailable() || !this.aiAllowedForCurrentFile()) return;
    if (this.files.length === 0) return;
    const file = this.file();
    const hunk = this.hunk();
    const existing = file.aiByHunk.get(hunk.id);
    if (existing && existing.kind !== "idle") return; // already thinking, done, or errored
    this.triggerAI(file, hunk);
  }

  private triggerAI(file: FileState, hunk: ConflictHunk): void {
    if (!this.aiClient) return;
    file.aiByHunk.set(hunk.id, { kind: "thinking" });
    const stillCurrent = () => this.files[this.currentFile] === file && this.hunk()?.id === hunk.id;
    if (stillCurrent()) this.render();

    const ctx = getContextLines(file.segments, hunk.id, 10);

    this.aiClient
      .suggest({
        filePath: file.path,
        hunk: { local: hunk.local, remote: hunk.remote },
        context: ctx,
      })
      .then((result: AISuggestResult) => {
        file.aiByHunk.set(hunk.id, {
          kind: "result",
          suggestion: result.suggestion,
          providerName: result.providerName,
        });
        if (stillCurrent()) this.render();
      })
      .catch((e: Error) => {
        file.aiByHunk.set(hunk.id, { kind: "error", message: e.message });
        if (stillCurrent()) this.render();
      });
  }

  private retryAI(): void {
    const file = this.file();
    const hunk = this.hunk();
    file.aiByHunk.delete(hunk.id);
    this.maybeTriggerAI();
  }

  // ── Render ────────────────────────────────────────────────

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    if (this.files.length === 0) {
      const empty = contentEl.createDiv("ghs-cv2-empty");
      empty.createEl("p", { text: "No conflicts to resolve." });
      const closeBtn = empty.createEl("button", { text: "Close", cls: "mod-cta" });
      closeBtn.onclick = () => this.close();
      return;
    }

    if (this.allResolved()) {
      this.renderSummary();
      return;
    }

    const root = contentEl.createDiv("ghs-cv2-root");
    this.renderHeader(root);
    const body = root.createDiv("ghs-cv2-body");
    this.renderFilesPane(body);
    this.renderMainPane(body);
    this.renderFooter(root);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv("ghs-cv2-header");
    const top = header.createDiv("ghs-cv2-header-top");
    const titleWrap = top.createDiv("ghs-cv2-title");
    if (!this.allResolved()) {
      titleWrap.createSpan({ cls: "ghs-cv2-title-prefix", text: "Conflicts /" });
      titleWrap.createSpan({ cls: "ghs-cv2-filename", text: this.file().path });
      if (this.editMode) {
        titleWrap.createSpan({ cls: "ghs-cv2-edit-badge", text: "EDITING" });
      }
    } else {
      titleWrap.createSpan({
        cls: "ghs-cv2-filename",
        text: `All files resolved · ${this.files.length}/${this.files.length}`,
      });
    }
    top.createDiv({ cls: "ghs-cv2-spacer" });

    const closeBtn = top.createEl("button", { cls: "ghs-cv2-icon-btn", attr: { title: "Close" } });
    setIcon(closeBtn, "x");
    closeBtn.onclick = () => this.close();

    const meta = header.createDiv("ghs-cv2-header-meta");
    meta.createSpan({ text: `Repo ${this.repoLabel}` });
    meta.createSpan({ cls: "ghs-cv2-dot", text: "·" });
    meta.createSpan({ text: this.allResolved() ? "merge ready" : "merge in progress" });
    if (this.aiAvailable() && !this.allResolved()) {
      meta.createSpan({ cls: "ghs-cv2-dot", text: "·" });
      const aiTag = meta.createSpan({ cls: "ghs-cv2-ai-tag" });
      const icon = aiTag.createSpan({ cls: "ghs-cv2-ai-tag-icon" });
      setIcon(icon, "sparkles");
      aiTag.createSpan({ text: this.aiAllowedForCurrentFile() ? "AI enabled" : "AI excluded for this path" });
    }
  }

  private renderFilesPane(parent: HTMLElement): void {
    const pane = parent.createDiv("ghs-cv2-files-pane");
    pane.createEl("h4", { text: `Files (${this.files.length})` });
    const list = pane.createDiv("ghs-cv2-file-list");
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i];
      const status = this.fileStatus(f, i);
      const row = list.createDiv(`ghs-cv2-file-row ${status}`);
      const badge = row.createSpan({ cls: `ghs-cv2-file-badge ${status}` });
      const sym = status === "clean" ? "✓" : status === "current" ? "●" : status === "partial" ? "◐" : "✗";
      badge.setText(sym);
      row.createSpan({ cls: "ghs-cv2-file-name", text: f.path });
      row.onclick = () => {
        if (this.editMode) {
          new Notice("Save or cancel edit first.");
          return;
        }
        this.currentFile = i;
        this.currentHunk = 0;
        this.render();
        this.maybeTriggerAI();
      };
    }

    const legend = pane.createDiv("ghs-cv2-legend");
    for (const [sym, label, cls] of [
      ["●", "current", "current"],
      ["✗", "unresolved", "unresolved"],
      ["◐", "partial", "partial"],
      ["✓", "resolved", "clean"],
    ] as const) {
      const row = legend.createDiv("ghs-cv2-legend-row");
      row.createSpan({ cls: `ghs-cv2-file-badge ${cls}`, text: sym });
      row.createSpan({ text: label });
    }
  }

  private renderMainPane(parent: HTMLElement): void {
    const main = parent.createDiv("ghs-cv2-main-pane");
    const ai = this.aiState();

    // Hunk nav
    const nav = main.createDiv("ghs-cv2-hunk-nav");
    nav.createEl("span", {
      cls: "ghs-cv2-hunk-label",
      text: `Hunk ${this.currentHunk + 1} of ${this.file().hunks.length}${this.editMode ? " — editing" : ""}`,
    });
    const navBtns = nav.createDiv("ghs-cv2-nav-btns");
    const prev = navBtns.createEl("button", { cls: "ghs-cv2-nav-btn", text: "Prev" });
    prev.disabled = this.currentHunk === 0 || this.editMode;
    prev.onclick = () => { this.currentHunk--; this.render(); this.maybeTriggerAI(); };
    const next = navBtns.createEl("button", { cls: "ghs-cv2-nav-btn", text: "Next" });
    next.disabled = this.currentHunk >= this.file().hunks.length - 1 || this.editMode;
    next.onclick = () => { this.currentHunk++; this.render(); this.maybeTriggerAI(); };

    // Confidence (only when AI result available)
    if (ai.kind === "result") {
      const conf = nav.createDiv("ghs-cv2-confidence");
      conf.createSpan({ cls: "ghs-cv2-conf-label", text: "AI confidence:" });
      const dots = conf.createDiv("ghs-cv2-conf-dots");
      for (let i = 0; i < 5; i++) {
        dots.createDiv({ cls: `ghs-cv2-conf-dot ${i < ai.suggestion.confidence ? "on" : ""}` });
      }
      conf.createSpan({ cls: "ghs-cv2-conf-text", text: confidenceLabel(ai.suggestion.confidence) });
      if (ai.suggestion.confidence <= 2) conf.addClass("low");
    } else {
      const resolutionTag = nav.createDiv("ghs-cv2-resolution-tag");
      const currentResolution = this.file().resolutions.get(this.hunk().id);
      if (currentResolution && currentResolution.kind !== "skip") {
        resolutionTag.addClass("resolved");
        resolutionTag.setText(`✓ ${resolutionLabel(currentResolution.kind)}`);
      } else if (currentResolution?.kind === "skip") {
        resolutionTag.addClass("skipped");
        resolutionTag.setText("○ skipped");
      } else {
        resolutionTag.setText("Unresolved");
      }
    }

    // Low-confidence banner (if AI result confidence ≤ 2)
    if (ai.kind === "result" && ai.suggestion.confidence <= 2) {
      const banner = main.createDiv("ghs-cv2-low-conf-banner");
      const icon = banner.createSpan({ cls: "ghs-cv2-banner-icon" });
      setIcon(icon, "alert-triangle");
      banner.createSpan({ cls: "ghs-cv2-banner-title", text: "AI uncertain on this hunk" });
      banner.createSpan({
        cls: "ghs-cv2-banner-body",
        text: " — please review the suggestion carefully before accepting.",
      });
    }

    // Three-pane diff
    const grid = main.createDiv("ghs-cv2-diff-grid");
    const dimSides = ai.kind === "result";
    this.renderDiffPane(grid, "Local", "local", this.hunk().local, dimSides);
    this.renderDiffPane(grid, "Remote", "remote", this.hunk().remote, dimSides);
    if (this.editMode) this.renderEditPane(grid);
    else this.renderAiPane(grid, ai);

    // Hunk actions
    const actions = main.createDiv("ghs-cv2-hunk-actions");
    if (this.editMode) {
      const cancelEdit = actions.createEl("button", { cls: "ghs-cv2-ghost-btn", text: "Cancel" });
      cancelEdit.onclick = () => { this.editMode = false; this.render(); };
      actions.createDiv({ cls: "ghs-cv2-spacer" });
      const save = actions.createEl("button", { cls: "ghs-cv2-action-btn primary", text: "Save edit" });
      save.onclick = () => this.commitEdit();
    } else {
      this.actionBtn(actions, "Take Local", () => this.applyHunk({ kind: "local" }));
      this.actionBtn(actions, "Take Remote", () => this.applyHunk({ kind: "remote" }));

      const takeAi = actions.createEl("button", { cls: "ghs-cv2-action-btn primary", text: "Take AI" });
      if (ai.kind === "result") {
        const star = takeAi.createSpan({ cls: "ghs-cv2-star-glyph", text: "★" });
        void star;
        takeAi.onclick = () => this.applyHunk({ kind: "edit", text: ai.suggestion.merged.join("\n") });
      } else if (ai.kind === "thinking") {
        takeAi.disabled = true;
        takeAi.title = "AI is generating a suggestion…";
      } else if (ai.kind === "error") {
        takeAi.disabled = true;
        takeAi.title = "AI failed — retry or resolve manually";
      } else {
        takeAi.disabled = true;
        takeAi.title = !this.aiAvailable()
          ? "Configure an AI provider in Settings → AI"
          : "AI excluded for this path";
      }

      this.actionBtn(actions, "Edit manually", () => this.enterEditMode());
      this.actionBtn(actions, "Skip hunk", () => this.applyHunk({ kind: "skip" }), "ghs-cv2-ghost-btn");
    }

    // Reasoning panel
    this.renderReasoning(main, ai);
  }

  private renderDiffPane(parent: HTMLElement, title: string, kind: "local" | "remote", lines: string[], dim: boolean): void {
    const pane = parent.createDiv(`ghs-cv2-pane ${kind}${dim ? " dim" : ""}`);
    const header = pane.createDiv("ghs-cv2-pane-header");
    header.createSpan({ cls: "ghs-cv2-pane-title", text: title });
    const body = pane.createDiv("ghs-cv2-pane-body");
    if (lines.length === 0) {
      body.createDiv({ cls: "ghs-cv2-pane-placeholder", text: "(empty — this side has no content)" });
      return;
    }
    for (let i = 0; i < lines.length; i++) {
      const row = body.createDiv(`ghs-cv2-line ${kind === "local" ? "del" : "add"}`);
      row.createSpan({ cls: "ghs-cv2-lineno", text: String(i + 1) });
      row.createSpan({ cls: "ghs-cv2-marker", text: kind === "local" ? "-" : "+" });
      row.createSpan({ cls: "ghs-cv2-code", text: lines[i] });
    }
  }

  private renderAiPane(parent: HTMLElement, state: AIHunkState): void {
    const pane = parent.createDiv("ghs-cv2-pane ai");
    const header = pane.createDiv("ghs-cv2-pane-header");
    const icon = header.createSpan({ cls: "ghs-cv2-pane-icon" });
    setIcon(icon, "sparkles");
    header.createSpan({ cls: "ghs-cv2-pane-title", text: "AI Suggestion" });

    if (state.kind === "result") {
      header.createSpan({ cls: "ghs-cv2-pane-meta", text: state.providerName });
      const body = pane.createDiv("ghs-cv2-pane-body");
      const picks = new Set(state.suggestion.picks);
      for (let i = 0; i < state.suggestion.merged.length; i++) {
        const isPick = picks.has(i);
        const row = body.createDiv(`ghs-cv2-line${isPick ? " ai-pick" : ""}`);
        row.createSpan({ cls: "ghs-cv2-lineno", text: String(i + 1) });
        row.createSpan({ cls: "ghs-cv2-marker", text: isPick ? "+" : " " });
        const codeCell = row.createSpan({ cls: "ghs-cv2-code" });
        codeCell.setText(state.suggestion.merged[i]);
        if (isPick) codeCell.createSpan({ cls: "ghs-cv2-star", text: " ★" });
      }
      return;
    }

    if (state.kind === "thinking") {
      header.createSpan({ cls: "ghs-cv2-pane-meta", text: "thinking…" });
      const body = pane.createDiv("ghs-cv2-pane-body ghs-cv2-ai-thinking");
      const overlay = body.createDiv("ghs-cv2-thinking-overlay");
      overlay.createDiv("ghs-cv2-spinner");
      overlay.createDiv({ cls: "ghs-cv2-thinking-text", text: "Generating merge…" });
      // Skeleton lines underneath for visual stability
      for (let i = 0; i < 4; i++) {
        const line = body.createDiv("ghs-cv2-skeleton-line");
        line.createSpan({ cls: "ghs-cv2-lineno", text: String(i + 1) });
        const bar = line.createDiv("ghs-cv2-skeleton-bar");
        bar.style.width = `${[42, 78, 64, 30][i] ?? 50}%`;
      }
      return;
    }

    if (state.kind === "error") {
      header.addClass("error");
      header.createSpan({ cls: "ghs-cv2-pane-meta error-meta", text: "failed" });
      const body = pane.createDiv("ghs-cv2-pane-body");
      const card = body.createDiv("ghs-cv2-error-card");
      const cardHeader = card.createDiv("ghs-cv2-error-card-header");
      const cardIcon = cardHeader.createSpan({ cls: "ghs-cv2-error-icon" });
      setIcon(cardIcon, "alert-circle");
      cardHeader.createSpan({ text: "AI Suggestion failed" });
      card.createDiv({ cls: "ghs-cv2-error-card-body", text: truncate(state.message, 280) });

      const actions = card.createDiv("ghs-cv2-error-card-actions");
      const retry = actions.createEl("button", { cls: "ghs-cv2-action-btn", text: "Retry" });
      retry.onclick = () => this.retryAI();
      const fallback = actions.createEl("button", { cls: "ghs-cv2-action-btn", text: "Resolve manually" });
      fallback.onclick = () => this.enterEditMode();
      return;
    }

    // idle / disabled
    header.createSpan({ cls: "ghs-cv2-pane-meta", text: "not configured" });
    const body = pane.createDiv("ghs-cv2-pane-body ghs-cv2-ai-empty");
    const emptyIcon = body.createDiv("ghs-cv2-ai-empty-icon");
    setIcon(emptyIcon, "sparkles");
    body.createDiv({
      cls: "ghs-cv2-ai-empty-text",
      text: !this.aiAvailable()
        ? "Configure a provider in Settings → AI to enable automatic merge suggestions."
        : "AI is excluded for this file by your privacy settings.",
    });
  }

  private renderEditPane(parent: HTMLElement): void {
    const pane = parent.createDiv("ghs-cv2-pane edit");
    const header = pane.createDiv("ghs-cv2-pane-header");
    const icon = header.createSpan({ cls: "ghs-cv2-pane-icon" });
    setIcon(icon, "pencil");
    header.createSpan({ cls: "ghs-cv2-pane-title", text: "Manual edit" });
    header.createSpan({ cls: "ghs-cv2-pane-meta unsaved", text: "● unsaved" });

    const ta = pane.createEl("textarea", { cls: "ghs-cv2-edit-textarea" });
    ta.spellcheck = false;
    ta.value = this.editText;
    ta.oninput = () => { this.editText = ta.value; };
    window.setTimeout(() => ta.focus(), 0);
    ta.onkeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.editMode = false;
        this.render();
      }
    };

    const hint = pane.createDiv({ cls: "ghs-cv2-edit-hint" });
    // eslint-disable-next-line obsidianmd/ui/sentence-case -- "Enter" is a key name
    hint.createEl("kbd", { text: "⌘ Enter" });
    hint.appendText(" save · ");
    hint.createEl("kbd", { text: "Esc" });
    hint.appendText(" cancel");
  }

  private renderReasoning(parent: HTMLElement, state: AIHunkState): void {
    const reasoning = parent.createDiv("ghs-cv2-reasoning");
    const header = reasoning.createDiv("ghs-cv2-reasoning-header");
    const icon = header.createSpan({ cls: "ghs-cv2-reasoning-icon" });

    if (state.kind === "result") {
      setIcon(icon, "sparkles");
      header.createSpan({ text: "AI reasoning" });
      const list = reasoning.createEl("ul", { cls: "ghs-cv2-reasoning-list" });
      for (const r of state.suggestion.reasoning) {
        list.createEl("li", { text: r });
      }
      const info = reasoning.createDiv("ghs-cv2-model-info");
      info.createSpan({ text: `Model: ${state.suggestion.model}` });
      info.createSpan({
        text: `${state.suggestion.inputTokens} in / ${state.suggestion.outputTokens} out`,
      });
      const cost = state.suggestion.costUsd;
      info.createSpan({
        cls: "ghs-cv2-cost",
        text: cost > 0 ? `~$${cost.toFixed(4)}` : "free tier",
      });
      return;
    }

    if (state.kind === "thinking") {
      icon.appendChild(this.contentEl.createDiv("ghs-cv2-spinner-sm"));
      header.createSpan({ text: "AI is thinking…" });
      reasoning.createEl("p", {
        cls: "ghs-cv2-reasoning-body",
        text: "Streaming response from the configured provider — usually takes 2–4 seconds.",
      });
      return;
    }

    if (state.kind === "error") {
      header.addClass("error");
      setIcon(icon, "alert-circle");
      header.createSpan({ text: "Provider error" });
      reasoning.createEl("p", {
        cls: "ghs-cv2-reasoning-body",
        text: truncate(state.message, 280),
      });
      return;
    }

    // idle / not configured
    setIcon(icon, "sparkles");
    header.createSpan({ text: "AI Suggestion — not configured" });
    reasoning.createEl("p", {
      cls: "ghs-cv2-reasoning-body",
      text: !this.aiAvailable()
        ? "Add a provider in Settings → AI to see automatic merge suggestions and reasoning here."
        : "This file path is excluded from AI by your privacy settings. Pick Local / Remote or edit manually.",
    });
  }

  private renderFooter(root: HTMLElement): void {
    const footer = root.createDiv("ghs-cv2-footer");
    footer.createDiv({
      cls: "ghs-cv2-progress",
      text: `${this.resolvedHunks()}/${this.totalHunks()} hunks resolved · ${
        this.files.filter((f, i) => this.fileStatus(f, i) !== "clean").length
      } files remaining`,
    });
    footer.createDiv({ cls: "ghs-cv2-spacer" });

    const abort = footer.createEl("button", { cls: "ghs-cv2-ghost-btn", text: "Abort merge" });
    abort.onclick = () => this.abort();

    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();

    const next = footer.createEl("button", {
      cls: "mod-cta",
      text: this.lastUnresolvedFile() ? "Save & finish" : "Save & next file",
    });
    next.disabled = !this.fileResolved(this.file());
    next.onclick = () => this.saveAndAdvance();
  }

  private lastUnresolvedFile(): boolean {
    return this.files.filter((f, i) => i !== this.currentFile && !this.fileResolved(f)).length === 0;
  }

  // ── Summary state ─────────────────────────────────────────

  private renderSummary(): void {
    const root = this.contentEl.createDiv("ghs-cv2-root");
    this.renderHeader(root);

    const body = root.createDiv("ghs-cv2-body");
    this.renderFilesPane(body);

    const summary = body.createDiv("ghs-cv2-summary");
    const iconWrap = summary.createDiv("ghs-cv2-summary-icon");
    setIcon(iconWrap, "check");
    summary.createEl("h3", { text: "All conflicts resolved" });
    summary.createEl("p", {
      cls: "ghs-cv2-summary-subtitle",
      text: `${this.files.length} file(s) merged across ${this.totalHunks()} hunk(s). Click "Merge and push" to commit and sync.`,
    });

    const aiCount = this.countAIPicks();
    const stats = summary.createDiv("ghs-cv2-summary-stats");
    this.statCard(stats, String(this.totalHunks()), "hunks resolved", "green");
    this.statCard(stats, String(this.countByKind("local") + this.countByKind("remote")), "manual picks", "");
    this.statCard(stats, String(aiCount), "AI-assisted", "accent");
    this.statCard(stats, String(this.countByKind("edit") - aiCount), "edited", "");

    const totalCost = this.totalAICost();
    if (totalCost > 0) {
      summary.createEl("p", {
        cls: "ghs-cv2-cost-note",
        text: `AI cost this session: ~$${totalCost.toFixed(4)}`,
      });
    }

    const footer = root.createDiv("ghs-cv2-footer");
    footer.createDiv({ cls: "ghs-cv2-spacer" });
    const closeBtn = footer.createEl("button", { text: "Close" });
    closeBtn.onclick = () => this.close();
    const mergeBtn = footer.createEl("button", { cls: "mod-cta", text: "Merge and push" });
    mergeBtn.onclick = () => this.finish(mergeBtn);
  }

  private statCard(parent: HTMLElement, num: string, label: string, cls: string): void {
    const card = parent.createDiv("ghs-cv2-stat");
    card.createDiv({ cls: `ghs-cv2-stat-num ${cls}`, text: num });
    card.createDiv({ cls: "ghs-cv2-stat-label", text: label });
  }

  private countByKind(kind: HunkResolution["kind"]): number {
    let n = 0;
    for (const f of this.files) {
      for (const r of f.resolutions.values()) if (r.kind === kind) n++;
    }
    return n;
  }

  private countAIPicks(): number {
    // We tag the resolution as edit but with text matching AI suggestion.
    // Easier: count hunks where AI state is "result" AND resolution exists with kind=edit.
    let n = 0;
    for (const f of this.files) {
      for (const h of f.hunks) {
        const ai = f.aiByHunk.get(h.id);
        const r = f.resolutions.get(h.id);
        if (ai?.kind === "result" && r?.kind === "edit" && r.text === ai.suggestion.merged.join("\n")) {
          n++;
        }
      }
    }
    return n;
  }

  private totalAICost(): number {
    let total = 0;
    for (const f of this.files) {
      for (const state of f.aiByHunk.values()) {
        if (state.kind === "result") total += state.suggestion.costUsd;
      }
    }
    return total;
  }

  // ── Helpers ───────────────────────────────────────────────

  private actionBtn(parent: HTMLElement, label: string, onClick: () => void, extraCls?: string): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: `ghs-cv2-action-btn ${extraCls ?? ""}`.trim(),
      text: label,
    });
    btn.onclick = onClick;
    return btn;
  }

  // ── Actions ───────────────────────────────────────────────

  private applyHunk(r: HunkResolution): void {
    this.file().resolutions.set(this.hunk().id, r);
    if (this.currentHunk < this.file().hunks.length - 1) this.currentHunk++;
    this.render();
    this.maybeTriggerAI();
  }

  private enterEditMode(): void {
    const existing = this.file().resolutions.get(this.hunk().id);
    const ai = this.aiState();
    if (existing && existing.kind === "edit") {
      this.editText = existing.text;
    } else if (ai.kind === "result") {
      this.editText = ai.suggestion.merged.join("\n");
    } else {
      this.editText = this.hunk().local.join("\n");
    }
    this.editMode = true;
    this.render();
  }

  private commitEdit(): void {
    this.file().resolutions.set(this.hunk().id, { kind: "edit", text: this.editText });
    this.editMode = false;
    if (this.currentHunk < this.file().hunks.length - 1) this.currentHunk++;
    this.render();
    this.maybeTriggerAI();
  }

  private async saveAndAdvance(): Promise<void> {
    try {
      await this.persistFile(this.file());
    } catch {
      return;
    }
    const next = this.files.findIndex((f, i) => i !== this.currentFile && !this.fileResolved(f));
    if (next >= 0) {
      this.currentFile = next;
      this.currentHunk = 0;
    }
    this.render();
    this.maybeTriggerAI();
  }

  private async persistFile(f: FileState): Promise<void> {
    try {
      const content = applyResolutions(f.segments, f.resolutions);
      await this.ops.writeFile(f.path, content);
      await this.ops.stage(f.path);
      f.persisted = true;
    } catch (e) {
      new Notice(`Failed to save ${f.path}: ${(e as Error).message}`);
      throw e;
    }
  }

  private async finish(btn?: HTMLButtonElement): Promise<void> {
    if (btn) { btn.disabled = true; btn.textContent = "Pushing…"; }
    try {
      for (const f of this.files) if (!f.persisted) await this.persistFile(f);
      await this.ops.commitMergedAndPush(`merge: resolve conflict in ${this.files.map(f => f.path).join(", ")}`);
      new Notice(`Merged and pushed ${this.files.length} file(s).`);
      this.close();
      this.onResolved();
    } catch (e) {
      new Notice(`Push failed: ${(e as Error).message}`);
      if (btn) { btn.disabled = false; btn.textContent = "Merge and push"; }
    }
  }

  private async abort(): Promise<void> {
    await this.ops.abortMerge();
    new Notice("Merge aborted. Working tree restored.");
    this.close();
    this.onResolved();
  }
}

function resolutionLabel(kind: HunkResolution["kind"]): string {
  switch (kind) {
    case "local": return "Local";
    case "remote": return "Remote";
    case "both": return "Both";
    case "edit": return "Edited";
    case "skip": return "Skipped";
  }
}

function confidenceLabel(n: number): string {
  if (n <= 1) return "very low";
  if (n === 2) return "low";
  if (n === 3) return "medium";
  if (n === 4) return "high";
  return "very high";
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
