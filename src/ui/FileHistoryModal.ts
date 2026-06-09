import { App, Modal, setIcon } from "obsidian";
import type { FileCommit, GitManager } from "../git/GitManager";
import { L } from "../i18n";

function fhFormatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60_000);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dateStr = date.getFullYear() === now.getFullYear()
    ? `${MONTHS[date.getMonth()]} ${date.getDate()}`
    : `${MONTHS[date.getMonth()]} '${String(date.getFullYear()).slice(2)}`;
  if (mins < 1) return `${dateStr} · just now`;
  if (mins < 60) return `${dateStr} · ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return `${dateStr} · ${hrs}h ${remMins}m ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${dateStr} · ${days}d ago`;
  const mos = Math.floor(days / 30);
  if (mos < 12) return `${dateStr} · ${mos}mo ago`;
  return `${dateStr} · ${Math.floor(mos / 12)}y ago`;
}

function fhParseStats(diffText: string): { adds: number; dels: number } {
  let adds = 0, dels = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) adds++;
    else if (line.startsWith("-") && !line.startsWith("---")) dels++;
  }
  return { adds, dels };
}

function fhRenderDiff(container: HTMLElement, diffText: string): void {
  container.empty();
  if (!diffText.trim()) {
    container.createEl("p", { cls: "ghs-fh-diff-empty", text: "No changes." });
    return;
  }
  const table = container.createEl("div", { cls: "ghs-fh-diff-table" });
  let oldLine = 0, newLine = 0;
  for (const line of diffText.split("\n")) {
    // Parse @@ hunk header for line numbers but skip rendering it
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLine = parseInt(m[1]) - 1; newLine = parseInt(m[2]) - 1; }
      continue;
    }
    // Skip git diff header lines
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }

    const row = table.createEl("div", { cls: "ghs-fh-diff-line" });
    const oldNumEl = row.createEl("span", { cls: "ghs-fh-diff-lno" });
    const newNumEl = row.createEl("span", { cls: "ghs-fh-diff-lno" });
    const textEl = row.createEl("span", { cls: "ghs-fh-diff-text" });
    textEl.textContent = line;
    if (line.startsWith("+")) {
      row.addClass("ghs-fh-diff-add");
      newLine++;
      newNumEl.textContent = String(newLine);
    } else if (line.startsWith("-")) {
      row.addClass("ghs-fh-diff-del");
      oldLine++;
      oldNumEl.textContent = String(oldLine);
    } else {
      oldLine++;
      newLine++;
      oldNumEl.textContent = String(oldLine);
      newNumEl.textContent = String(newLine);
    }
  }
}

export class FileHistoryModal extends Modal {
  private anchorIdx: number | null;
  private rangeEndIdx: number | null;
  private listEl!: HTMLElement;
  private diffPaneEl!: HTMLElement;
  private diffInfoEl!: HTMLElement;
  private diffStatsEl!: HTMLElement;
  private diffContentEl!: HTMLElement;

  /**
   * commits are passed in pre-loaded (from the panel) so the modal opens
   * instantly. initialAnchorIdx / initialRangeEndIdx carry over the panel's
   * current selection.
   */
  constructor(
    app: App,
    private gitManager: GitManager,
    private repoRelativePath: string,
    private displayPath: string,
    private commits: FileCommit[],
    initialAnchorIdx: number | null = null,
    initialRangeEndIdx: number | null = null,
  ) {
    super(app);
    this.anchorIdx = initialAnchorIdx;
    this.rangeEndIdx = initialRangeEndIdx;
  }

  onOpen(): void {
    this.modalEl.addClass("ghs-fh-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-fh-content");

    const t = L().fileHistory;

    // ── Header ──────────────────────────────────────────────────────
    const header = contentEl.createDiv("ghs-fh-header");
    const titleRow = header.createDiv("ghs-fh-title-row");
    const iconWrap = titleRow.createSpan("ghs-fh-title-icon");
    setIcon(iconWrap, "history");
    titleRow.createEl("h3", { text: t.title });

    const parts = this.displayPath.split("/");
    const subtitle = header.createDiv("ghs-fh-subtitle");
    if (parts.length > 1) {
      subtitle.createSpan({ cls: "ghs-fh-subtitle-dir", text: parts.slice(0, -1).join("/") + "/" });
    }
    subtitle.createSpan({ cls: "ghs-fh-subtitle-name", text: parts[parts.length - 1] });

    const hint = header.createDiv("ghs-fh-hint");
    hint.textContent = "Click · Shift+click for range · ↑↓ navigate · Shift+↑↓ extend range";

    // ── Body: horizontal split ───────────────────────────────────────
    const body = contentEl.createDiv("ghs-fh-body");

    this.listEl = body.createDiv("ghs-fh-list");

    this.diffPaneEl = body.createDiv("ghs-fh-diff-pane");
    this.diffInfoEl = this.diffPaneEl.createDiv("ghs-fh-diff-info-bar");
    this.diffStatsEl = this.diffPaneEl.createDiv("ghs-fh-diff-stats");
    this.diffContentEl = this.diffPaneEl.createDiv("ghs-fh-diff-content");

    // ── Footer ───────────────────────────────────────────────────────
    const footer = contentEl.createDiv("ghs-fh-footer");
    footer.createEl("button", { text: L().common.close }).onclick = () => this.close();

    // ── Keyboard navigation ──────────────────────────────────────────
    this.scope.register([], "ArrowDown", () => {
      const next = (this.anchorIdx ?? -1) + 1;
      if (next < this.commits.length) {
        this.anchorIdx = next;
        this.rangeEndIdx = null;
        this.renderList();
        this.scrollIdxIntoView(next);
        void this.updateDiff();
      }
      return false;
    });
    this.scope.register([], "ArrowUp", () => {
      const prev = (this.anchorIdx ?? this.commits.length) - 1;
      if (prev >= 0) {
        this.anchorIdx = prev;
        this.rangeEndIdx = null;
        this.renderList();
        this.scrollIdxIntoView(prev);
        void this.updateDiff();
      }
      return false;
    });
    this.scope.register(["Shift"], "ArrowDown", () => {
      if (this.anchorIdx === null) return false;
      const end = (this.rangeEndIdx ?? this.anchorIdx) + 1;
      if (end < this.commits.length) {
        this.rangeEndIdx = end;
        this.renderList();
        this.scrollIdxIntoView(end);
        void this.updateDiff();
      }
      return false;
    });
    this.scope.register(["Shift"], "ArrowUp", () => {
      if (this.anchorIdx === null) return false;
      const end = (this.rangeEndIdx ?? this.anchorIdx) - 1;
      if (end >= 0) {
        this.rangeEndIdx = end;
        this.renderList();
        this.scrollIdxIntoView(end);
        void this.updateDiff();
      }
      return false;
    });

    this.renderList();
    void this.updateDiff();
  }

  private scrollIdxIntoView(idx: number): void {
    const rows = this.listEl.querySelectorAll(".ghs-fh-row");
    const el = rows[idx] as HTMLElement | undefined;
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  private selectedRange(): [number, number] | null {
    if (this.anchorIdx === null) return null;
    const end = this.rangeEndIdx ?? this.anchorIdx;
    return [Math.min(this.anchorIdx, end), Math.max(this.anchorIdx, end)];
  }

  private renderList(): void {
    this.listEl.empty();
    if (this.commits.length === 0) {
      this.listEl.createEl("p", { cls: "ghs-fh-empty", text: L().fileHistory.empty });
      return;
    }
    const range = this.selectedRange();
    for (let i = 0; i < this.commits.length; i++) {
      const selected = range !== null && i >= range[0] && i <= range[1];
      this.renderRow(i, this.commits[i], selected);
    }
  }

  private renderRow(idx: number, commit: FileCommit, selected: boolean): void {
    const row = this.listEl.createDiv("ghs-fh-row");
    if (selected) row.addClass("is-selected");

    const originIcon = row.createSpan({ cls: "ghs-fh-origin-icon" });
    originIcon.setAttribute("aria-label", commit.isLocal ? "Local commit" : "Pulled from remote");
    setIcon(originIcon, commit.isLocal ? "upload" : "download");
    originIcon.addClass(commit.isLocal ? "is-local" : "is-remote");

    row.createSpan({ cls: "ghs-fh-message", text: commit.message });
    row.createSpan({ cls: "ghs-fh-hash", text: commit.hash.slice(0, 7) });
    row.createSpan({ cls: "ghs-fh-date", text: fhFormatDate(commit.date) });

    row.addEventListener("click", (e: MouseEvent) => {
      if (e.shiftKey && this.anchorIdx !== null) {
        this.rangeEndIdx = idx;
      } else {
        const range = this.selectedRange();
        const isSingleSame = range !== null && range[0] === range[1] && range[0] === idx;
        if (isSingleSame) {
          this.anchorIdx = null;
          this.rangeEndIdx = null;
        } else {
          this.anchorIdx = idx;
          this.rangeEndIdx = null;
        }
      }
      this.renderList();
      void this.updateDiff();
    });
  }

  private async updateDiff(): Promise<void> {
    const range = this.selectedRange();
    this.diffInfoEl.empty();
    this.diffStatsEl.empty();
    this.diffStatsEl.removeClass("has-stats");

    if (range === null) {
      this.diffContentEl.empty();
      this.diffContentEl.createEl("p", { cls: "ghs-fh-diff-placeholder", text: "← Select a commit to view changes" });
      return;
    }

    this.diffContentEl.empty();
    this.diffContentEl.createEl("p", { cls: "ghs-fh-loading", text: L().fileHistory.loading });

    const [minIdx, maxIdx] = range;
    const newest = this.commits[minIdx]; // smaller idx = newer
    const oldest = this.commits[maxIdx]; // larger idx = older
    const isSingle = minIdx === maxIdx;
    const count = maxIdx - minIdx + 1;

    // Info bar
    if (isSingle) {
      this.diffInfoEl.createSpan({ cls: "ghs-fh-diff-hash", text: newest.hash.slice(0, 7) });
      this.diffInfoEl.createSpan({ cls: "ghs-fh-diff-msg", text: newest.message });
      this.diffInfoEl.createSpan({ cls: "ghs-fh-diff-author", text: `${newest.authorName} · ${newest.date.toLocaleDateString()}` });
      const copyBtn = this.diffInfoEl.createEl("button", { cls: "ghs-fh-copy-btn", text: L().fileHistory.copyHash });
      copyBtn.onclick = () => {
        void navigator.clipboard.writeText(newest.hash).then(() => {
          copyBtn.textContent = "✓";
          window.setTimeout(() => { copyBtn.textContent = L().fileHistory.copyHash; }, 1500);
        });
      };
    } else {
      this.diffInfoEl.createSpan({ cls: "ghs-fh-diff-hash", text: `${oldest.hash.slice(0, 7)} → ${newest.hash.slice(0, 7)}` });
      this.diffInfoEl.createSpan({ cls: "ghs-fh-diff-msg", text: `${count} commits combined` });
    }

    try {
      const diff = isSingle
        ? await this.gitManager.getFileDiffAtCommit(this.repoRelativePath, newest.hash)
        : await this.gitManager.getFileRangeDiff(this.repoRelativePath, oldest.hash, newest.hash);

      const { adds, dels } = fhParseStats(diff);
      const hasStats = adds > 0 || dels > 0;
      this.diffStatsEl.toggleClass("has-stats", hasStats);
      if (hasStats) {
        this.diffStatsEl.createSpan({ cls: "ghs-fh-stat-add", text: `+${adds}` });
        this.diffStatsEl.createSpan({ cls: "ghs-fh-stat-del", text: `−${dels}` });
      }

      fhRenderDiff(this.diffContentEl, diff);
    } catch (e) {
      this.diffContentEl.empty();
      this.diffContentEl.createEl("p", {
        cls: "ghs-fh-error",
        text: L().fileHistory.errorLoading.replace("{0}", (e as Error).message),
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
