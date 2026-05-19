/* eslint-disable obsidianmd/no-nodejs-modules -- test harness runs in Node, not shipped in main.js */
/**
 * Integration tests for SubmoduleManager — real git repos with real submodules.
 *
 * These tests guarantee that the conflict resolution / commit-merged-and-push
 * flow is *identical* between the main vault and submodules. The user-visible
 * bug being prevented: after clicking "Take Local" (or any resolution) and
 * "Merge and push" in a submodule, the next sync must not error with
 * "Exiting because of unfinished merge".
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { SubmoduleManager } from "./SubmoduleManager";
import { GitConflictError } from "./GitManager";
import type { SubmoduleConfig } from "../settings";

// Allow file:// URLs in submodule operations — tests use file paths as remotes.
// Production users connect to https://github.com/... which is unaffected.
beforeAll(() => {
  process.env.GIT_CONFIG_PARAMETERS = "'protocol.file.allow=always'";
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghs-sm-test-"));
}

function rm(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(dir: string, file: string, content: string) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function exists(dir: string, ...parts: string[]): boolean {
  return fs.existsSync(path.join(dir, ...parts));
}

function git(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, shell: "/bin/sh", stdio: "pipe" }).toString();
}

/** Resolve submodule's real git dir via .git gitfile. */
function submoduleGitDir(vaultPath: string, subPath: string): string {
  const gitfile = path.join(vaultPath, subPath, ".git");
  const ref = fs.readFileSync(gitfile, "utf8").trim().replace(/^gitdir:\s*/, "");
  return path.resolve(path.dirname(gitfile), ref);
}

function makeSM(vaultPath: string): SubmoduleManager {
  return new SubmoduleManager(vaultPath, "Test", "test@test.com", "", ".obsidian");
}

// ---------------------------------------------------------------------------
// Shared scenario builder: parent repo with submodule in conflict state
// ---------------------------------------------------------------------------

interface Scenario {
  vault: string;
  parentRemote: string;
  subRemote: string;
  config: SubmoduleConfig;
}

function buildSubmoduleConflictScenario(): Scenario {
  // Sub remote: v1
  const subRemote = tmp();
  git(subRemote, "git init --bare");

  const subSeed = tmp();
  git(subSeed, "git init");
  git(subSeed, 'git config user.name "S" && git config user.email "s@s.com"');
  write(subSeed, "note.md", "v1 original");
  git(subSeed, `git add . && git commit -m "v1" && git remote add origin ${subRemote} && git push -u origin HEAD:main`);
  rm(subSeed);

  // Parent remote: empty
  const parentRemote = tmp();
  git(parentRemote, "git init --bare");

  // Parent vault: clone, add submodule, push parent
  const vault = tmp();
  git(vault, "git init");
  git(vault, 'git config user.name "V" && git config user.email "v@v.com"');
  git(vault, "git checkout -b main");
  write(vault, "README.md", "parent");
  git(vault, "git add . && git commit -m 'parent init'");
  git(vault, `git submodule add ${subRemote} sub`);
  git(vault, "git commit -m 'add submodule'");
  git(vault, `git remote add origin ${parentRemote} && git push -u origin main`);

  // User1 pushes v2 to sub remote directly
  const user1 = tmp();
  git(user1, "git init");
  git(user1, 'git config user.name "U1" && git config user.email "u1@u.com"');
  git(user1, `git remote add origin ${subRemote} && git fetch origin && git checkout -b main origin/main`);
  write(user1, "note.md", "v2 from user1");
  git(user1, "git add . && git commit -m 'u1 edit' && git push origin main");
  rm(user1);

  // Vault's submodule: edit locally → v3 (diverges from v1)
  const subPath = path.join(vault, "sub");
  write(subPath, "note.md", "v3 from user2");
  git(subPath, "git add . && git commit -m 'u2 edit'");

  // Fetch + merge inside submodule → conflict
  git(subPath, "git fetch origin");
  try {
    execSync("git merge origin/main", { cwd: subPath, shell: "/bin/sh", stdio: "pipe" });
  } catch { /* expected conflict */ }

  // ConflictModal persistFile equivalent: write resolved content + git add
  // (this is exactly what ConflictModal does via ops.writeFile + ops.stage)
  write(subPath, "note.md", "resolved by user2");
  git(subPath, "git add note.md");

  const config: SubmoduleConfig = {
    id: "sub-id",
    localPath: "sub",
    remoteUrl: subRemote,
    branch: "main",
    autoSync: true,
    syncInterval: 30,
  };

  return { vault, parentRemote, subRemote, config };
}

// ---------------------------------------------------------------------------
// 1. SubmoduleManager.commitMergedAndPush() — same flow as main vault
// ---------------------------------------------------------------------------

describe("SubmoduleManager.commitMergedAndPush() — after ConflictModal resolution", () => {
  let s: Scenario;

  beforeEach(() => {
    s = buildSubmoduleConflictScenario();
  });

  afterEach(() => {
    rm(s.vault);
    rm(s.parentRemote);
    rm(s.subRemote);
  });

  it("pre-condition: submodule MERGE_HEAD exists (gitfile path)", () => {
    const gitDir = submoduleGitDir(s.vault, "sub");
    expect(fs.existsSync(path.join(gitDir, "MERGE_HEAD"))).toBe(true);
  });

  it("listConflicts() returns [] — file is staged, not conflicted", async () => {
    const sm = makeSM(s.vault);
    const conflicts = await sm.listConflicts(s.config);
    expect(conflicts).toHaveLength(0);
  });

  it("commitMergedAndPush() completes without error", async () => {
    const sm = makeSM(s.vault);
    await expect(
      sm.commitMergedAndPush(s.config, "merge: resolved note.md")
    ).resolves.not.toThrow();
  });

  it("clears MERGE_HEAD inside the submodule", async () => {
    const sm = makeSM(s.vault);
    await sm.commitMergedAndPush(s.config, "merge: resolved note.md");
    const gitDir = submoduleGitDir(s.vault, "sub");
    expect(fs.existsSync(path.join(gitDir, "MERGE_HEAD"))).toBe(false);
  });

  it("pushes the merge commit to sub remote", async () => {
    const sm = makeSM(s.vault);
    await sm.commitMergedAndPush(s.config, "merge: resolved note.md");
    const content = execSync("git show main:note.md", { cwd: s.subRemote }).toString();
    expect(content.trim()).toBe("resolved by user2");
  });

  it("updates parent pointer and pushes parent", async () => {
    const sm = makeSM(s.vault);
    await sm.commitMergedAndPush(s.config, "merge: resolved note.md");
    // Parent remote should have a new commit referencing the submodule's new SHA
    const parentLog = git(s.parentRemote, "git log --oneline main");
    expect(parentLog).toMatch(/update submodule sub/);
  });

  it("sync() after commitMergedAndPush() does not throw — no 'unfinished merge'", async () => {
    const sm = makeSM(s.vault);
    await sm.commitMergedAndPush(s.config, "merge: resolved note.md");
    // This is the user-reported bug: a follow-up sync was hitting MERGE_HEAD residue.
    await expect(sm.syncOne(s.config)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Parity: same submodule conflict surfaces same error as main vault
// ---------------------------------------------------------------------------

describe("SubmoduleManager — surfaces GitConflictError when conflict is real", () => {
  let s: Scenario;

  beforeEach(() => {
    s = buildSubmoduleConflictScenario();
    // Roll back the staged-resolution state — leave a real unmerged conflict.
    const subPath = path.join(s.vault, "sub");
    git(subPath, "git reset --hard HEAD");
    git(subPath, "git fetch origin");
    try {
      execSync("git merge origin/main", { cwd: subPath, shell: "/bin/sh", stdio: "pipe" });
    } catch { /* expected */ }
    // State: status.conflicted = ["note.md"]
  });

  afterEach(() => {
    rm(s.vault);
    rm(s.parentRemote);
    rm(s.subRemote);
  });

  it("listConflicts() returns the conflicted file", async () => {
    const sm = makeSM(s.vault);
    const conflicts = await sm.listConflicts(s.config);
    expect(conflicts).toContain("note.md");
  });

  it("syncOne() throws GitConflictError — same shape as main vault sync", async () => {
    const sm = makeSM(s.vault);
    await expect(sm.syncOne(s.config)).rejects.toThrow(GitConflictError);
  });
});

// ---------------------------------------------------------------------------
// 3. ensureInitialized() — fresh clone without --recursive
//
// Simulates: user clones a vault that already has .gitmodules + submodule
// commits in its history, but didn't pass --recursive. The submodule
// directory exists in the index but is empty on disk. ensureInitialized()
// should clone + check out every declared submodule.
// ---------------------------------------------------------------------------

describe("SubmoduleManager.ensureInitialized()", () => {
  let subRemote: string;
  let parentRemote: string;
  let seededVault: string;
  let freshClone: string;
  let config: SubmoduleConfig;

  beforeEach(() => {
    // 1. Build a sub remote with content
    subRemote = tmp();
    git(subRemote, "git init --bare");
    const subSeed = tmp();
    git(subSeed, "git init && git checkout -b main");
    git(subSeed, 'git config user.name "S" && git config user.email "s@s.com"');
    write(subSeed, "data.md", "submodule content");
    git(subSeed, `git add . && git commit -m "sub init" && git remote add origin ${subRemote} && git push -u origin main`);
    rm(subSeed);

    // 2. Build a parent remote with the submodule registered
    parentRemote = tmp();
    git(parentRemote, "git init --bare");
    seededVault = tmp();
    git(seededVault, "git init && git checkout -b main");
    git(seededVault, 'git config user.name "V" && git config user.email "v@v.com"');
    write(seededVault, "README.md", "parent");
    git(seededVault, "git add . && git commit -m 'parent init'");
    git(seededVault, `git submodule add ${subRemote} sub`);
    git(seededVault, "git commit -m 'add submodule'");
    git(seededVault, `git remote add origin ${parentRemote} && git push -u origin main`);
    rm(seededVault);

    // 3. Fresh clone WITHOUT --recursive (key: simulates user just doing `git clone`)
    freshClone = tmp();
    rm(freshClone);
    execSync(`git clone ${parentRemote} ${freshClone}`, { shell: "/bin/sh", stdio: "pipe" });

    config = {
      id: "sub-id",
      localPath: "sub",
      remoteUrl: subRemote,
      branch: "main",
      autoSync: true,
      syncInterval: 30,
    };
  });

  afterEach(() => {
    rm(freshClone);
    rm(parentRemote);
    rm(subRemote);
  });

  it("pre-condition: fresh clone has empty submodule directory", () => {
    // Directory exists but no .git inside (not checked out)
    expect(exists(freshClone, "sub")).toBe(true);
    expect(exists(freshClone, "sub", ".git")).toBe(false);
  });

  it("ensureInitialized() returns the newly-initialized paths", async () => {
    const sm = new SubmoduleManager(freshClone, "T", "t@t.com", "", ".obsidian");
    const newly = await sm.ensureInitialized([config]);
    expect(newly).toEqual(["sub"]);
  });

  it("after ensureInitialized() the submodule has its content", async () => {
    const sm = new SubmoduleManager(freshClone, "T", "t@t.com", "", ".obsidian");
    await sm.ensureInitialized([config]);
    expect(exists(freshClone, "sub", "data.md")).toBe(true);
    expect(fs.readFileSync(path.join(freshClone, "sub", "data.md"), "utf8")).toBe(
      "submodule content"
    );
  });

  it("ensureInitialized() is idempotent — second call returns []", async () => {
    const sm = new SubmoduleManager(freshClone, "T", "t@t.com", "", ".obsidian");
    await sm.ensureInitialized([config]);
    const newly = await sm.ensureInitialized([config]);
    expect(newly).toEqual([]);
  });

  it("ensureInitialized() returns [] when configs is empty", async () => {
    const sm = new SubmoduleManager(freshClone, "T", "t@t.com", "", ".obsidian");
    const newly = await sm.ensureInitialized([]);
    expect(newly).toEqual([]);
  });

  it("ensureInitialized() returns [] when vault is not a git repo", async () => {
    const notARepo = tmp();
    const sm = new SubmoduleManager(notARepo, "T", "t@t.com", "", ".obsidian");
    const newly = await sm.ensureInitialized([config]);
    expect(newly).toEqual([]);
    rm(notARepo);
  });

  it("after ensureInitialized() listChanges() works for the newly cloned sub", async () => {
    const sm = new SubmoduleManager(freshClone, "T", "t@t.com", "", ".obsidian");
    await sm.ensureInitialized([config]);
    const changes = await sm.listChanges(config);
    expect(changes.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. remove() — full cleanup
// ---------------------------------------------------------------------------

describe("SubmoduleManager.remove()", () => {
  let s: Scenario;

  beforeEach(() => {
    s = buildSubmoduleConflictScenario();
    // Reset the conflict — we just want a clean checked-out submodule to remove.
    const subPath = path.join(s.vault, "sub");
    try {
      execSync("git merge --abort", { cwd: subPath, shell: "/bin/sh", stdio: "pipe" });
    } catch { /* not in merge */ }
    git(subPath, "git reset --hard HEAD");
  });

  afterEach(() => {
    rm(s.vault);
    rm(s.parentRemote);
    rm(s.subRemote);
  });

  it("removes the submodule working tree", async () => {
    const sm = makeSM(s.vault);
    await sm.remove("sub");
    expect(exists(s.vault, "sub")).toBe(false);
  });

  it("removes the submodule from .gitmodules", async () => {
    const sm = makeSM(s.vault);
    await sm.remove("sub");
    const gm = exists(s.vault, ".gitmodules")
      ? fs.readFileSync(path.join(s.vault, ".gitmodules"), "utf8")
      : "";
    expect(gm).not.toContain("path = sub");
  });

  it("removes .git/modules/<path>", async () => {
    const sm = makeSM(s.vault);
    await sm.remove("sub");
    expect(exists(s.vault, ".git/modules/sub")).toBe(false);
  });

  it("status shows the removal staged in the parent index", async () => {
    const sm = makeSM(s.vault);
    await sm.remove("sub");
    const status = execSync("git status --short", { cwd: s.vault }).toString();
    // .gitmodules modified or deleted, sub removed
    expect(status).toMatch(/^D\s+sub|^M\s+\.gitmodules|^\sD\s+sub/m);
  });
});

// ---------------------------------------------------------------------------
// 5. stagePath() — used by ConflictModal as ops.stage()
// ---------------------------------------------------------------------------

describe("SubmoduleManager.stagePath() — delegates to sub GitManager", () => {
  let s: Scenario;

  beforeEach(() => {
    s = buildSubmoduleConflictScenario();
    // Roll the file back to a conflicted state for a clean test
    const subPath = path.join(s.vault, "sub");
    git(subPath, "git reset HEAD note.md");
    write(subPath, "note.md", "manually resolved");
  });

  afterEach(() => {
    rm(s.vault);
    rm(s.parentRemote);
    rm(s.subRemote);
  });

  it("stagePath() adds the file to the submodule's index", async () => {
    const sm = makeSM(s.vault);
    await sm.stagePath(s.config, "note.md");
    const subPath = path.join(s.vault, "sub");
    const status = execSync("git status --short", { cwd: subPath }).toString();
    // staged → "M " (space at end); unstaged would have " M"
    expect(status).toMatch(/^M\s+note\.md/m);
  });
});
