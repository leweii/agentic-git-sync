import { Modal, App, Platform } from "obsidian";
import { L } from "../i18n";

export class GitNotInstalledModal extends Modal {
  constructor(app: App) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Git not found" });

    contentEl.createEl("p", {
      text: "Agentic Git Sync requires Git to be installed on your system. It was not found in your PATH.",
    });

    const isWin = Platform.isWin;
    const isMac = Platform.isMacOS;

    const stepsEl = contentEl.createDiv();

    if (isWin) {
      stepsEl.createEl("h3", { text: "Windows — install steps" });
      const ol = stepsEl.createEl("ol");
      ol.createEl("li", { text: "Download and run the Git for Windows installer (see the button below)." });
      ol.createEl("li", { text: 'During install, keep the default option "Git from the command line and also from 3rd-party software".' });
      ol.createEl("li", { text: "Restart Obsidian after the installation completes." });
    } else if (isMac) {
      stepsEl.createEl("h3", { text: "macOS — install steps" });
      const ol = stepsEl.createEl("ol");
      const li1 = ol.createEl("li");
      li1.appendText("Open Terminal and run: ");
      li1.createEl("code", { text: "xcode-select --install" });
      li1.appendText("  — or via Homebrew: ");
      li1.createEl("code", { text: "brew install git" });
      ol.createEl("li", { text: "Restart Obsidian after installation." });
    } else {
      stepsEl.createEl("h3", { text: "Linux — install steps" });
      const ol = stepsEl.createEl("ol");
      const li1 = ol.createEl("li");
      li1.appendText("Run: ");
      li1.createEl("code", { text: "sudo apt install git" });
      li1.appendText("  (Ubuntu/Debian) or the equivalent for your distro.");
      ol.createEl("li", { text: "Restart Obsidian after installation." });
    }

    const footer = contentEl.createDiv({ cls: "modal-button-container" });

    const downloadUrl = isWin
      ? "https://git-scm.com/download/win"
      : isMac
        ? "https://git-scm.com/download/mac"
        : "https://git-scm.com/download/linux";

    const downloadBtn = footer.createEl("button", { text: "Open download page", cls: "mod-cta" });
    downloadBtn.onclick = () => { window.open(downloadUrl, "_blank"); };

    const closeBtn = footer.createEl("button", { text: L().common.close });
    closeBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
