#!/bin/bash
# Set up a sandbox test vault with a real merge conflict so you can
# verify the new three-pane ConflictModal end-to-end.
#
# Idempotent: re-run to reset to a clean conflicted state.

set -euo pipefail

VAULT="$HOME/obsidian-sync-testvault"
REMOTE="$HOME/obsidian-sync-testremote.git"
PLUGIN_SRC="$HOME/github/agentic-git-sync"
PLUGIN_DEST="$VAULT/.obsidian/plugins/agentic-git-sync"

echo "▸ Wiping any previous test vault…"
rm -rf "$VAULT" "$REMOTE" "$HOME/obsidian-sync-testremote-clone"

echo "▸ Building plugin (in case it's stale)…"
(cd "$PLUGIN_SRC" && npm run build >/dev/null)

echo "▸ Creating bare 'remote' repo at $REMOTE …"
git init --bare -q "$REMOTE"

echo "▸ Creating vault at $VAULT …"
mkdir -p "$VAULT/Projects"
cd "$VAULT"
git init -q
git config user.name  "Test User"
git config user.email "test@example.com"
git remote add origin "$REMOTE"

# Baseline file with content that will conflict later
cat > Projects/alpha.md <<'EOF'
# Project Alpha

Status: planning

## Goals
- Ship by Q3
- Hire 2 engineers

## Milestones
- Alpha demo Aug 30
- Beta freeze Sept 15

## Notes
We will focus on user retention this quarter.
EOF

git add Projects/alpha.md
git commit -q -m "baseline"
git branch -M main
git push -q origin main

echo "▸ Making a 'remote-side' edit via a second clone…"
git clone -q "$REMOTE" "$HOME/obsidian-sync-testremote-clone"
cd "$HOME/obsidian-sync-testremote-clone"
git config user.name  "Remote Collaborator"
git config user.email "remote@example.com"

cat > Projects/alpha.md <<'EOF'
# Project Alpha

Status: planning

## Goals
- Ship by Q2
- Hire 1 eng + 1 PM

## Milestones
- Alpha demo Aug 15
- Beta freeze Sept 1

## Notes
We will focus on user retention this quarter.
EOF
git commit -q -am "remote: pull dates earlier, change hiring plan"
git push -q origin main

echo "▸ Making a conflicting 'local' edit in the vault…"
cd "$VAULT"

cat > Projects/alpha.md <<'EOF'
# Project Alpha

Status: planning

## Goals
- Ship by Q3
- Hire 2 engineers + 1 designer

## Milestones
- Alpha demo Aug 30
- Beta freeze Oct 1

## Notes
We will focus on user retention this quarter.
EOF
git commit -q -am "local: add designer, push beta freeze"

echo "▸ Pulling — this WILL conflict…"
set +e
git pull --no-rebase origin main 2>&1 | tail -3
set -e

CONFLICTED=$(git diff --name-only --diff-filter=U)
if [ -z "$CONFLICTED" ]; then
  echo "⚠ Expected conflict but git pull merged cleanly. Aborting."
  exit 1
fi
echo "✓ Conflict in: $CONFLICTED"

echo "▸ Installing plugin into vault (symlink)…"
mkdir -p "$VAULT/.obsidian/plugins"
ln -sfn "$PLUGIN_SRC" "$PLUGIN_DEST"

# Tell Obsidian to enable the plugin (so it's hot on next open)
mkdir -p "$VAULT/.obsidian"
cat > "$VAULT/.obsidian/community-plugins.json" <<'EOF'
["agentic-git-sync"]
EOF

# Tell Obsidian the trust prompt for the plugin folder
echo '{ "configDir": ".obsidian" }' > "$VAULT/.obsidian/app.json" || true

# Pre-fill the plugin's saved settings so setup wizard doesn't run
mkdir -p "$VAULT/.obsidian/plugins/agentic-git-sync"
cat > "$VAULT/.obsidian/plugins/agentic-git-sync/data.json" <<EOF
{
  "setupComplete": true,
  "autoSyncInterval": 0,
  "gitUser": "Test User",
  "gitEmail": "test@example.com",
  "githubToken": "",
  "mainRepoUrl": "$REMOTE",
  "mainRepoBranch": "main",
  "submodules": [],
  "ignorePatterns": [".obsidian/workspace.json", ".obsidian/workspace-mobile.json", ".trash/**"],
  "historyLimit": 20,
  "syncHistory": [],
  "confirmBeforeSync": false,
  "ai": {
    "enabled": true,
    "deepseekToken": "",
    "deepseekModel": "deepseek-chat",
    "geminiToken": "",
    "geminiModel": "gemini-1.5-flash",
    "sendFilePaths": true,
    "sendGitMetadata": true,
    "sendSurroundingContext": true,
    "excludePatterns": [".env", ".env.*", "secrets/**"]
  }
}
EOF

echo ""
echo "──────────────────────────────────────────────"
echo "✓ Test vault ready at: $VAULT"
echo ""
echo "Next steps:"
echo "  1. Open Obsidian → Open folder as vault → choose '$VAULT'"
echo "  2. First open: trust the vault (prompts for community plugins)"
echo "     Plugin should already be enabled — if not: Settings → Community plugins → enable 'GitHub Sync'"
echo "  3. (Optional) Paste a DeepSeek or Gemini token: Settings → GitHub Sync → AI Conflict Resolution"
echo "  4. Click the GitHub icon in the left ribbon to open the Sync Dashboard"
echo "  5. The Main Vault card should show a red 'conflict' state — click 'Resolve' to open the modal"
echo "──────────────────────────────────────────────"
