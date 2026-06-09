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

    const isAppMode = this.plugin.settings.authMethod === "githubApp";
    const isPatMode = this.plugin.settings.authMethod === "pat";

    if (isAppMode && (this.plugin.settings.githubApp?.connections ?? []).length === 0) {
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

    if (isPatMode && !this.plugin.settings.githubToken) {
      contentEl.createEl("p", {
        cls: "ghs-add-sub",
        text: "Set a Personal Access Token in Settings first to browse your repositories.",
      });
      return;
    }

    const search = contentEl.createEl("input", {
      attr: { type: "text", placeholder: "Search repositories…" },
      cls: "ghs-repo-search",
    });

    const listEl = contentEl.createDiv("ghs-repo-picker-list");
    listEl.setText("Loading repositories…");

    if (isAppMode) {
      const footer = contentEl.createDiv("ghs-repo-picker-footer");
      footer.createSpan({ text: "Don't see it? " });
      const installLink = footer.createEl("a", { cls: "ghs-repo-picker-install-link", text: "Install the app on another account/org" });
      installLink.onclick = () => window.open(installUrl(), "_blank");
    }

    let groups: Array<{ login: string; repos: string[] }> = [];

    const render = (filter: string) => {
      listEl.empty();
      const q = filter.trim().toLowerCase();
      let shown = 0;
      for (const g of groups) {
        const matches = g.repos.filter((r) => r.toLowerCase().includes(q));
        if (matches.length === 0) continue;
        listEl.createEl("div", { text: `@${g.login}`, cls: "ghs-repo-group" });
        for (const full of matches) {
          shown++;
          const row = listEl.createEl("div", { cls: "ghs-repo-row" });
          setIcon(row.createSpan(), "github");
          row.createSpan({ text: full });
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
        if (isPatMode) {
          groups = await listUserRepos(this.plugin.settings.githubToken);
        } else {
          groups = await this.plugin.appAuth.listAccessibleRepos();
        }
        const total = groups.reduce((n, g) => n + g.repos.length, 0);
        if (total === 0) {
          listEl.setText(
            isAppMode
              ? "No repositories granted. Use the link below to install the app on an account/org."
              : "No repositories found for this token.",
          );
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
