import simpleGit, { SimpleGit } from "simple-git";
import { fs, path, type Dirent } from "../node-builtins";
import type { PendingChanges, SyncProgress } from "../types";
import type { AIProvider } from "../ai/AIProvider";
import { GitErrorAgent } from "./GitErrorAgent";

export type ProgressFn = (p: SyncProgress) => void;

export interface SyncOptions {
  branch?: string;
  message?: string;
  ignorePatterns?: string[];
  onProgress?: ProgressFn;
}

export class GitConflictError extends Error {
  constructor(public conflicts: string[]) {
    super(`Merge conflict in ${conflicts.length} file(s)`);
    this.name = "GitConflictError";
  }
}

export class GitManager {
  private git: SimpleGit;
  private vaultPath: string;

  private user: string;
  private email: string;
  private token: string;
  private configDir: string;
  private errorAgent: GitErrorAgent;

  constructor(
    vaultPath: string,
    user: string,
    email: string,
    token: string,
    configDir: string,
    providers: AIProvider[] = []
  ) {
    this.vaultPath = vaultPath;
    this.user = user;
    this.email = email;
    this.token = token;
    this.configDir = configDir;
    this.git = simpleGit(vaultPath);
    this.errorAgent = new GitErrorAgent(this.git, vaultPath, providers);
    this.configureGit().catch(() => {});
  }

  private async configureGit() {
    if (this.user) await this.git.addConfig("user.name", this.user).catch(() => {});
    if (this.email) await this.git.addConfig("user.email", this.email).catch(() => {});
    // The credential-rewrite key embeds the token itself, so a rotated
    // token becomes a *different* config key and the old rule lingers.
    // Multiple insteadOf rules for the same https://github.com/ target
    // are ambiguous: git may pick a stale/revoked token and fail real
    // git ops with "Invalid username or token" even though the current
    // token is valid (the API check, which reads the token directly,
    // still passes — a confusing split-brain). Purge every prior rule
    // so exactly one is ever active.
    await this.clearCredentialRewrites();
    if (this.token) {
      await this.git.addConfig(
        "url.https://oauth2:" + this.token + "@github.com/.insteadOf",
        "https://github.com/"
      ).catch(() => {});
    }
    // Large-push tuning. Default postBuffer (1 MB) makes git break the
    // request into chunks that need to be re-sent on any hiccup; large
    // vaults hit "RPC failed; HTTP 408" / "Broken pipe" / "Connection
    // reset by peer" / "unable to rewind rpc post data" routinely.
    //   postBuffer 1 GB                         — single big send, fewer rewinds
    //   lowSpeedLimit 1 KB/s, lowSpeedTime 600s — be patient on slow uploads
    //   http.version HTTP/1.1                   — avoid HTTP/2 multiplexing
    //                                             issues that some proxies /
    //                                             firewalls cause on long
    //                                             uploads ("broken pipe",
    //                                             "send-pack disconnect")
    await this.git.addConfig("http.postBuffer", "1073741824").catch(() => {});
    await this.git.addConfig("http.lowSpeedLimit", "1000").catch(() => {});
    await this.git.addConfig("http.lowSpeedTime", "600").catch(() => {});
    await this.git.addConfig("http.version", "HTTP/1.1").catch(() => {});
    // Suppress git's "The following paths are ignored by one of your
    // .gitignore files / hint: Use -f if you really want to add them"
    // advice. The plugin already filters ignored paths and surfaces its
    // own messages — the raw hint is just noise that confuses non-technical
    // users who never invoked git directly.
    await this.git.addConfig("advice.addIgnoredFile", "false").catch(() => {});
  }

  /**
   * Remove every `url.<...>.insteadOf` rule from the local config. These
   * are only ever written by configureGit() to inject the token into git's
   * transport URL; stale ones (left by token rotation) make auth
   * non-deterministic. Safe to call unconditionally before re-adding the
   * current rule.
   */
  private async clearCredentialRewrites(): Promise<void> {
    let listing: string;
    try {
      listing = await this.git.raw([
        "config", "--local", "--name-only",
        "--get-regexp", "^url\\..*\\.insteadof$",
      ]);
    } catch {
      return; // git exits non-zero when there are no matching keys
    }
    const sections = new Set<string>();
    for (const key of listing.split("\n").map((s) => s.trim()).filter(Boolean)) {
      sections.add(key.replace(/\.insteadof$/i, ""));
    }
    for (const section of sections) {
      await this.git.raw(["config", "--local", "--remove-section", section]).catch(() => {});
    }
  }

  /**
   * Run a git command, retrying on transient network-layer errors that
   * commonly hit large pushes: broken pipe, connection reset, RPC failed
   * (HTTP 408/502/503), send-pack disconnect.
   */
  private async runWithRetry(
    args: string[],
    maxAttempts = 3,
    onProgress?: ProgressFn
  ): Promise<void> {
    const transientRe = /broken pipe|connection reset|rpc failed|send-pack|operation timed out|http 408|http 5\d\d|early eof|the remote end hung up/i;
    let lastErr: Error | null = null;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.git.raw(args);
        return;
      } catch (e) {
        lastErr = e as Error;
        const msg = lastErr.message ?? "";
        if (!transientRe.test(msg) || i === maxAttempts - 1) throw lastErr;
        const waitMs = 1000 * Math.pow(2, i); // 1s, 2s, 4s
        onProgress?.({
          phase: "pushing",
          message: `Network blip, retrying push in ${waitMs / 1000}s (attempt ${i + 2}/${maxAttempts})…`,
        });
        await new Promise((r) => window.setTimeout(r, waitMs));
      }
    }
    throw lastErr ?? new Error("Git command failed after retries.");
  }

  async isRepo(): Promise<boolean> {
    return this.git.checkIsRepo();
  }

  async listChanges(ignore: string[] = []): Promise<PendingChanges> {
    const status = await this.git.status();
    const keep = (p: string) => !ignore.some((pat) => matchPattern(p, pat));
    const added = [...status.not_added, ...status.created].filter(keep);
    const modified = status.modified.filter(keep);
    const deleted = status.deleted.filter(keep);
    const conflicted = status.conflicted.filter(keep);
    return {
      added,
      modified,
      deleted,
      conflicted,
      total: added.length + modified.length + deleted.length + conflicted.length,
    };
  }

  /**
   * Revert a set of files to their last committed state.
   * - tracked (modified/deleted): git restore
   * - untracked (added/new): delete from disk
   */
  async revertFiles(tracked: string[], untracked: string[]): Promise<void> {
    if (tracked.length > 0) {
      await this.git.raw(["restore", "--", ...tracked]);
    }
    for (const f of untracked) {
      const abs = `${this.vaultPath}/${f}`;
      fs.rmSync(abs, { force: true });
    }
  }

  /** True when MERGE_HEAD exists — works for both normal repos and git submodules.
   *  Submodules use a gitfile (.git is a file, not a dir) pointing to the parent
   *  repo's .git/modules/<name>/ directory, so we resolve that indirection first. */
  private isMidMerge(): boolean {
    try {
      const gitFileOrDir = `${this.vaultPath}/.git`;
      let gitDir: string;
      const stat = fs.statSync(gitFileOrDir);
      if (stat.isDirectory()) {
        gitDir = gitFileOrDir;
      } else {
        // gitfile format: "gitdir: <relative-path>"
        const ref = fs.readFileSync(gitFileOrDir, "utf8").trim().replace(/^gitdir:\s*/, "");
        gitDir = path.resolve(this.vaultPath, ref);
      }
      fs.accessSync(path.join(gitDir, "MERGE_HEAD"));
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve the real .git directory, handling submodule gitfile indirection. */
  private resolveGitDir(): string | null {
    try {
      const gitFileOrDir = `${this.vaultPath}/.git`;
      const stat = fs.statSync(gitFileOrDir);
      if (stat.isDirectory()) return gitFileOrDir;
      const ref = fs.readFileSync(gitFileOrDir, "utf8").trim().replace(/^gitdir:\s*/, "");
      return path.resolve(this.vaultPath, ref);
    } catch {
      return null;
    }
  }

  /**
   * Remove a stale `.git/index.lock` left behind by a previous git
   * process that crashed (Obsidian quit mid-sync, machine slept, etc.).
   * Only deletes lock files older than 30s — within that window a real
   * concurrent op might be running.
   *
   * Called at the start of every sync to recover from the common
   * "Another git process seems to be running" failure that otherwise
   * required the user to delete the file by hand.
   */
  private clearStaleIndexLock(): void {
    const gitDir = this.resolveGitDir();
    if (!gitDir) return;
    const lockPath = path.join(gitDir, "index.lock");
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 30_000) fs.unlinkSync(lockPath);
    } catch { /* lock doesn't exist — nothing to do */ }
  }

  async listConflicts(): Promise<string[]> {
    const status = await this.git.status();
    return status.conflicted;
  }

  async resolveConflict(file: string, strategy: "ours" | "theirs"): Promise<void> {
    await this.git.raw(["checkout", `--${strategy}`, "--", file]);
    await this.git.add(file);
  }

  async stagePath(file: string): Promise<void> {
    await this.git.add(file);
  }

  async abortMerge(): Promise<void> {
    await this.git.raw(["merge", "--abort"]).catch(() => {});
  }

  async pull(branch = "main", onProgress?: ProgressFn): Promise<void> {
    onProgress?.({ phase: "pulling", message: `Pulling origin/${branch}` });
    try {
      await this.git.pull("origin", branch, { "--rebase": "false" });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("refusing to merge unrelated histories")) {
        await this.pullWithAutoResolve(branch);
        return;
      }
      // Brand-new empty GitHub repo has no branches yet — pull fails with
      // "couldn't find remote ref <branch>". Treat as no-op; the
      // subsequent `push --set-upstream` will create the branch.
      if (
        /couldn't find remote ref/i.test(msg) ||
        msg.includes("No such ref")
      ) {
        return;
      }
      const conflicts = (await this.git.status()).conflicted;
      if (conflicts.length > 0) throw new GitConflictError(conflicts);
      throw e;
    }
  }

  /**
   * Pull with --allow-unrelated-histories, then auto-resolve system file
   * conflicts and commit the merge. Throws GitConflictError only when user
   * content files genuinely conflict.
   */
  private async pullWithAutoResolve(branch: string): Promise<void> {
    try {
      await this.git.pull("origin", branch, { "--rebase": "false", "--allow-unrelated-histories": null });
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (!msg.includes("Automatic merge failed") && !msg.includes("CONFLICT")) throw e;
      // "Automatic merge failed" → conflicts on disk, handled below
    }

    // Auto-resolve system files and clean up file/directory residuals.
    const conflicts = (await this.git.status()).conflicted;
    const userConflicts = await this.autoResolveSystemFiles(conflicts);
    if (userConflicts.length > 0) throw new GitConflictError(userConflicts);

    // If MERGE_HEAD still exists (auto-resolved staged files not yet committed),
    // finalise the merge commit now so the repo is in a clean state.
    if (this.isMidMerge()) {
      await this.git.commit("chore: merge with remote");
    }
  }

  /** Stage and commit local changes. Returns number of changed files, or 0 if nothing to commit. */
  async stageAndCommit(
    message?: string,
    ignore: string[] = [],
    onProgress?: ProgressFn
  ): Promise<number> {
    const changes = await this.listChanges(ignore);
    if (changes.total === 0) return 0;

    onProgress?.({ phase: "committing", message: `Staging ${changes.total} file(s)` });
    const toAdd = [...changes.added, ...changes.modified];
    const toRemove = changes.deleted;

    if (toAdd.length > 0) await this.git.add(toAdd);
    for (const f of toRemove) {
      await this.git.raw(["rm", "--cached", "--ignore-unmatch", f]).catch(() => {});
      await this.git.raw(["rm", "--ignore-unmatch", f]).catch(() => {});
    }

    try {
      await this.git.commit(message ?? `sync: ${new Date().toISOString()}`);
    } catch (commitErr) {
      const commitMsg = (commitErr as Error).message ?? "";
      if (commitMsg.includes("unmerged") || commitMsg.includes("not possible")) {
        const conflicted = await this.listConflicts();
        throw new GitConflictError(conflicted.length > 0 ? conflicted : changes.conflicted);
      }
      throw commitErr;
    }
    return changes.total;
  }

  async commitAndPush(
    branch = "main",
    message?: string,
    ignore: string[] = [],
    onProgress?: ProgressFn
  ): Promise<number> {
    const committed = await this.stageAndCommit(message, ignore, onProgress);
    if (committed === 0) return 0;
    onProgress?.({ phase: "pushing", message: `Pushing to origin/${branch}` });
    await this.runWithRetry(["push", "--set-upstream", "origin", branch], 3, onProgress);
    return committed;
  }

  /** Commit whatever is already staged (from conflict resolution) and push. */
  async commitMergedAndPush(
    branch = "main",
    message: string,
    onProgress?: ProgressFn
  ): Promise<number> {
    const status = await this.git.status();
    const stagedCount = status.staged.length;
    onProgress?.({ phase: "committing", message: "Committing merge" });
    await this.git.commit(message);
    onProgress?.({ phase: "pushing", message: `Pushing to origin/${branch}` });
    await this.runWithRetry(["push", "--set-upstream", "origin", branch], 3, onProgress);
    return stagedCount;
  }

  /**
   * Auto-resolve conflicts in system/config files that should never need
   * user intervention. Returns the remaining conflicts that need manual review.
   *
   * - .github-sync.json  → theirs (remote is authoritative for shared config)
   * - .DS_Store / Thumbs.db → ours (OS noise; drop the remote version)
   * - .obsidian/plugins/** → ours (local plugin installs; drop remote version)
   *
   * Also cleans up git's file/directory conflict residue: when git can't merge
   * a directory and a file at the same path, it renames one side to
   * "<name>~<hash>". These paths never appear in status.conflicted but block
   * the merge commit and cause Obsidian errors.
   */
  async autoResolveSystemFiles(conflicts: string[]): Promise<string[]> {
    const takeTheirs = [".github-sync.json"];
    const isSystemPath = (f: string) =>
      f === ".DS_Store" ||
      f === "Thumbs.db" ||
      f.startsWith(`${this.configDir}/plugins/`) ||
      f.startsWith(`${this.configDir}/themes/`);

    const remaining: string[] = [];
    for (const file of conflicts) {
      if (takeTheirs.includes(file)) {
        await this.resolveConflict(file, "theirs").catch(() => {});
      } else if (isSystemPath(file)) {
        await this.resolveConflict(file, "ours").catch(() => {});
      } else {
        remaining.push(file);
      }
    }

    // Clean up file/directory conflict residue left by git (paths ending in
    // ~<40-char-hex>). These are never in status.conflicted but block the
    // merge commit. Remove and un-stage them so git can proceed.
    await this.purgeGitResidualPaths();

    return remaining;
  }

  private async purgeGitResidualPaths(): Promise<void> {
    const residualRe = /~[0-9a-f]{40}$/;
    const toRemove: string[] = [];

    const scan = (dir: string) => {
      let entries: Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = `${dir}/${entry.name}`;
        if (residualRe.test(entry.name)) {
          toRemove.push(full);
        } else if (entry.isDirectory()) {
          scan(full);
        }
      }
    };
    scan(this.vaultPath);

    for (const full of toRemove) {
      fs.rmSync(full, { recursive: true, force: true });
      const rel = full.slice(this.vaultPath.length + 1);
      await this.git.raw(["rm", "-r", "--cached", "--ignore-unmatch", "--force", rel]).catch(() => {});
    }
  }

  /**
   * Make sure the vault has `origin` pointing at `remoteUrl`. Used by the
   * settings page when the user updates the URL or initialises the vault
   * inline. Handles three states:
   *   - vault not a git repo yet         → initRepo()
   *   - vault is a repo, no origin       → addRemote
   *   - vault is a repo, origin differs  → set-url
   */
  /**
   * Exercise git's actual auth path against a remote URL by running
   * `ls-remote`. This is the same credential flow sync uses: simple-git
   * reads `.git/config` for the vault, applies the `insteadOf` rewrite,
   * and falls back to the system credential helper otherwise. So a
   * failure here matches what a real sync would see.
   *
   * Used by the diagnostic "Test connection" button to catch stale
   * macOS keychain entries, missing insteadOf rules, or SSO-blocked
   * tokens that the API-level checks don't surface.
   */
  async testRemote(remoteUrl: string): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.git.raw(["ls-remote", "--exit-code", "--heads", remoteUrl]);
      return { ok: true };
    } catch (e) {
      // simple-git puts stderr in .message; trim the noisy "fatal: " prefix
      // chain so the UI shows the actionable line.
      let msg = (e as Error).message ?? "ls-remote failed";
      msg = msg.replace(/^.*?(fatal:|remote:)/i, "$1").split("\n")[0].trim();
      return { ok: false, message: msg };
    }
  }

  async setOrigin(remoteUrl: string, branch = "main"): Promise<void> {
    if (!(await this.isRepo())) {
      await this.initRepo(remoteUrl, branch);
      return;
    }
    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");
    if (!origin) {
      await this.git.addRemote("origin", remoteUrl);
    } else if (origin.refs.fetch !== remoteUrl && origin.refs.push !== remoteUrl) {
      await this.git.remote(["set-url", "origin", remoteUrl]);
    }
  }

  async initRepo(remoteUrl: string, branch: string): Promise<void> {
    // If a previous run crashed mid-init, a stale lock can block this one.
    this.clearStaleIndexLock();
    await this.git.init();
    await this.configureGit();
    await this.git.raw(["checkout", "-b", branch]).catch(() => {});
    await this.git.addRemote("origin", remoteUrl).catch(() => {});
    // Write a .gitignore so git itself never tracks OS noise, the entire
    // .obsidian config dir (per-machine UI state, installed plugins, themes,
    // hotkeys), or the local trash. ignorePatterns in settings is only a
    // commit-stage filter — .gitignore stops the file from being seen by
    // git at all.
    const gitignorePath = `${this.vaultPath}/.gitignore`;
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(
        gitignorePath,
        [
          ".DS_Store",
          "Thumbs.db",
          `${this.configDir}/`,
          ".trash/",
        ].join("\n") + "\n"
      );
    }
  }

  /**
   * Sync with automatic error recovery. Up to MAX_RECOVERY_ATTEMPTS recovery
   * cycles are attempted before the error is surfaced. GitConflictError (user
   * content merge conflicts) is never intercepted here — it always surfaces
   * to the ConflictModal for the user to resolve.
   */
  async sync(opts: SyncOptions & { remoteUrl?: string } = {}): Promise<number> {
    const branch = opts.branch ?? "main";
    const MAX_RECOVERY_ATTEMPTS = 2;

    for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      try {
        return await this._doSync(opts);
      } catch (e) {
        if (e instanceof GitConflictError) throw e;
        if (attempt >= MAX_RECOVERY_ATTEMPTS) throw e;
        const recovered = await this.errorAgent.tryRecover(e as Error, "sync", branch);
        if (!recovered) throw e;
        // recovered — loop and retry _doSync with a clean state
      }
    }
    throw new Error("Sync failed after all recovery attempts");
  }

  private async _doSync(opts: SyncOptions & { remoteUrl?: string }): Promise<number> {
    const branch = opts.branch ?? "main";
    this.clearStaleIndexLock();
    opts.onProgress?.({ phase: "checking", message: "Checking status" });

    // Auto-init if this vault isn't a git repo yet.
    if (!(await this.isRepo())) {
      if (!opts.remoteUrl) throw new Error("Vault is not a git repository. Add a remote URL in Settings.");
      opts.onProgress?.({ phase: "pulling", message: "Initialising repository…" });
      await this.initRepo(opts.remoteUrl, branch);

      // Step 1 — commit any existing local files so they are always preserved
      // in git history before the remote merge.
      const localChanges = await this.listChanges(opts.ignorePatterns ?? []);
      if (localChanges.total > 0) {
        opts.onProgress?.({ phase: "committing", message: `Committing ${localChanges.total} existing file(s)…` });
        const toAdd = [...localChanges.added, ...localChanges.modified];
        if (toAdd.length > 0) await this.git.add(toAdd);
        await this.git.commit("chore: initial vault commit");
      }

      // Step 2 — pull from remote.
      // • Allow unrelated histories (remote may have been init'd with a README).
      // • "Automatic merge failed" means conflicts — handle them below.
      // • Any other error (no remote ref, etc.) means remote is empty — skip.
      let remoteHasCommits = false;
      try {
        await this.git.pull("origin", branch, { "--rebase": "false", "--allow-unrelated-histories": null });
        remoteHasCommits = true;
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (msg.includes("Automatic merge failed") || msg.includes("CONFLICT")) {
          remoteHasCommits = true; // pull left conflict state on disk
        }
        // else: remote is empty or unreachable — push below creates the branch
      }

      if (remoteHasCommits) {
        // Resolve any conflicts left by the pull.
        const conflicts = (await this.git.status()).conflicted;
        const userConflicts = await this.autoResolveSystemFiles(conflicts);
        if (userConflicts.length > 0) throw new GitConflictError(userConflicts);
        // If MERGE_HEAD still exists (all conflicts auto-resolved but not yet
        // committed), finalise the merge commit now.
        if (this.isMidMerge()) {
          await this.git.commit("chore: merge with remote");
        }
      }

      // Step 3 — push everything (initial commit + any merge commit).
      opts.onProgress?.({ phase: "pushing", message: `Pushing to origin/${branch}` });
      await this.runWithRetry(["push", "--set-upstream", "origin", branch], 3, opts.onProgress);
      return localChanges?.total ?? 0;
    }

    const ignore = opts.ignorePatterns ?? [];

    // If ConflictModal resolved a merge (files written + staged) but deferred
    // the commit ("next sync will commit and push"), finalise it now.
    // Must check isMidMerge() BEFORE listConflicts() — staged resolved files
    // are not conflicts, and we should commit them rather than surface them.
    if (this.isMidMerge()) {
      const stillConflicted = (await this.git.status()).conflicted;
      if (stillConflicted.length > 0) throw new GitConflictError(stillConflicted);
      opts.onProgress?.({ phase: "committing", message: "Committing resolved merge…" });
      await this.git.commit("chore: commit resolved merge");
    }

    // Surface any genuine pre-existing conflict (no mid-merge state remains now).
    const existingConflicts = await this.listConflicts();
    if (existingConflicts.length > 0) {
      throw new GitConflictError(existingConflicts);
    }

    // Commit local changes BEFORE pulling so git never has to overwrite
    // uncommitted work during the merge.
    await this.stageAndCommit(opts.message, ignore, opts.onProgress);

    // Pull remote changes (handles unrelated histories + auto-resolves system files).
    await this.pull(branch, opts.onProgress);

    // Commit any auto-resolved merge files, then push everything.
    await this.stageAndCommit(opts.message, ignore, opts.onProgress);
    opts.onProgress?.({ phase: "pushing", message: `Pushing to origin/${branch}` });
    await this.runWithRetry(["push", "--set-upstream", "origin", branch], 3, opts.onProgress);
    return 1;
  }
}

// Minimal glob-ish match: supports * and trailing /** style patterns.
// Good enough for ignore lists like ".obsidian/workspace.json" or "*.tmp".
function matchPattern(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === path) return true;
  // escape regex special chars except * and /
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLESTAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DOUBLESTAR::/g, ".*") +
      "$"
  );
  return re.test(path);
}
