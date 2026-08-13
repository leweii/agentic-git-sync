import type { SimpleGit } from "simple-git";
import { makeGit } from "./gitFactory";
import path from "path";
import { fs } from "../node-builtins";
import type { SubmoduleConfig } from "../settings";
import type { PendingChanges, SyncProgress } from "../types";
import { GitManager, GitConflictError } from "./GitManager";
import type { ProgressFn } from "./GitManager";
import { ensureRemoteBranch, parseOwnerRepo } from "./githubApi";
import type { TokenProvider } from "../auth/TokenProvider";
import type { ToolCallBackend } from "../ai/piBackends";
import type { EventLog } from "../observability/EventLog";
import { wrapGitWithLogging } from "./loggedGit";

// Direct `fs` use is bounded to: (a) the submodule's working-tree
// directory under `<vault>/<localPath>`, and (b) the submodule's git
// metadata under `<vault>/.git/modules/<localPath>/`. Both are inside
// the user's vault and invisible to Obsidian's Vault API. Module load
// is gated by `Platform.isDesktop` in `node-builtins.ts`.

export class SubmoduleManager {
  private git: SimpleGit;
  private gitManagers = new Map<string, GitManager>();

  constructor(
    private vaultPath: string,
    private user: string,
    private email: string,
    private tokenProvider: TokenProvider,
    private configDir: string,
    private backends: ToolCallBackend[] = [],
    private eventLog: EventLog | null = null,
  ) {
    const raw = makeGit(vaultPath);
    this.git = eventLog ? wrapGitWithLogging(raw, eventLog, "main") : raw;
  }

  /**
   * Write a per-owner `insteadOf` rewrite into `git`'s config so a raw
   * submodule op (clone via parent, branch push in the submodule's own
   * gitdir) authenticates. Submodule gitdirs have their own config, so the
   * parent's rewrites don't reach them — this closes that gap explicitly.
   */
  private async writeOwnerCred(git: SimpleGit, url: string): Promise<void> {
    const p = parseOwnerRepo(url);
    if (!p) return;
    let token = "";
    try {
      token = await this.tokenProvider.getTokenForOwner(p.owner);
    } catch {
      return; // no installation / mint failed — let git surface the auth error
    }
    if (!token) return;
    // Clear any stale rewrites for this owner first (rotated tokens leave
    // distinct, ambiguous config keys), then write the current one.
    try {
      const listing = await git.raw([
        "config", "--local", "--name-only", "--get-regexp", "^url\\..*\\.insteadof$",
      ]);
      for (const key of listing.split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (key.includes(`@github.com/${p.owner}/`)) {
          await git.raw(["config", "--local", "--remove-section", key.replace(/\.insteadof$/i, "")]).catch(() => {});
        }
      }
    } catch { /* none present */ }
    const gitUser = this.tokenProvider.gitUser();
    await git
      .addConfig(
        `url.https://${gitUser}:${token}@github.com/${p.owner}/.insteadOf`,
        `https://github.com/${p.owner}/`,
      )
      .catch(() => {});
  }

  /**
   * Build a `-c url.<...>.insteadOf=...` flag for the owner of `url`, with
   * the current token embedded. Passing the rewrite on the command line
   * (rather than only into the parent's local config) is what makes it
   * reach `git submodule add`'s clone subprocess: `-c` settings export to
   * subprocesses via GIT_CONFIG_PARAMETERS, whereas the parent's local
   * `.git/config` rewrite is not reliably read there (notably on Windows,
   * where the fallback then hits Git Credential Manager's account picker).
   */
  private async ownerInsteadOfFlags(url: string): Promise<string[]> {
    const p = parseOwnerRepo(url);
    if (!p) return [];
    let token = "";
    try {
      token = await this.tokenProvider.getTokenForOwner(p.owner);
    } catch {
      return [];
    }
    if (!token) return [];
    const gitUser = this.tokenProvider.gitUser();
    return [
      "-c",
      `url.https://${gitUser}:${token}@github.com/${p.owner}/.insteadOf=https://github.com/${p.owner}/`,
    ];
  }

  // ── Submodule lifecycle ──────────────────────────────────────────

  async add(config: SubmoduleConfig): Promise<void> {
    // The submoduleAdd clone runs as a subprocess. Write the owner's rewrite
    // into local config (for later submodule-gitdir ops) AND pass it as a
    // -c flag so the clone subprocess itself authenticates with the token
    // instead of falling back to a credential helper (Windows GCM picker).
    await this.writeOwnerCred(this.git, config.remoteUrl);
    const credFlags = await this.ownerInsteadOfFlags(config.remoteUrl);
    if (credFlags.length) {
      await this.git.raw([...credFlags, "submodule", "add", config.remoteUrl, config.localPath]);
      await this.git.raw([...credFlags, "submodule", "update", "--init", config.localPath]);
    } else {
      await this.git.submoduleAdd(config.remoteUrl, config.localPath);
      await this.git.submoduleUpdate(["--init", config.localPath]);
    }
    await this.alignSubmoduleToBranch(config);
  }

  /**
   * Bring the freshly-cloned submodule onto the requested branch.
   *
   * `git submodule add <url> <path>` always checks out the remote's
   * default branch — it doesn't read `config.branch`. So when the user
   * asks for a non-default branch (existing or not), the submodule's
   * local HEAD diverges from what later syncs try to push, producing
   * "src refspec <branch> does not match any" on first push.
   *
   * This method makes the two sides match:
   *   1. Create the branch on the remote via the GitHub Git Refs API
   *      if it doesn't exist yet (based on the repo's default branch).
   *   2. Locally check out (or create) that branch and push --set-upstream.
   *   3. Record `submodule.<path>.branch` in .gitmodules so other clones
   *      (`git submodule update --remote`) track the right branch too.
   *
   * All steps are best-effort: a failure here doesn't unwind the add,
   * since the submodule is already registered and the next sync's
   * recovery agent can finish the alignment.
   */
  private async alignSubmoduleToBranch(config: SubmoduleConfig): Promise<void> {
    const subPath = `${this.vaultPath}/${config.localPath}`;
    const subGit = makeGit(subPath);
    const current = await subGit.revparse(["--abbrev-ref", "HEAD"]).then((s) => s.trim()).catch(() => "");
    if (!current || current === config.branch) {
      await this.recordSubmoduleBranch(config).catch(() => {});
      return;
    }

    const ownerParsed = parseOwnerRepo(config.remoteUrl);
    let subToken = "";
    if (ownerParsed) {
      try {
        subToken = await this.tokenProvider.getTokenForOwner(ownerParsed.owner);
      } catch { /* no installation — handled below */ }
    }
    if (subToken) {
      try {
        await ensureRemoteBranch(config.remoteUrl, config.branch, subToken);
      } catch (e) {
        console.warn("[agentic-git-sync] ensureRemoteBranch (submodule) failed:", (e as Error).message);
      }
    }

    // Ensure the submodule's own gitdir can authenticate the branch push.
    await this.writeOwnerCred(subGit, config.remoteUrl);

    // Try to track the (now-)existing remote branch; fall back to
    // creating a fresh local branch off the current HEAD.
    const checkedOut = await subGit
      .raw(["checkout", "-B", config.branch, `origin/${config.branch}`])
      .then(() => true)
      .catch(() => false);
    if (!checkedOut) {
      await subGit.raw(["checkout", "-B", config.branch]).catch(() => {});
    }
    await subGit
      .raw(["push", "--set-upstream", "origin", config.branch])
      .catch((e) => {
        console.warn("[agentic-git-sync] submodule branch push failed:", (e as Error).message);
      });

    await this.recordSubmoduleBranch(config).catch(() => {});
  }

  /** Record `submodule.<path>.branch = <branch>` in the parent's .gitmodules. */
  private async recordSubmoduleBranch(config: SubmoduleConfig): Promise<void> {
    await this.git.raw([
      "config", "-f", ".gitmodules",
      `submodule.${config.localPath}.branch`,
      config.branch,
    ]);
  }

  async remove(localPath: string): Promise<void> {
    // Standard submodule removal:
    //   1. deinit (remove working tree)
    //   2. git rm (remove from index + .gitmodules)
    //   3. fs.rm .git/modules/<path>   (NOT `git rm` — that path isn't tracked)
    await this.git.raw(["submodule", "deinit", "-f", "--", localPath]).catch(() => {});
    await this.git.raw(["rm", "-r", "-f", "--", localPath]).catch(() => {});
    try {
      fs.rmSync(`${this.vaultPath}/.git/modules/${localPath}`, {
        recursive: true,
        force: true,
      });
    } catch { /* may not exist */ }
    try {
      fs.rmSync(`${this.vaultPath}/${localPath}`, { recursive: true, force: true });
    } catch { /* already gone */ }
    // Cache is keyed by id (not path) and we don't have it here. Easiest:
    // clear all — they'll be re-created lazily on next access.
    this.gitManagers.clear();
  }

  /**
   * Ensure every submodule declared in `configs` is checked out locally.
   *
   * Called on plugin load: a fresh clone of the vault may have `.gitmodules`
   * entries but no checked-out content (user didn't pass `--recursive`).
   * Idempotent — does nothing for submodules already present.
   *
   * Returns the list of paths that were newly initialized.
   */
  async ensureInitialized(
    configs: SubmoduleConfig[],
    onProgress?: (msg: string) => void
  ): Promise<string[]> {
    if (configs.length === 0) return [];

    // Need the parent vault to be a git repo before we can manage submodules.
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) return [];

    const newly: string[] = [];
    const gitmodulesPath = `${this.vaultPath}/.gitmodules`;
    const registeredPaths = new Set(
      fs.existsSync(gitmodulesPath)
        ? parseGitmodules(fs.readFileSync(gitmodulesPath, "utf8"))
            .map((e) => e.path)
            .filter(Boolean)
        : []
    );

    for (const c of configs) {
      const subDir = `${this.vaultPath}/${c.localPath}`;
      const hasContent = fs.existsSync(`${subDir}/.git`);
      if (hasContent) continue;

      onProgress?.(`Initializing ${c.localPath}…`);
      const inGitmodules = registeredPaths.has(c.localPath);
      try {
        if (inGitmodules) {
          // Parent already knows about this submodule — just clone + checkout.
          await this.git.raw(["submodule", "update", "--init", "--", c.localPath]);
        } else {
          // Out-of-band config (e.g., recreated from .github-sync.json).
          // Register the submodule with the parent, then init.
          await this.git.submoduleAdd(c.remoteUrl, c.localPath);
          await this.git.raw(["submodule", "update", "--init", "--", c.localPath]);
        }
        newly.push(c.localPath);
      } catch (e) {
        // Don't let one bad submodule block the rest. Surface via progress.
        onProgress?.(`Failed to init ${c.localPath}: ${(e as Error).message}`);
      }
    }
    return newly;
  }

  // ── Rename handling ──────────────────────────────────────────────

  /**
   * Updates all git configuration that refers to a submodule's old path
   * after the folder has been renamed on disk:
   *   1. `.gitmodules`                    — path and section header
   *   2. `.git/config`                    — section header (git submodule sync
   *                                         only updates the URL, not the name)
   *   3. `.git/modules/<oldPath>/config`  — worktree back-pointer
   *   4. `.git/modules/<oldPath>/`        — rename the directory itself
   *   5. working tree `.git` gitfile      — update gitdir pointer
   *   6. `git submodule sync`             — syncs URL in .git/config as backup
   *   7. cached GitManager               — evicted so next sync uses new path
   */
  async renameSubmodulePath(oldPath: string, newPath: string, configId?: string): Promise<void> {
    // Helper: renames [submodule "old"] → [submodule "new"] and
    // any `path = old` / `worktree = ...old` lines in an ini-style file.
    const renameSectionHeader = (src: string) =>
      src.replace(
        new RegExp(`(\\[submodule\\s+")${escapeGitPath(oldPath)}("\\])`, "g"),
        `$1${newPath}$2`,
      );
    const renamePathValue = (src: string) =>
      src.replace(
        new RegExp(`(path\\s*=\\s*)${escapeGitPath(oldPath)}`, "g"),
        `$1${newPath}`,
      );

    // 1. Update .gitmodules
    const gitmodulesFile = `${this.vaultPath}/.gitmodules`;
    if (fs.existsSync(gitmodulesFile)) {
      let src = fs.readFileSync(gitmodulesFile, "utf8");
      src = renameSectionHeader(src);
      src = renamePathValue(src);
      fs.writeFileSync(gitmodulesFile, src, "utf8");
    }

    // 2. Update .git/config — git submodule sync only rewrites the URL
    //    inside an existing section; it does NOT rename the section header
    //    itself. We must do that manually.
    const gitConfigFile = `${this.vaultPath}/.git/config`;
    if (fs.existsSync(gitConfigFile)) {
      let src = fs.readFileSync(gitConfigFile, "utf8");
      src = renameSectionHeader(src);
      fs.writeFileSync(gitConfigFile, src, "utf8");
    }

    // 3. Fix the worktree back-pointer in the module's own config.
    //    e.g. worktree = ../../../../Z0-Resources/old-name
    const moduleCfg = `${this.vaultPath}/.git/modules/${oldPath}/config`;
    if (fs.existsSync(moduleCfg)) {
      const lines = fs.readFileSync(moduleCfg, "utf8").split("\n");
      const updated = lines.map((line) =>
        /^\s*worktree\s*=/.test(line)
          ? line.replace(new RegExp(escapeGitPath(oldPath)), newPath)
          : line
      );
      fs.writeFileSync(moduleCfg, updated.join("\n"), "utf8");
    }

    // 4. Rename the module directory so its name stays consistent with the
    //    submodule path (purely cosmetic, but avoids a stale old-name dir).
    const oldModuleDir = `${this.vaultPath}/.git/modules/${oldPath}`;
    const newModuleDir = `${this.vaultPath}/.git/modules/${newPath}`;
    if (fs.existsSync(oldModuleDir) && !fs.existsSync(newModuleDir)) {
      fs.mkdirSync(path.dirname(newModuleDir), { recursive: true });
      fs.renameSync(oldModuleDir, newModuleDir);

      // 5. Update the .git gitfile inside the working tree to point at the
      //    renamed module directory.
      const gitFile = `${this.vaultPath}/${newPath}/.git`;
      if (fs.existsSync(gitFile)) {
        const src = fs.readFileSync(gitFile, "utf8");
        fs.writeFileSync(
          gitFile,
          src.replace(
            new RegExp(`\\.git/modules/${escapeGitPath(oldPath)}`),
            `.git/modules/${newPath}`,
          ),
          "utf8",
        );
      }
    }

    // 6. Evict the cached GitManager so the next sync recreates it with
    //    the new path instead of running git against the now-gone old path.
    if (configId) this.gitManagers.delete(configId);
  }

  // ── .gitmodules as source of truth ──────────────────────────────

  /**
   * Add `pluginid = <id>` to every .gitmodules entry that doesn't have one
   * yet. Run once on startup so subsequent reconcile calls can use the stable
   * id-based lookup instead of fragile path-based matching.
   */
  async ensurePluginIds(configs: SubmoduleConfig[]): Promise<void> {
    const gitmodulesPath = path.join(this.vaultPath, ".gitmodules");
    if (!fs.existsSync(gitmodulesPath)) return;
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) return;

    let content = fs.readFileSync(gitmodulesPath, "utf8");
    const entries = parseGitmodules(content);
    let changed = false;

    for (const cfg of configs) {
      const entry = entries.find((e) => e.pluginid === cfg.id || e.path === cfg.localPath);
      if (!entry || entry.pluginid) continue;
      // Insert pluginid line right after the [submodule "..."] header.
      const header = `[submodule "${entry.sectionName}"]`;
      content = content.replace(header, `${header}\n\tpluginid = ${cfg.id}`);
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(gitmodulesPath, content, "utf8");
      await this.git.add(".gitmodules").catch(() => {});
    }
  }

  /**
   * Read .gitmodules and return a copy of `configs` with `localPath` and
   * `remoteUrl` updated to match. Matches entries by `pluginid` first
   * (stable across renames), falling back to `path` for entries without it.
   *
   * Call this after any operation that may have changed .gitmodules on disk
   * (sync, rename, pull) and after the initial plugin load.
   */
  reconcileConfigs(configs: SubmoduleConfig[]): SubmoduleConfig[] {
    const gitmodulesPath = path.join(this.vaultPath, ".gitmodules");
    if (!fs.existsSync(gitmodulesPath)) return configs;

    const entries = parseGitmodules(fs.readFileSync(gitmodulesPath, "utf8"));
    const byPluginId = new Map(entries.filter((e) => e.pluginid).map((e) => [e.pluginid, e]));
    const byPath = new Map(entries.filter((e) => e.path).map((e) => [e.path, e]));

    return configs.map((cfg) => {
      const entry = byPluginId.get(cfg.id) ?? byPath.get(cfg.localPath);
      if (!entry) return cfg;
      const localPath = entry.path ?? cfg.localPath;
      const remoteUrl = entry.url ?? cfg.remoteUrl;
      if (localPath === cfg.localPath && remoteUrl === cfg.remoteUrl) return cfg;
      return { ...cfg, localPath, remoteUrl };
    });
  }

  // ── Rename detection (OS-level renames bypass Obsidian events) ───

  /**
   * For each config whose localPath no longer exists on disk, scans the
   * vault for a folder whose .git gitfile points to
   * .git/modules/<configuredLocalPath>. That gitfile is written at
   * submodule-init time and is never updated on a plain folder rename,
   * making it a reliable fingerprint of the original path.
   *
   * Returns pairs of {config, newPath} for every submodule whose new
   * location was found. The caller is responsible for updating settings.
   */
  async detectRenamedPaths(
    configs: SubmoduleConfig[]
  ): Promise<Array<{ config: SubmoduleConfig; newPath: string }>> {
    const missing = configs.filter(
      (c) => !fs.existsSync(`${this.vaultPath}/${c.localPath}`)
    );
    if (missing.length === 0) return [];

    // Collect all .git gitfiles (files, not directories) in the vault.
    // Skips .git/ dirs and node_modules to keep the scan fast.
    const gitfiles: string[] = [];
    const scanDir = (dir: string, depth: number) => {
      if (depth > 8) return;
      let entries: string[];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name === "node_modules") continue;
        const full = `${dir}/${name}`;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (name === ".git") continue; // skip .git/ dirs
            scanDir(full, depth + 1);
          } else if (name === ".git") {
            gitfiles.push(full); // .git file inside a submodule
          }
        } catch { /* permission errors, broken symlinks */ }
      }
    };
    scanDir(this.vaultPath, 0);

    const results: Array<{ config: SubmoduleConfig; newPath: string }> = [];
    for (const gitfile of gitfiles) {
      let content: string;
      try { content = fs.readFileSync(gitfile, "utf8").trim(); } catch { continue; }
      // Format: "gitdir: ../.git/modules/folder/sub-folder"
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) continue;
      const gitdirVal = match[1].trim();
      // Extract the path after "modules/"
      const modulesIdx = gitdirVal.indexOf(".git/modules/");
      if (modulesIdx === -1) continue;
      const originalPath = gitdirVal.slice(modulesIdx + ".git/modules/".length).replace(/\\/g, "/");

      const cfg = missing.find((c) => c.localPath === originalPath);
      if (!cfg) continue;

      // The folder containing the .git gitfile is the new submodule root.
      const newAbsPath = gitfile.slice(0, -"/.git".length);
      const newPath = newAbsPath.slice(this.vaultPath.length + 1); // relative to vault
      results.push({ config: cfg, newPath });
    }
    return results;
  }

  // ── Git ops: delegated to per-submodule GitManager ───────────────

  async listChanges(config: SubmoduleConfig): Promise<PendingChanges> {
    return this.getSubGM(config).listChanges();
  }

  async listConflicts(config: SubmoduleConfig): Promise<string[]> {
    return this.getSubGM(config).listConflicts();
  }

  async stagePath(config: SubmoduleConfig, file: string): Promise<void> {
    return this.getSubGM(config).stagePath(file);
  }

  /**
   * Repoint a submodule at a new remote URL. Updates both sides:
   *   - Parent's `.gitmodules` (`submodule.<path>.url`)
   *   - Submodule's own `remote.origin.url`
   *
   * Runs `git submodule sync` so any cached refspec inside `.git/config`
   * picks up the new URL. Does not fetch or push — the caller's next
   * sync handles that.
   */
  async setRemoteUrl(config: SubmoduleConfig, newUrl: string): Promise<void> {
    // Parent .gitmodules — the source of truth for what URL fresh clones use.
    await this.git.raw([
      "config", "-f", ".gitmodules",
      `submodule.${config.localPath}.url`, newUrl,
    ]);
    // Apply to existing .git/config of the submodule via `submodule sync`.
    await this.git.raw(["submodule", "sync", "--", config.localPath]);
    // Also set it directly inside the submodule, in case `submodule sync`
    // skipped this entry (it sometimes does when the path looks odd).
    const subGit = makeGit(`${this.vaultPath}/${config.localPath}`);
    await subGit.remote(["set-url", "origin", newUrl]).catch(() => { /* origin may have been remapped already */ });
    // Drop the cached per-submodule GitManager — its `insteadOf` config
    // was set up against the old URL; new one will be initialised on
    // next access with the new URL in scope.
    this.gitManagers.delete(config.id);
  }

  async abortMerge(config: SubmoduleConfig): Promise<void> {
    return this.getSubGM(config).abortMerge();
  }

  // ── Sync ─────────────────────────────────────────────────────────

  async syncOne(config: SubmoduleConfig, onProgress?: ProgressFn): Promise<number> {
    const subDir = `${this.vaultPath}/${config.localPath}`;
    if (!fs.existsSync(`${subDir}/.git`)) {
      await this.ensureInitialized([config], (msg) =>
        onProgress?.({ phase: "pulling", message: msg })
      );
      // If init failed (e.g. remote not found), the directory will have been
      // cleaned up by git. Surface a clear error rather than letting simpleGit
      // throw "Cannot use simple-git on a directory that does not exist".
      if (!fs.existsSync(`${subDir}/.git`)) {
        throw new Error(
          `Submodule "${config.localPath}" could not be initialised. ` +
          `Check that the remote URL is accessible: ${config.remoteUrl}`
        );
      }
    }
    const count = await this.getSubGM(config).sync({
      branch: config.branch,
      upstreamBranch: config.upstreamBranch,
      remoteUrl: config.remoteUrl,
      onProgress,
      // The vault config dir (e.g. `.obsidian`) is a vault-root artifact and
      // must never be committed inside a submodule, even if Obsidian
      // accidentally creates one there (e.g. during a folder rename).
      ignorePatterns: [`${this.configDir}/**`],
    });
    await this.updateParentPointer(config);
    return count;
  }

  /** Commit staged conflict resolution and push — both submodule and parent pointer. */
  async commitMergedAndPush(
    config: SubmoduleConfig,
    message: string,
    onProgress?: ProgressFn
  ): Promise<number> {
    const count = await this.getSubGM(config).commitMergedAndPush(
      config.branch,
      message,
      onProgress
    );
    await this.updateParentPointer(config);
    return count;
  }

  // ── Bulk ─────────────────────────────────────────────────────────

  async syncAll(
    configs: SubmoduleConfig[],
    onProgress?: (id: string, p: SyncProgress) => void
  ): Promise<Map<string, { ok: true; count: number } | { ok: false; error: Error }>> {
    const results = new Map<string, { ok: true; count: number } | { ok: false; error: Error }>();
    const active = configs.filter((c) => c.autoSync);

    await Promise.allSettled(
      active.map(async (c) => {
        try {
          const count = await this.syncOne(c, (p) => onProgress?.(c.id, p));
          results.set(c.id, { ok: true, count });
          onProgress?.(c.id, { phase: "synced" });
        } catch (e) {
          results.set(c.id, { ok: false, error: e as Error });
          onProgress?.(c.id, {
            phase: e instanceof GitConflictError ? "conflict" : "error",
            message: (e as Error).message,
            conflicts: e instanceof GitConflictError ? e.conflicts : undefined,
          });
        }
      })
    );

    return results;
  }

  // ── Private ──────────────────────────────────────────────────────

  /** Returns (creating if needed) a GitManager scoped to the submodule path. */
  gitManagerFor(config: SubmoduleConfig): GitManager {
    return this.getSubGM(config);
  }

  private getSubGM(config: SubmoduleConfig): GitManager {
    let gm = this.gitManagers.get(config.id);
    if (!gm) {
      gm = new GitManager(
        `${this.vaultPath}/${config.localPath}`,
        this.user,
        this.email,
        this.tokenProvider,
        this.configDir,
        this.backends,
        this.eventLog,
        config.id,
      );
      this.gitManagers.set(config.id, gm);
    }
    return gm;
  }

  /**
   * Stage the updated submodule pointer in the parent vault and commit it.
   * Push attempts are *best-effort* and never thrown.
   *
   * If we re-threw on push failure here, a successful submodule sync
   * would be reported to the user as a failure whenever the parent
   * vault's remote rejects the push (typical case: the user can push
   * to the submodule's repo but not to the main vault's repo). The
   * commit stays in the parent's local history regardless, so the next
   * vault sync will pick it up and surface that push failure where it
   * actually belongs — under the vault, not the submodule.
   */
  private async updateParentPointer(config: SubmoduleConfig): Promise<void> {
    await this.git.add(config.localPath);
    const status = await this.git.status();
    if (status.staged.length === 0) return;
    await this.git.commit(`chore: update submodule ${config.localPath}`);
    const branch = (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
    if (branch && branch !== "HEAD") {
      await this.git
        .raw(["push", "--set-upstream", "origin", branch])
        .catch((e) => {
          console.warn(
            "[agentic-git-sync] couldn't push parent pointer for submodule",
            config.localPath,
            "—",
            (e as Error).message,
            "(will retry on next vault sync)"
          );
        });
    }
  }
}

// Validation helpers exposed for UI use.
export function isValidGitHubUrl(url: string): boolean {
  if (!url) return false;
  return /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?\/?|git@github\.com:[\w.-]+\/[\w.-]+(\.git)?)$/.test(
    url.trim()
  );
}

export function normalizeRepoPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/** Escapes special regex characters in a file-system path for use in RegExp. */
function escapeGitPath(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface GitmodulesEntry {
  sectionName: string;
  path?: string;
  url?: string;
  branch?: string;
  pluginid?: string;
}

/**
 * Parse a .gitmodules file into structured entries.
 * Handles standard INI format: [submodule "name"] sections with key = value lines.
 * Unknown keys (like pluginid) are preserved — git ignores them.
 */
function parseGitmodules(content: string): GitmodulesEntry[] {
  const entries: GitmodulesEntry[] = [];
  let current: GitmodulesEntry | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[submodule\s+"(.+?)"\]$/);
    if (section) {
      if (current) entries.push(current);
      current = { sectionName: section[1] };
      continue;
    }
    if (!current) continue;
    const kv = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kv) (current as unknown as Record<string, string>)[kv[1]] = kv[2].trim();
  }
  if (current) entries.push(current);
  return entries;
}
