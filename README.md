<p align="center">
  <img src="./docs/logo/logo.png" alt="Agentic Git Sync" width="160">
</p>

# Agentic Git Sync

[English](./README.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md)

A GitHub two-way sync plugin for Obsidian users who don't know git. Three things make it different.

![Agentic Git Sync dashboard inside Obsidian](./docs/screenshots/dashboard.png)

## Core features

### An AI agent handles the git internals

Hand the messy parts of git off to an AI.

![AI-assisted three-pane conflict resolver with reasoning](./docs/screenshots/conflict-resolver.png)

- **AI conflict resolution** — auto-merges diverged branches and only opens a visual resolver when it can't decide. When it does open, you get a three-pane Local / Remote / AI Suggestion view, an AI confidence rating, and the model's reasoning for the picked side.
- **Git error diagnosis** — non-fast-forward push? need to merge before push? you don't need to know any of it; the agent navigates it.
- **AI-drafted commit messages** — DeepSeek or Gemini reads the diff and produces a semantic message you can edit before committing.
- **Empty repos auto-initialize** — paste a URL and the plugin silently does the initial commit and first push.

### Fits both personal sync and team collaboration

Private notes stay private while team work happens alongside — independent, non-interfering.

![Add submodule dialog with Team mode](./docs/screenshots/add-submodule.png)

- Personal knowledge stays private.
- Team-shared knowledge lives in submodules.
- A friendly conflict-management UI.
- A simple personal-branch / team-main-branch model.

### Invisible two-way sync

A background scheduler pulls and pushes on a timer while you write. Tokens and machine-local state stay in `.obsidian/` (never committed); remote URLs and the submodule list live in `.github-sync.json` and travel with the repo, so a fresh clone on another machine restores your config automatically.

## Install

**Community plugins:** Settings → Community plugins → Browse → search *Agentic Git Sync* → Install → Enable.

**Manual:** download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/leweii/agentic-git-sync/releases/latest), drop them into `<vault>/.obsidian/plugins/agentic-git-sync/`, restart Obsidian, and enable.

## Get started

Settings → Agentic Git Sync → **Run setup wizard**:

1. Paste a GitHub Personal Access Token (the `?` icon opens GitHub's token page). Classic needs `repo`; fine-grained needs **Contents: read & write**.
2. Paste the HTTPS URL of the repo for your main vault. The plugin handles the initial commit and first push.
3. (Optional) Add per-folder submodules from the dashboard.

## Data security

**Secrets never leave your device.** The token lives in `<vault>/.obsidian/plugins/agentic-git-sync/data.json` — local only. The committed `.github-sync.json` has no token field by schema, so credentials cannot leak into a commit.

## Git history

Browse the commit history of any file without leaving Obsidian. Click a commit (or shift-click a range) to see the diff inline; commit messages are the semantic ones the AI drafted when the change was synced.

![File history modal with commit list and inline diff](./docs/screenshots/file-history.png)

## License

[MIT](./LICENSE)
