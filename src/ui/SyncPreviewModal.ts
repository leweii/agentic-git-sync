import { App, Modal, setIcon } from "obsidian";
import type { PendingChanges } from "../types";

export interface PreviewResult {
  message: string;
  excludedPaths: string[];
}

export class SyncPreviewModal extends Modal {
  private excluded = new Set<string>();
  private message = "";

  constructor(
    app: App,
    private repoLabel: string,
    private changes: PendingChanges,
    private onConfirm: (result: PreviewResult) => unknown
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-preview-modal");

    const header = contentEl.createDiv("ghs-preview-header");
    header.createEl("h3", { text: `Review changes — ${this.repoLabel}` });
    header.createEl("p", {
      text: `${this.changes.total} file(s) will be committed. Uncheck files you don't want to include.`,
    });

    const summary = contentEl.createDiv("ghs-preview-summary");
    this.summaryPill(summary, "plus-circle", `${this.changes.added.length} added`, "added");
    this.summaryPill(summary, "edit-3", `${this.changes.modified.length} modified`, "modified");
    this.summaryPill(summary, "minus-circle", `${this.changes.deleted.length} deleted`, "deleted");

    const list = contentEl.createDiv("ghs-preview-list");
    this.renderGroup(list, "Added", this.changes.added, "plus-circle", "added");
    this.renderGroup(list, "Modified", this.changes.modified, "edit-3", "modified");
    this.renderGroup(list, "Deleted", this.changes.deleted, "minus-circle", "deleted");

    const msgWrap = contentEl.createDiv("ghs-preview-message");
    msgWrap.createEl("label", { text: "Commit message (optional)" });
    const msgInput = msgWrap.createEl("input", {
      attr: { type: "text", placeholder: "sync: <timestamp>" },
    });
    msgInput.oninput = () => (this.message = msgInput.value.trim());

    const footer = contentEl.createDiv("ghs-preview-footer");
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
    const confirm = footer.createEl("button", { text: "Sync now", cls: "mod-cta" });
    confirm.onclick = () => {
      this.close();
      void this.onConfirm({ message: this.message, excludedPaths: Array.from(this.excluded) });
    };
  }

  private summaryPill(parent: HTMLElement, icon: string, text: string, cls: string): void {
    if (text.startsWith("0 ")) return;
    const pill = parent.createDiv({ cls: `ghs-preview-pill ${cls}` });
    const i = pill.createSpan();
    setIcon(i, icon);
    pill.createSpan({ text });
  }

  private renderGroup(parent: HTMLElement, title: string, files: string[], icon: string, kind: string): void {
    if (files.length === 0) return;
    const group = parent.createDiv("ghs-preview-group");
    group.createEl("h4", { text: `${title} (${files.length})` });
    for (const f of files) {
      const row = group.createDiv("ghs-preview-row");
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = true;
      checkbox.onchange = () => {
        if (checkbox.checked) this.excluded.delete(f);
        else this.excluded.add(f);
      };
      const iconWrap = row.createSpan({ cls: `ghs-preview-icon ${kind}` });
      setIcon(iconWrap, icon);
      row.createSpan({ cls: "ghs-preview-path", text: f });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
