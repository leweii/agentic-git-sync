import { setIcon } from "obsidian";
import type { SyncPhase } from "../types";

export class StatusBar {
  readonly el: HTMLElement;
  private iconEl: HTMLElement;
  private textEl: HTMLElement;
  private badgeEl: HTMLElement;

  private phase: SyncPhase = "idle";
  private lastSyncedAt: number | null = null;
  private pendingChanges = 0;
  private errorMsg: string | null = null;
  private tickHandle: number | null = null;

  constructor(statusBarEl: HTMLElement) {
    this.el = statusBarEl;
    this.el.addClass("github-sync-status");
    this.el.empty();
    this.iconEl = this.el.createSpan({ cls: "ghs-sb-icon" });
    this.textEl = this.el.createSpan({ cls: "ghs-sb-text" });
    this.badgeEl = this.el.createSpan({ cls: "ghs-sb-badge" });
    this.badgeEl.addClass("ghs-hidden");
    this.render();

    // Refresh "Xm ago" label every 30s.
    this.tickHandle = window.setInterval(() => this.render(), 30_000);
  }

  destroy(): void {
    if (this.tickHandle) window.clearInterval(this.tickHandle);
  }

  setPhase(phase: SyncPhase, message?: string): void {
    this.phase = phase;
    if (phase === "synced") {
      this.lastSyncedAt = Date.now();
      this.errorMsg = null;
    }
    if (phase === "error" || phase === "conflict") {
      this.errorMsg = message ?? null;
    }
    this.render();
  }

  setPendingChanges(count: number): void {
    this.pendingChanges = count;
    this.render();
  }

  private render(): void {
    this.el.removeClass("ghs-syncing", "ghs-error", "ghs-conflict", "ghs-synced", "ghs-idle");

    let icon = "github";
    let text = "GitHub";
    let title = "Open Sync Dashboard";
    let cls = "ghs-idle";

    switch (this.phase) {
      case "checking":
      case "pulling":
      case "committing":
      case "pushing":
        icon = "refresh-cw";
        text = labelForPhase(this.phase);
        title = "Sync in progress";
        cls = "ghs-syncing";
        break;
      case "synced":
        icon = "check";
        text = this.lastSyncedAt ? timeAgo(this.lastSyncedAt) : "Synced";
        title = this.lastSyncedAt
          ? `Last synced: ${new Date(this.lastSyncedAt).toLocaleString()}`
          : "Synced";
        cls = "ghs-synced";
        break;
      case "error":
        icon = "alert-circle";
        text = "Sync failed";
        title = `Error: ${this.errorMsg ?? "unknown"}`;
        cls = "ghs-error";
        break;
      case "conflict":
        icon = "git-merge";
        text = "Conflict";
        title = `Merge conflict: ${this.errorMsg ?? "open dashboard to resolve"}`;
        cls = "ghs-conflict";
        break;
      default:
        icon = "github";
        text = this.lastSyncedAt ? timeAgo(this.lastSyncedAt) : "GitHub";
        title = "Open Sync Dashboard";
    }

    this.el.addClass(cls);
    this.el.title = title;
    this.iconEl.empty();
    setIcon(this.iconEl, icon);
    this.textEl.setText(text);

    if (this.pendingChanges > 0 && (this.phase === "idle" || this.phase === "synced")) {
      this.badgeEl.removeClass("ghs-hidden");
      this.badgeEl.setText(`${this.pendingChanges}`);
      this.badgeEl.title = `${this.pendingChanges} pending change(s)`;
    } else {
      this.badgeEl.addClass("ghs-hidden");
    }
  }
}

function labelForPhase(p: SyncPhase): string {
  switch (p) {
    case "checking": return "Checking…";
    case "pulling": return "Pulling…";
    case "committing": return "Committing…";
    case "pushing": return "Pushing…";
    default: return "Syncing…";
  }
}

export function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
