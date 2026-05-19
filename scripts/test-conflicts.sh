#!/bin/bash
# Builds a fresh sandbox vault with multiple varied conflicts so you
# can exercise the modal, AI auto-resolve, and the new repo-config-file
# migration flow.
#
# Vault path: ~/obsidian-conflicts-testvault  (separate from the original
# obsidian-sync-testvault so they don't interfere)
#
# Idempotent: re-run to reset to a clean conflicted state.

set -euo pipefail

VAULT="$HOME/obsidian-conflicts-testvault"
REMOTE="$HOME/obsidian-conflicts-testremote.git"
CLONE="$HOME/obsidian-conflicts-testremote-clone"
PLUGIN_SRC="$HOME/github/agentic-git-sync"
PLUGIN_DEST="$VAULT/.obsidian/plugins/agentic-git-sync"

echo "▸ Wiping any previous conflicts test vault…"
rm -rf "$VAULT" "$REMOTE" "$CLONE"

echo "▸ Building plugin (in case it's stale)…"
(cd "$PLUGIN_SRC" && npm run build >/dev/null)

echo "▸ Creating bare 'remote' repo at $REMOTE …"
git init --bare -q "$REMOTE"

echo "▸ Creating vault at $VAULT …"
mkdir -p "$VAULT/notes" "$VAULT/docs"
cd "$VAULT"
git init -q
git config user.name  "Test User"
git config user.email "test@example.com"
git remote add origin "$REMOTE"

# ─── Baseline: 3 files that will conflict + 1 file that won't ─────
cat > notes/simple.md <<'EOF'
# Simple

Project status: planning
Owner: Jakob
EOF

cat > notes/multi.md <<'EOF'
# Multi-hunk note

## Section A — Tech stack
Stack: PostgreSQL.
Maturity: 30+ years.
Use case: transactional workloads.

## Section B — Team
Team size: 3 engineers.
Lead: TBD.
Onboarding cadence: 1 week.

## Section C — Timeline
Launch target: Q3 2026.
Phase 1: closed beta.
Marketing kickoff: TBD.

## Section D — Anchor
No changes here on either side.
EOF

cat > docs/architecture.md <<'EOF'
# Architecture

## Storage
Single-node SQLite, file at /var/data/app.db
EOF

cat > notes/clean.md <<'EOF'
# Clean

This file changes only on the local side — will auto-merge cleanly.
EOF

git add .
git commit -q -m "baseline"
git branch -M main
git push -q -u origin main

# ─── Remote-side edits via a second clone ──────────────────────────
echo "▸ Making remote-side edits…"
git clone -q "$REMOTE" "$CLONE"
cd "$CLONE"
git config user.name  "Remote Collaborator"
git config user.email "remote@example.com"

cat > notes/simple.md <<'EOF'
# Simple

Project status: in-progress
Owner: Jakob
EOF

cat > notes/multi.md <<'EOF'
# Multi-hunk note

## Section A — Tech stack
Stack: PostgreSQL with read replicas.
Maturity: 30+ years.
Use case: transactional workloads.

## Section B — Team
Team size: 2 engineers + 1 designer.
Lead: TBD.
Onboarding cadence: 1 week.

## Section C — Timeline
Launch target: Q2 2026.
Phase 1: closed beta.
Marketing kickoff: TBD.

## Section D — Anchor
No changes here on either side.
EOF

cat > docs/architecture.md <<'EOF'
# Architecture

## Storage
PostgreSQL on RDS, automated backups every 4h
EOF

git commit -q -am "remote: refine plans, switch storage to RDS"
git push -q origin main

# ─── Local-side edits in the vault (will conflict) ─────────────────
echo "▸ Making conflicting local edits…"
cd "$VAULT"

cat > notes/simple.md <<'EOF'
# Simple

Project status: planning
Owner: Jakob He
EOF

cat > notes/multi.md <<'EOF'
# Multi-hunk note

## Section A — Tech stack
Stack: PostgreSQL + Redis cache.
Maturity: 30+ years.
Use case: transactional workloads.

## Section B — Team
Team size: 4 engineers.
Lead: TBD.
Onboarding cadence: 1 week.

## Section C — Timeline
Launch target: Q4 2026.
Phase 1: closed beta.
Marketing kickoff: TBD.

## Section D — Anchor
No changes here on either side.
EOF

cat > docs/architecture.md <<'EOF'
# Architecture

## Storage
SQLite for now, plan to migrate to Postgres in Q4
EOF

# clean.md only changes locally — no conflict
cat >> notes/clean.md <<'EOF'

Added locally — should commit cleanly without conflict.
EOF

git commit -q -am "local: bump versions, add features"

echo "▸ Pulling — this WILL conflict in 3 files…"
set +e
git pull --no-rebase origin main 2>&1 | tail -3
set -e

CONFLICTED=$(git diff --name-only --diff-filter=U)
if [ -z "$CONFLICTED" ]; then
  echo "⚠ Expected conflict but git pull merged cleanly. Aborting."
  exit 1
fi

echo "✓ Conflicts in:"
echo "$CONFLICTED" | sed 's/^/    /'

# ─── Install plugin into the vault (symlink) ──────────────────────
echo "▸ Installing plugin into vault (symlink)…"
mkdir -p "$VAULT/.obsidian/plugins"
ln -sfn "$PLUGIN_SRC" "$PLUGIN_DEST"

cat > "$VAULT/.obsidian/community-plugins.json" <<'EOF'
["agentic-git-sync"]
EOF

# Pre-fill plugin data.json — sets up plugin but deliberately leaves
# .github-sync.json absent, so on first Obsidian launch the migration
# logic will generate it. Silent mode OFF by default so the modal shows.
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
    "silentMode": false,
    "silentMinConfidence": 3,
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
echo "✓ Conflicts test vault ready: $VAULT"
echo ""
echo "Conflict matrix to exercise:"
echo "  • notes/simple.md      — 1 hunk, contradictory single line (status vs owner)"
echo "  • notes/multi.md       — 3 hunks scattered in one file (good for Prev/Next)"
echo "  • docs/architecture.md — subfolder + larger semantic difference"
echo "  • notes/clean.md       — local-only change, NO conflict (sanity)"
echo ""
echo "Migration check:"
echo "  • .github-sync.json is intentionally NOT present yet."
echo "  • On first Obsidian launch, plugin should auto-generate it."
echo "  • Look for the Notice + check 'ls $VAULT/.github-sync.json' afterwards."
echo ""
echo "Steps:"
echo "  1. open -a Obsidian \"$VAULT\""
echo "  2. Trust author when prompted (plugin enables automatically)"
echo "  3. (Optional) Paste DeepSeek/Gemini token in Settings → AI"
echo "  4. Click GitHub ribbon icon → Resolve to open the modal"
echo "  5. Switch between files in left sidebar; Prev/Next within multi.md"
echo "  6. Try Take Local / Take Remote / Take AI / Edit manually"
echo "  7. After all resolved, Commit merge — verify with:"
echo "       cd $VAULT && git log --oneline"
echo ""
echo "Reset to fresh conflicts:  $0"
echo "──────────────────────────────────────────────"
