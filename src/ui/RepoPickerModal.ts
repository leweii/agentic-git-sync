import { App, Modal, Notice, setIcon } from "obsidian";
import type GitHubSyncPlugin from "../main";
import { installUrl } from "../auth/constants";
import { listUserRepos } from "../git/githubApi";

/**
 * Pick a repository from what the connected GitHub App is granted, instead
 * of typing a URL by hand (DESIGN.md §9.7 / decision D9). Eliminates the
 * "typed a repo that doesn't exist" failure mode.
 *
 * Falls back gracefully:
 *   - not connected → prompt to Connect
 *   - repo missing  → links to install the app on the org / connect another
 *   - always closable so the caller's manual URL field still works
 */
export class RepoPickerModal extends Modal {
  constructor(
    app: App,
    private plugin: GitHubSyncPlugin,
    private onPick: (cloneUrl: string, fullName: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghs-add-modal");
    contentEl.createEl("h3", { text: "Choose a repository" });

    if (
      this.plugin.settings.authMethod !== "githubApp" ||
      (this.plugin.settings.githubApp?.connections ?? []).length === 0
    ) {
      contentEl.createEl("p", {
        cls: "ghs-add-sub",
        text: "Connect the GitHub App first to browse your repositories.",
      });
      const btn = contentEl.createEl("button", { cls: "mod-cta", text: "Connect with GitHub App" });
      btn.onclick = () => {
        void this.plugin.appAuth.beginConnect();
        this.close();
      };
      return;
    }

    const search = contentEl.createEl("input", {
      attr: { type: "text", placeholder: "Search repositories…" },
      cls: "ghs-repo-search",
    });
    search.style.width = "100%";
    search.style.marginBottom = "0.5rem";

    const listEl = contentEl.createDiv("ghs-repo-list");
    listEl.style.maxHeight = "40vh";
    listEl.style.overflowY = "auto";
    listEl.setText("Loading repositories…");

    const footer = contentEl.createDiv("ghs-add-sub");
    footer.style.marginTop = "0.75rem";
    footer.createSpan({ text: "Don't see it? " });
    const installLink = footer.createEl("a", { text: "Install the app on another account/org" });
    installLink.style.cursor = "pointer";
    installLink.onclick = () => window.open(installUrl(), "_blank");

    let groups: Array<{ login: string; repos: string[] }> = [];

    const render = (filter: string) => {
      listEl.empty();
      const q = filter.trim().toLowerCase();
      let shown = 0;
      for (const g of groups) {
        const matches = g.repos.filter((r) => r.toLowerCase().includes(q));
        if (matches.length === 0) continue;
        listEl.createEl("div", { text: `@${g.login}`, cls: "ghs-repo-group" }).style.cssText =
          "font-weight:600;margin:.5rem 0 .25rem;opacity:.7";
        for (const full of matches) {
          shown++;
          const row = listEl.createEl("div", { cls: "ghs-repo-row" });
          row.style.cssText =
            "display:flex;align-items:center;gap:.4rem;padding:.35rem .5rem;border-radius:6px;cursor:pointer";
          setIcon(row.createSpan(), "github");
          row.createSpan({ text: full });
          row.onmouseenter = () => (row.style.background = "var(--background-modifier-hover)");
          row.onmouseleave = () => (row.style.background = "");
          row.onclick = () => {
            this.onPick(`https://github.com/${full}.git`, full);
            this.close();
          };
        }
      }
      if (shown === 0) listEl.createEl("div", { cls: "ghs-add-sub", text: "No matching repositories." });
    };

    search.oninput = () => render(search.value);

    void (async () => {
      try {
        groups = await this.plugin.appAuth.listAccessibleRepos();
        const total = groups.reduce((n, g) => n + g.repos.length, 0);
        if (total === 0) {
          listEl.setText("No repositories granted. Use the link below to install the app on an account/org.");
          return;
        }
        render("");
        search.focus();
      } catch (e) {
        listEl.setText("");
        listEl.createEl("div", { cls: "ghs-add-sub", text: `Couldn't load repositories: ${(e as Error).message}` });
        new Notice("Agentic Git Sync: couldn't list repositories.");
      }
    })();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
