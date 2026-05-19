import { App, Modal, Notice, setIcon } from "obsidian";
import type { PendingChanges } from "../types";
import type { GitManager } from "../git/GitManager";

export class LocalChangesModal extends Modal {
  private selected = new Set<string>();
  private untrackedSet = new Set<string>();

  constructor(
    app: App,
    private changes: PendingChanges,
    private gitManager: GitManager
  ) {
    super(app);
    // All files selected by default
    for (const f of [...changes.modified, ...changes.deleted, ...changes.added]) {
      this.selected.add(f);
    }
    for (const f of changes.added) {
      this.untrackedSet.add(f);
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-lc-modal");

    // ── Header ──────────────────────────────────────────────────
    const header = contentEl.createDiv("ghs-lc-header");
    const titleRow = header.createDiv("ghs-lc-title-row");
    const iconWrap = titleRow.createSpan("ghs-lc-title-icon");
    setIcon(iconWrap, "rotate-ccw");
    titleRow.createEl("h3", { text: "Revert local changes" });
    const total = this.changes.modified.length + this.changes.deleted.length + this.changes.added.length;
    header.createEl("p", {
      cls: "ghs-lc-subtitle",
      text: `${total} uncommitted file${total !== 1 ? "s" : ""}`,
    });

    // ── Select-all toolbar ───────────────────────────────────────
    const toolbar = contentEl.createDiv("ghs-lc-toolbar");
    const allBtn = toolbar.createEl("button", { text: "Select all", cls: "ghs-lc-sel-btn" });
    const noneBtn = toolbar.createEl("button", { text: "Deselect all", cls: "ghs-lc-sel-btn" });

    // ── File list ────────────────────────────────────────────────
    const list = contentEl.createDiv("ghs-lc-list");
    const rows: { file: string; checkbox: HTMLInputElement }[] = [];

    const addGroup = (title: string, files: string[], icon: string, cls: string) => {
      if (files.length === 0) return;
      const group = list.createDiv("ghs-lc-group");
      const groupHeader = group.createDiv("ghs-lc-group-header");
      groupHeader.createSpan({ text: `${title}`, cls: "ghs-lc-group-title" });
      groupHeader.createSpan({ text: `${files.length}`, cls: "ghs-lc-group-count" });

      for (const f of files) {
        const row = group.createDiv("ghs-lc-row");
        const cb = row.createEl("input", { attr: { type: "checkbox" } });
        cb.checked = this.selected.has(f);
        cb.onchange = () => {
          if (cb.checked) this.selected.add(f);
          else this.selected.delete(f);
        };
        rows.push({ file: f, checkbox: cb });

        const fileIcon = row.createSpan({ cls: `ghs-lc-file-icon ${cls}` });
        setIcon(fileIcon, icon);

        const pathEl = row.createSpan({ cls: "ghs-lc-file-path" });
        const parts = f.split("/");
        if (parts.length > 1) {
          pathEl.createSpan({ cls: "ghs-lc-dir", text: parts.slice(0, -1).join("/") + "/" });
        }
        pathEl.createSpan({ cls: "ghs-lc-filename", text: parts[parts.length - 1] });

        row.onclick = (e) => {
          if ((e.target as HTMLElement).tagName === "INPUT") return;
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change"));
        };
      }
    };

    addGroup("Modified", this.changes.modified, "edit-3", "modified");
    addGroup("Untracked", this.changes.added, "plus-circle", "added");
    addGroup("Deleted", this.changes.deleted, "minus-circle", "deleted");

    allBtn.onclick = () => {
      for (const { file, checkbox } of rows) {
        this.selected.add(file);
        checkbox.checked = true;
      }
    };
    noneBtn.onclick = () => {
      for (const { file, checkbox } of rows) {
        this.selected.delete(file);
        checkbox.checked = false;
      }
    };

    // ── Footer ───────────────────────────────────────────────────
    const footer = contentEl.createDiv("ghs-lc-footer");
    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.onclick = () => this.close();

    const revertBtn = footer.createEl("button", { text: "Revert selected", cls: "ghs-lc-revert-btn" });
    revertBtn.onclick = () => this.doRevert(revertBtn);
  }

  private async doRevert(btn: HTMLButtonElement): Promise<void> {
    if (this.selected.size === 0) {
      new Notice("No files selected.");
      return;
    }

    btn.disabled = true;
    btn.setText("Reverting…");

    const tracked: string[] = [];
    const untracked: string[] = [];

    for (const f of this.selected) {
      if (this.untrackedSet.has(f)) untracked.push(f);
      else tracked.push(f);
    }

    try {
      await this.gitManager.revertFiles(tracked, untracked);
      new Notice(`Reverted ${this.selected.size} file${this.selected.size !== 1 ? "s" : ""}.`);
      this.close();
    } catch (e) {
      new Notice(`Revert failed: ${(e as Error).message}`, 8000);
      btn.disabled = false;
      btn.setText("Revert selected");
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
