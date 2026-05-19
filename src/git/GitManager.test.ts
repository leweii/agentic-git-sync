/* eslint-disable obsidianmd/no-nodejs-modules -- test harness runs in Node, not shipped in main.js */
/**
 * Integration tests for GitManager — real git repos in temp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { GitManager, GitConflictError } from "./GitManager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghs-test-"));
}

function rm(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(dir: string, file: string, content: string) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), "utf8");
}

function exists(dir: string, ...parts: string[]): boolean {
  return fs.existsSync(path.join(dir, ...parts));
}

function git(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, shell: "/bin/sh", stdio: "pipe" }).toString();
}

/** Create an empty bare remote. */
function makeRemote(): string {
  const dir = tmp();
  git(dir, "git init --bare");
  return dir;
}

/**
 * Create a bare remote that already has commits (simulates GitHub repo
 * initialised with a README — no shared history with a fresh local vault).
 */
function makeRemoteWithCommit(fileName = "README.md", content = "# README"): string {
  const work = tmp();
  const bare = tmp();
  git(bare, "git init --bare");
  git(work, "git init");
  git(work, 'git config user.name "Remote" && git config user.email "r@r.com"');
  write(work, fileName, content);
  git(work, `git add . && git commit -m "init" && git remote add origin ${bare} && git push -u origin HEAD:main`);
  rm(work);
  return bare;
}

function makeGM(vaultPath: string): GitManager {
  return new GitManager(vaultPath, "Test", "test@test.com", "", ".obsidian");
}

function findResiduals(dir: string): string[] {
  const re = /~[0-9a-f]{40}$/;
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (re.test(entry.name)) {
      found.push(entry.name);
    } else if (entry.isDirectory() && entry.name !== ".git") {
      found.push(...findResiduals(path.join(dir, entry.name)));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. purgeGitResidualPaths
// ---------------------------------------------------------------------------

describe("purgeGitResidualPaths()", () => {
  let vault: string;

  beforeEach(() => {
    vault = tmp();
    git(vault, "git init && git checkout -b main");
    git(vault, 'git config user.name "T" && git config user.email "t@t.com"');
  });

  afterEach(() => rm(vault));

  it("removes a file ending in ~<40-hex>", () => {
    const hash = "a".repeat(40);
    write(vault, `residual~${hash}`, "junk");

    const gm = makeGM(vault);
    // @ts-expect-error private
    gm.purgeGitResidualPaths();

    expect(exists(vault, `residual~${hash}`)).toBe(false);
  });

  it("removes a directory ending in ~<40-hex>", () => {
    const hash = "b".repeat(40);
    const dir = path.join(vault, `.obsidian/plugins/plugin~${hash}`);
    fs.mkdirSync(dir, { recursive: true });
    write(vault, `.obsidian/plugins/plugin~${hash}/main.js`, "code");

    const gm = makeGM(vault);
    // @ts-expect-error private
    gm.purgeGitResidualPaths();

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("leaves normal files and directories untouched", () => {
    write(vault, "note.md", "hello");
    write(vault, ".obsidian/plugins/my-plugin/main.js", "code");

    const gm = makeGM(vault);
    // @ts-expect-error private
    gm.purgeGitResidualPaths();

    expect(exists(vault, "note.md")).toBe(true);
    expect(exists(vault, ".obsidian/plugins/my-plugin/main.js")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1b. isMidMerge — gitfile (submodule) support
// ---------------------------------------------------------------------------

describe("isMidMerge() — gitfile (submodule) path", () => {
  let vault: string;
  let gitModulesDir: string;

  beforeEach(() => {
    // Simulate a git submodule: .git is a file pointing to an external git dir.
    vault = tmp();
    gitModulesDir = tmp(); // acts as .git/modules/sub-name/
    git(gitModulesDir, "git init --bare");

    // Write gitfile
    fs.writeFileSync(
      path.join(vault, ".git"),
      `gitdir: ${gitModulesDir}\n`
    );
  });

  afterEach(() => {
    rm(vault);
    rm(gitModulesDir);
  });

  it("returns false when MERGE_HEAD does not exist", () => {
    const gm = makeGM(vault);
    // @ts-expect-error private
    expect(gm.isMidMerge()).toBe(false);
  });

  it("returns true when MERGE_HEAD exists in the real git dir", () => {
    fs.writeFileSync(path.join(gitModulesDir, "MERGE_HEAD"), "abc123\n");
    const gm = makeGM(vault);
    // @ts-expect-error private
    expect(gm.isMidMerge()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. autoResolveSystemFiles — decision logic (no real merge state needed)
// ---------------------------------------------------------------------------

describe("autoResolveSystemFiles() — remaining list", () => {
  let vault: string;

  beforeEach(() => {
    vault = tmp();
    git(vault, "git init && git checkout -b main");
    git(vault, 'git config user.name "T" && git config user.email "t@t.com"');
    write(vault, "init.md", "init");
    git(vault, "git add . && git commit -m 'init'");
  });

  afterEach(() => rm(vault));

  it("passes user notes through to remaining", async () => {
    const gm = makeGM(vault);
    const remaining = await gm.autoResolveSystemFiles(["notes/important.md", "journal.md"]);
    expect(remaining).toContain("notes/important.md");
    expect(remaining).toContain("journal.md");
  });

  it("does not pass .DS_Store through to remaining", async () => {
    const gm = makeGM(vault);
    const remaining = await gm.autoResolveSystemFiles([".DS_Store"]);
    expect(remaining).not.toContain(".DS_Store");
  });

  it("does not pass .github-sync.json through to remaining", async () => {
    const gm = makeGM(vault);
    const remaining = await gm.autoResolveSystemFiles([".github-sync.json"]);
    expect(remaining).not.toContain(".github-sync.json");
  });

  it("does not pass .obsidian/plugins/** through to remaining", async () => {
    const gm = makeGM(vault);
    const remaining = await gm.autoResolveSystemFiles([
      ".obsidian/plugins/my-plugin/main.js",
      ".obsidian/plugins/other/manifest.json",
    ]);
    expect(remaining).toHaveLength(0);
  });

  it("separates user files from system files correctly", async () => {
    const gm = makeGM(vault);
    const remaining = await gm.autoResolveSystemFiles([
      ".DS_Store",
      ".github-sync.json",
      ".obsidian/plugins/x/main.js",
      "my-note.md",
      "Projects/work.md",
    ]);
    expect(remaining).toEqual(["my-note.md", "Projects/work.md"]);
  });
});

// ---------------------------------------------------------------------------
// 3. sync() — new vault, empty remote
// ---------------------------------------------------------------------------

describe("sync() — new vault, empty remote", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    vault = tmp();
    remote = makeRemote();
    write(vault, "note.md", "# Hello");
    write(vault, ".DS_Store", "binary noise");
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("completes without error", async () => {
    const gm = makeGM(vault);
    await expect(gm.sync({ branch: "main", remoteUrl: remote })).resolves.not.toThrow();
  });

  it("creates an initial commit containing the note", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });

    const log = git(vault, "git log --oneline");
    expect(log).toMatch(/initial vault commit/);

    const tracked = git(vault, "git ls-files");
    expect(tracked).toContain("note.md");
  });

  it("does not commit .DS_Store", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });

    const tracked = git(vault, "git ls-files");
    expect(tracked).not.toContain(".DS_Store");
  });

  it("creates .gitignore with standard exclusions", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });

    const gi = read(vault, ".gitignore");
    expect(gi).toContain(".DS_Store");
    expect(gi).toContain(".obsidian/");
    expect(gi).toContain(".trash/");
  });

  it("pushes to remote — remote has the commit", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });

    const remoteFiles = git(remote, "git ls-tree -r --name-only main");
    expect(remoteFiles).toContain("note.md");
  });

  it("no MERGE_HEAD after sync", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });

    expect(exists(vault, ".git/MERGE_HEAD")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. sync() — new vault, remote already has commits (unrelated histories)
// ---------------------------------------------------------------------------

describe("sync() — new vault, remote has existing commit (unrelated histories)", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    remote = makeRemoteWithCommit("README.md", "# Remote README");
    vault = tmp();
    write(vault, "note.md", "# My Note");
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("completes without throwing", async () => {
    const gm = makeGM(vault);
    await expect(gm.sync({ branch: "main", remoteUrl: remote })).resolves.not.toThrow();
  });

  it("local note is preserved after sync", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });
    expect(exists(vault, "note.md")).toBe(true);
  });

  it("remote README is pulled in", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });
    expect(exists(vault, "README.md")).toBe(true);
  });

  it("no MERGE_HEAD remains (merge is committed)", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });
    expect(exists(vault, ".git/MERGE_HEAD")).toBe(false);
  });

  it("both files exist on remote after push", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });

    const files = git(remote, "git ls-tree -r --name-only main");
    expect(files).toContain("note.md");
    expect(files).toContain("README.md");
  });
});

// ---------------------------------------------------------------------------
// 5. sync() — new vault, remote has conflicting user file → GitConflictError
// ---------------------------------------------------------------------------

describe("sync() — new vault, conflicting user file with remote", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    remote = makeRemoteWithCommit("note.md", "REMOTE VERSION of note");
    vault = tmp();
    write(vault, "note.md", "LOCAL VERSION of note");
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("throws GitConflictError", async () => {
    const gm = makeGM(vault);
    await expect(gm.sync({ branch: "main", remoteUrl: remote })).rejects.toThrow(GitConflictError);
  });

  it("conflict list contains note.md", async () => {
    const gm = makeGM(vault);
    let conflicts: string[] = [];
    try {
      await gm.sync({ branch: "main", remoteUrl: remote });
    } catch (e) {
      if (e instanceof GitConflictError) conflicts = e.conflicts;
    }
    expect(conflicts).toContain("note.md");
  });
});

// ---------------------------------------------------------------------------
// 6. sync() — remote has .obsidian/plugins committed (file/dir conflict)
// ---------------------------------------------------------------------------

describe("sync() — remote has .obsidian/plugins committed", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    const work = tmp();
    remote = tmp();
    git(remote, "git init --bare");
    git(work, "git init");
    git(work, 'git config user.name "R" && git config user.email "r@r.com"');
    write(work, ".obsidian/plugins/some-plugin/main.js", "remote plugin code");
    write(work, "README.md", "readme");
    git(work, `git add . && git commit -m "init" && git remote add origin ${remote} && git push -u origin HEAD:main`);
    rm(work);

    vault = tmp();
    write(vault, "note.md", "my note");
    // Local vault also has .obsidian/plugins as a directory (normal install)
    write(vault, ".obsidian/plugins/some-plugin/main.js", "local plugin code");
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("completes without throwing (plugins are system files)", async () => {
    const gm = makeGM(vault);
    await expect(gm.sync({ branch: "main", remoteUrl: remote })).resolves.not.toThrow();
  });

  it("no ~<hash> residual paths remain after sync", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });
    expect(findResiduals(vault)).toHaveLength(0);
  });

  it("no MERGE_HEAD remains after sync", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });
    expect(exists(vault, ".git/MERGE_HEAD")).toBe(false);
  });

  it("user note is preserved", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main", remoteUrl: remote });
    expect(exists(vault, "note.md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Post-conflict-resolution: next sync commits pending merge and succeeds
//
// Scenario: User 2 resolved a conflict in ConflictModal (files written +
// staged, but NOT committed — modal says "next sync will commit and push").
// MERGE_HEAD exists. status.conflicted is empty.
//
// Expected: next sync() detects the pending merge, commits it, and pushes.
// Must NOT re-surface a fake GitConflictError.
// ---------------------------------------------------------------------------

describe("sync() — pending merge after ConflictModal resolution", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    // Shared remote with an initial commit (v1)
    remote = tmp();
    git(remote, "git init --bare");

    const base = tmp();
    git(base, "git init");
    git(base, 'git config user.name "B" && git config user.email "b@b.com"');
    write(base, "note.md", "v1 original");
    git(base, `git add . && git commit -m "v1" && git remote add origin ${remote} && git push -u origin HEAD:main`);
    rm(base);

    // User 2 clones v1 and commits v3 BEFORE User 1 pushes, so local and
    // remote genuinely diverge from v1.
    vault = tmp();
    git(vault, "git init");
    git(vault, 'git config user.name "U2" && git config user.email "u2@u.com"');
    git(vault, `git remote add origin ${remote} && git fetch origin && git checkout -b main origin/main`);
    write(vault, "note.md", "v3 from user2");
    git(vault, "git add . && git commit -m 'u2 edit'");
    // vault is at v3 (based on v1), not yet pushed

    // User 1 now pushes v2 to remote — remote diverges from vault's history
    const user1 = tmp();
    git(user1, "git init");
    git(user1, 'git config user.name "U1" && git config user.email "u1@u.com"');
    git(user1, `git remote add origin ${remote} && git fetch origin && git checkout -b main origin/main`);
    write(user1, "note.md", "v2 from user1");
    git(user1, "git add . && git commit -m 'u1 edit' && git push origin main");
    rm(user1);

    // User 2 fetches — origin/main (v2) and local main (v3) both derive from v1
    git(vault, "git fetch origin");

    // Simulate the sync conflict: merge → conflict (use merge not pull to
    // guarantee MERGE_HEAD is created, not a rebase).
    try {
      execSync("git merge origin/main", { cwd: vault, shell: "/bin/sh", stdio: "pipe" });
    } catch { /* expected conflict */ }

    // ConflictModal resolution: accept remote (theirs), stage — but do NOT commit yet
    execSync("git checkout --theirs note.md && git add note.md", { cwd: vault, shell: "/bin/sh" });
    // State: MERGE_HEAD exists, status.conflicted=[], staged files exist
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("MERGE_HEAD exists and status.conflicted is empty (pre-condition)", async () => {
    expect(exists(vault, ".git/MERGE_HEAD")).toBe(true);
    const out = execSync("git status --short", { cwd: vault }).toString();
    expect(out).not.toContain("UU"); // no unmerged files
  });

  it("listConflicts() returns [] — no fake conflict surfaced", async () => {
    const gm = makeGM(vault);
    const conflicts = await gm.listConflicts();
    expect(conflicts).toHaveLength(0);
  });

  it("sync() does NOT throw GitConflictError", async () => {
    const gm = makeGM(vault);
    await expect(gm.sync({ branch: "main" })).resolves.not.toThrow();
  });

  it("sync() commits the pending merge and clears MERGE_HEAD", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main" });
    expect(exists(vault, ".git/MERGE_HEAD")).toBe(false);
  });

  it("sync() pushes to remote — remote has the merge commit", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main" });
    const files = git(remote, "git ls-tree -r --name-only main");
    expect(files).toContain("note.md");
  });
});

// ---------------------------------------------------------------------------
// 8. sync() — existing repo, local uncommitted changes block pull
// ---------------------------------------------------------------------------

describe("sync() — existing repo with uncommitted local changes", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    // Shared remote with one commit
    remote = tmp();
    git(remote, "git init --bare");

    const work = tmp();
    git(work, "git init");
    git(work, 'git config user.name "R" && git config user.email "r@r.com"');
    write(work, "shared.md", "v1");
    git(work, `git add . && git commit -m "init" && git remote add origin ${remote} && git push -u origin HEAD:main`);
    rm(work);

    // Local vault already connected to remote
    vault = tmp();
    git(vault, "git init && git checkout -b main");
    git(vault, 'git config user.name "L" && git config user.email "l@l.com"');
    write(vault, "shared.md", "v1");
    write(vault, "local.md", "local note");
    git(vault, `git add . && git commit -m "local init" && git remote add origin ${remote}`);
    git(vault, "git fetch origin && git branch --set-upstream-to=origin/main main");
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("succeeds when local changes exist but don't conflict with remote", async () => {
    // Modify a different file locally (no remote conflict)
    write(vault, "local.md", "updated local note");

    const gm = makeGM(vault);
    await expect(gm.sync({ branch: "main" })).resolves.not.toThrow();
  });

  it("commits local changes before pulling", async () => {
    write(vault, "new-note.md", "brand new");

    const gm = makeGM(vault);
    await gm.sync({ branch: "main" });

    const tracked = git(vault, "git ls-files");
    expect(tracked).toContain("new-note.md");
    // at least one commit should exist after sync
    const log = git(vault, "git log --oneline");
    expect(log.trim().length).toBeGreaterThan(0);
  });

  it("throws GitConflictError when local and remote both changed same file", async () => {
    // Remote advances shared.md to v2
    const work = tmp();
    git(work, "git init");
    git(work, 'git config user.name "R" && git config user.email "r@r.com"');
    git(work, `git remote add origin ${remote} && git fetch origin && git checkout -b main origin/main`);
    write(work, "shared.md", "v2 from remote");
    git(work, "git add . && git commit -m 'remote update' && git push origin main");
    rm(work);

    // Local also modifies shared.md (uncommitted)
    write(vault, "shared.md", "v2 from local");

    const gm = makeGM(vault);
    await expect(gm.sync({ branch: "main" })).rejects.toThrow(GitConflictError);
  });
});

// ---------------------------------------------------------------------------
// 8. pull() — existing repo, unrelated histories
// ---------------------------------------------------------------------------

describe("pull() — existing repo, unrelated histories", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    remote = makeRemoteWithCommit("README.md", "remote readme");
    vault = tmp();
    git(vault, "git init && git checkout -b main");
    git(vault, 'git config user.name "T" && git config user.email "t@t.com"');
    write(vault, "local.md", "local note");
    git(vault, `git add . && git commit -m "local init" && git remote add origin ${remote}`);
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("does not throw unrelated histories error", async () => {
    const gm = makeGM(vault);
    await expect(gm.pull("main")).resolves.not.toThrow();
  });

  it("remote README is present after pull", async () => {
    const gm = makeGM(vault);
    await gm.pull("main");
    expect(exists(vault, "README.md")).toBe(true);
  });

  it("local note is preserved after pull", async () => {
    const gm = makeGM(vault);
    await gm.pull("main");
    expect(exists(vault, "local.md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8b. pull() / sync() — existing local repo, BRAND NEW empty remote
//
// User scenario: created an empty GitHub repo (no branches), pointed the
// plugin at it. Earlier, pull() would throw `couldn't find remote ref main`
// and bubble up as "Connection failed". The push that would have created
// the branch never ran.
// ---------------------------------------------------------------------------

describe("pull() / sync() — existing local repo against empty remote", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    // Empty bare remote — no branches, no commits.
    remote = tmp();
    git(remote, "git init --bare");

    // Local vault is already a git repo with content + a commit on main.
    vault = tmp();
    git(vault, "git init && git checkout -b main");
    git(vault, 'git config user.name "T" && git config user.email "t@t.com"');
    write(vault, "note.md", "hello");
    git(vault, `git add . && git commit -m "init" && git remote add origin ${remote}`);
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("pull() does NOT throw on an empty remote", async () => {
    const gm = makeGM(vault);
    await expect(gm.pull("main")).resolves.not.toThrow();
  });

  it("sync() succeeds against an empty remote — push creates origin/main", async () => {
    const gm = makeGM(vault);
    await expect(gm.sync({ branch: "main" })).resolves.not.toThrow();
    const remoteBranches = git(remote, "git branch --list");
    expect(remoteBranches).toMatch(/main/);
  });

  it("sync() pushes the local commit to the new remote branch", async () => {
    const gm = makeGM(vault);
    await gm.sync({ branch: "main" });
    const tree = git(remote, "git ls-tree -r --name-only main");
    expect(tree).toContain("note.md");
  });
});

// ---------------------------------------------------------------------------
// 9. commitMergedAndPush() — after ConflictModal-style resolution
//
// Simulates the exact flow the user triggers when clicking "Take Local"
// (or any resolution) and then "Merge and push":
//   1. Merge → conflict (MERGE_HEAD exists, conflicted file on disk)
//   2. ConflictModal writes resolved content + git add  (persistFile)
//   3. commitMergedAndPush() is called
//
// Verifies:
//   a. commitMergedAndPush() doesn't throw
//   b. MERGE_HEAD is cleared
//   c. Remote receives the merged content
//   d. A subsequent sync() does NOT throw "Exiting because of unfinished merge"
// ---------------------------------------------------------------------------

describe("commitMergedAndPush() — after ConflictModal-style resolution", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    // Shared remote with v1
    remote = tmp();
    git(remote, "git init --bare");

    const base = tmp();
    git(base, "git init");
    git(base, 'git config user.name "B" && git config user.email "b@b.com"');
    write(base, "note.md", "v1 original");
    git(base, `git add . && git commit -m "v1" && git remote add origin ${remote} && git push -u origin HEAD:main`);
    rm(base);

    // vault = User2's repo, clones v1, makes local edit
    vault = tmp();
    git(vault, "git init");
    git(vault, 'git config user.name "U2" && git config user.email "u2@u.com"');
    git(vault, `git remote add origin ${remote} && git fetch origin && git checkout -b main origin/main`);
    write(vault, "note.md", "v3 from user2");
    git(vault, "git add . && git commit -m 'u2 edit'");

    // User1 pushes v2 to remote — diverges from vault
    const user1 = tmp();
    git(user1, "git init");
    git(user1, 'git config user.name "U1" && git config user.email "u1@u.com"');
    git(user1, `git remote add origin ${remote} && git fetch origin && git checkout -b main origin/main`);
    write(user1, "note.md", "v2 from user1");
    git(user1, "git add . && git commit -m 'u1 edit' && git push origin main");
    rm(user1);

    // vault fetches and merges → conflict
    git(vault, "git fetch origin");
    try {
      execSync("git merge origin/main", { cwd: vault, shell: "/bin/sh", stdio: "pipe" });
    } catch { /* expected conflict */ }

    // ConflictModal persistFile: write resolved content (no markers) + stage
    write(vault, "note.md", "resolved by user2");
    git(vault, "git add note.md");
    // State: MERGE_HEAD exists, file staged without conflict markers
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("pre-condition: MERGE_HEAD exists and no conflicted files", () => {
    expect(exists(vault, ".git/MERGE_HEAD")).toBe(true);
    const status = execSync("git status --short", { cwd: vault }).toString();
    expect(status).not.toContain("UU");
  });

  it("commitMergedAndPush() completes without error", async () => {
    const gm = makeGM(vault);
    await expect(gm.commitMergedAndPush("main", "merge: resolved note.md")).resolves.not.toThrow();
  });

  it("MERGE_HEAD is cleared after commitMergedAndPush()", async () => {
    const gm = makeGM(vault);
    await gm.commitMergedAndPush("main", "merge: resolved note.md");
    expect(exists(vault, ".git/MERGE_HEAD")).toBe(false);
  });

  it("remote receives the resolved content", async () => {
    const gm = makeGM(vault);
    await gm.commitMergedAndPush("main", "merge: resolved note.md");
    const content = execSync("git show main:note.md", { cwd: remote }).toString();
    expect(content.trim()).toBe("resolved by user2");
  });

  it("sync() after commitMergedAndPush() does not throw — no unfinished-merge error", async () => {
    const gm = makeGM(vault);
    await gm.commitMergedAndPush("main", "merge: resolved note.md");
    // Key regression: second sync must not hit "Exiting because of unfinished merge"
    await expect(gm.sync({ branch: "main" })).resolves.not.toThrow();
  });

  it("sync() after commitMergedAndPush() leaves repo clean (no MERGE_HEAD)", async () => {
    const gm = makeGM(vault);
    await gm.commitMergedAndPush("main", "merge: resolved note.md");
    await gm.sync({ branch: "main" });
    expect(exists(vault, ".git/MERGE_HEAD")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. pull() — existing repo, unrelated histories, remote has system files
//    This is the "reconnect" case: vault already has .git, remote has
//    .obsidian/plugins committed — all conflicts should be auto-resolved.
// ---------------------------------------------------------------------------

describe("pull() — existing repo, unrelated histories with system file conflicts", () => {
  let vault: string;
  let remote: string;

  beforeEach(() => {
    // Remote has .obsidian/plugins and .DS_Store committed
    const work = tmp();
    remote = tmp();
    git(remote, "git init --bare");
    git(work, "git init");
    git(work, 'git config user.name "R" && git config user.email "r@r.com"');
    write(work, ".obsidian/plugins/myplugin/main.js", "remote plugin");
    write(work, ".DS_Store", "remote ds");
    write(work, ".github-sync.json", JSON.stringify({ version: 1, remote: "https://github.com/r/r.git", branch: "main" }));
    write(work, "README.md", "remote readme");
    git(work, `git add . && git commit -m "init" && git remote add origin ${remote} && git push -u origin HEAD:main`);
    rm(work);

    // Local vault: already a git repo with its own history
    vault = tmp();
    git(vault, "git init && git checkout -b main");
    git(vault, 'git config user.name "L" && git config user.email "l@l.com"');
    write(vault, ".obsidian/plugins/myplugin/main.js", "local plugin");
    write(vault, ".DS_Store", "local ds");
    write(vault, ".github-sync.json", JSON.stringify({ version: 1, remote: `file://${remote}`, branch: "main" }));
    write(vault, "my-note.md", "my note");
    git(vault, `git add . && git commit -m "local init" && git remote add origin ${remote}`);
  });

  afterEach(() => {
    rm(vault);
    rm(remote);
  });

  it("does not throw — system file conflicts are auto-resolved", async () => {
    const gm = makeGM(vault);
    await expect(gm.pull("main")).resolves.not.toThrow();
  });

  it("no MERGE_HEAD remains after pull (merge is committed)", async () => {
    const gm = makeGM(vault);
    await gm.pull("main");
    expect(exists(vault, ".git/MERGE_HEAD")).toBe(false);
  });

  it("no ~<hash> residual paths after pull", async () => {
    const gm = makeGM(vault);
    await gm.pull("main");
    expect(findResiduals(vault)).toHaveLength(0);
  });

  it("user note is preserved", async () => {
    const gm = makeGM(vault);
    await gm.pull("main");
    expect(exists(vault, "my-note.md")).toBe(true);
  });

  it("remote README is pulled in", async () => {
    const gm = makeGM(vault);
    await gm.pull("main");
    expect(exists(vault, "README.md")).toBe(true);
  });
});
