# Agentic Git Sync

**Agentic two-way sync between your Obsidian vault and GitHub — including nested folders as separate repos — without ever touching a terminal.**

Most git-based Obsidian sync plugins assume you know git. This one doesn't. Four things make it different:

### 🤖 Agentic git error recovery

Git can fail in dozens of ways: stale lock files, mid-merge state, non-fast-forward push, detached HEAD, oversized files, missing submodules. Other plugins surface raw `fatal:` errors that mean nothing to non-technical users. Agentic Git Sync routes every failure through an AI agent that classifies the error, picks a recovery tool from a 16-tool catalog, executes it silently, and retries — all before you see anything went wrong. A deterministic rule-based fallback covers users who haven't configured an AI key.

### 🧩 Real submodule support, not just one repo

Map any folder in your vault to its own GitHub repo. Keep personal notes private, sync a `Projects/` folder with your team, push a `Blog/` folder to a public repo — all from the same vault, each with independent sync settings. Adding a submodule is a single dialog: paste a URL, type a folder name, done.

### ✨ AI-resolved merge conflicts

Side-by-side three-pane resolver for conflicts the AI couldn't auto-resolve, with semantic merging that preserves intent from both sides. The AI explains its reasoning, marks the lines it had to choose between, and you accept or override.

### 👶 Designed for users who don't know git

- **Setup wizard** walks you through token → identity → first repo connection
- **`?` icon next to the token field** opens GitHub's PAT creation page directly — no need to know what a "personal access token" is
- **Empty repos are auto-initialized.** Create a new repo on github.com, paste the URL, click Add. The plugin silently seeds it with a README so git is happy. No "branch yet to be born" errors.
- **Test connection** diagnoses three layers (token validity, repo access, actual git auth path) and tells you exactly which step is failing, in plain language. No more `403` mysteries.

## Installation

### Community plugins

1. Open **Settings → Community plugins**
2. Click **Browse**, search for **Agentic Git Sync**
3. Click **Install**, then **Enable**

### Manual install

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/leweii/agentic-git-sync/releases/latest)
2. Copy them into `<your-vault>/.obsidian/plugins/agentic-git-sync/`
3. Restart Obsidian, then enable **Agentic Git Sync** under Settings → Community plugins

## Getting started

The setup wizard appears from Settings → Agentic Git Sync → Run setup wizard. Three short steps:

1. **Paste a GitHub Personal Access Token.** Click the **?** icon next to the input to open the GitHub token page. Either format works:
   - Classic (`ghp_…`) — needs the `repo` scope
   - Fine-grained (`github_pat_…`) — give it **Contents: read & write** on the repos you'll sync
2. **Connect your main vault to a GitHub repo.** Paste the HTTPS URL. The plugin handles the initial commit, push, and (if the repo is empty) seeds it so the first sync works.
3. **(Optional) Add submodules** from the dashboard. One submodule per folder you want in its own repo.

## How your data is stored

| File | Where | Contains | Travels with the repo? |
|---|---|---|---|
| `data.json` | `<vault>/.obsidian/plugins/agentic-git-sync/` | Your tokens, sync history, per-machine state | ❌ Local only |
| `.github-sync.json` | `<vault>/` | Remote URLs, branches, AI model choice, submodule list | ✅ Committed (so a fresh clone on a new machine picks up your config automatically) |

**Secrets never leave your device.** The plugin's own `.gitignore` excludes `.obsidian/`, and `.github-sync.json`'s schema has no token fields at all — there's no path by which the plugin can leak credentials into a commit.

## Security & permissions

The plugin is `isDesktopOnly: true` and uses a few APIs that the Obsidian community-plugin scanner flags. Each is justified by what a git plugin fundamentally has to do; what each one is and isn't, in plain terms:

| API | What we do with it | What we don't do |
|---|---|---|
| **Node `fs` (read/write outside vault API)** | Read and write files inside `<vault>/.git/` (lock files like `index.lock` / `MERGE_HEAD`, `.gitmodules`, the submodule's `.git` gitfile) and toplevel git-managed files (`.gitignore`). Obsidian's `Vault` API doesn't expose dotfiles or `.git/`, so we can't reach them through it. | Read or write anywhere outside the user's vault root. Every path passed to `fs` is constructed from the vault path and a git-known sub-path. Access is gated by `Platform.isDesktop`. |
| **`child_process` (shell execution)** | Not used directly. Pulled in transitively by [`simple-git`](https://github.com/steveukx/git-js), which invokes the system `git` binary to run actual git operations (pull, push, commit, merge). This is the only way to use git from a Node plugin. | Spawn anything besides git, or pass user-controlled strings as commands. `simple-git` passes arguments as a fixed argv array, not through a shell. |
| **Clipboard** | One write of the plugin's own error string when you click the "Copy" button next to a failed sync, so you can paste it into an issue or chat. *(Removed in v1.1.1+: replaced with an inline selectable error text element so no clipboard write happens at all.)* | Read the clipboard. Touch any vault content. |
| **Network** | HTTPS requests to `github.com` / `api.github.com` to do git fetch/push, check repo access, and (if you've configured one) the AI provider you chose (DeepSeek or Gemini) for conflict resolution. | Send anything anywhere else. AI requests only fire when smart-sync is on AND a key is configured; you can disable file-path or surrounding-context sharing in Settings → AI. |

The token you paste in Settings is stored in `<vault>/.obsidian/plugins/agentic-git-sync/data.json` — local only, never written into any committed file. The plugin's `.github-sync.json` (the shared, committed config) has no token field at all.

## Troubleshooting

**`Permission denied` or `403` on push.** Open Settings → Agentic Git Sync → **Test connection**. The third row (`git auth`) exercises the same credential path your sync uses. If that row fails while the API rows pass, your local git is using stale credentials (most commonly the macOS Keychain) — erase the cached entry or rotate the token.

**Token sticks around after uninstall.** Obsidian preserves plugin data across reinstalls by design. To fully wipe credentials, delete `<vault>/.obsidian/plugins/agentic-git-sync/data.json`.

## License

[MIT](./LICENSE)
