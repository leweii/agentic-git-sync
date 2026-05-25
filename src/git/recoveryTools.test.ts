/* eslint-disable obsidianmd/no-nodejs-modules -- test harness runs in Node, not shipped in main.js */
/**
 * Integration tests for the recovery tool registry against real temp git repos.
 *
 * Coverage:
 *   - The 4 specialised fs-touching tools (clear_lock, repair_head,
 *     skip_large_file, reinit_from_remote)
 *   - The meta-tool git_exec (passthrough + clean deny check)
 *   - The resolveGitDir helper
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import simpleGit from "simple-git";

import { RECOVERY_TOOLS, resolveGitDir } from "./recoveryTools";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghs-rec-"));
}

function git(cwd: string, cmd: string) {
  return execSync(cmd, { cwd, shell: "/bin/sh", stdio: "pipe" }).toString();
}

function write(dir: string, file: string, content: string) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function initRepo(dir: string) {
  git(dir, "git init -b main");
  git(dir, "git config user.email test@test.com && git config user.name Test");
}

function makeBareRemote(): string {
  const bare = tmp();
  git(bare, "git init --bare -b main");
  return bare;
}

function makeRemoteWithCommit(): string {
  const bare = makeBareRemote();
  const work = tmp();
  initRepo(work);
  write(work, "README.md", "hello");
  git(work, "git add . && git commit -m init");
  git(work, `git remote add origin ${bare} && git push -u origin main`);
  return bare;
}

beforeAll(() => {
  process.env.GIT_CONFIG_PARAMETERS = "'protocol.file.allow=always'";
});

const ctx = (vault: string, branch = "main") => ({
  git: simpleGit(vault),
  vaultPath: vault,
  branch,
});

// ---------------------------------------------------------------------------
// clear_lock
// ---------------------------------------------------------------------------

describe("clear_lock", () => {
  it("removes index.lock older than 30 s", async () => {
    const repo = tmp();
    initRepo(repo);
    const lockPath = path.join(repo, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");
    const ancient = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, ancient, ancient);

    await RECOVERY_TOOLS.clear_lock(ctx(repo), {});
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("keeps a fresh index.lock (< 30 s)", async () => {
    const repo = tmp();
    initRepo(repo);
    const lockPath = path.join(repo, ".git", "index.lock");
    fs.writeFileSync(lockPath, "");

    await RECOVERY_TOOLS.clear_lock(ctx(repo), {});
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("clears stale refs/**.lock", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "a");
    git(repo, "git add . && git commit -m init");
    const refLock = path.join(repo, ".git", "refs", "heads", "main.lock");
    fs.writeFileSync(refLock, "");
    const ancient = (Date.now() - 60_000) / 1000;
    fs.utimesSync(refLock, ancient, ancient);

    await RECOVERY_TOOLS.clear_lock(ctx(repo), {});
    expect(fs.existsSync(refLock)).toBe(false);
  });

  it("no-op when no .git dir exists", async () => {
    const repo = tmp();
    await expect(RECOVERY_TOOLS.clear_lock(ctx(repo), {})).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// repair_head
// ---------------------------------------------------------------------------

describe("repair_head", () => {
  it("repoints HEAD to refs/heads/<branch> when ref exists", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    git(repo, "git checkout --detach");
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/nonexistent\n");

    await RECOVERY_TOOLS.repair_head(ctx(repo, "main"), {});

    const head = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8").trim();
    expect(head).toBe("ref: refs/heads/main");
  });

  it("is a no-op when the target ref does not exist", async () => {
    const repo = tmp();
    initRepo(repo);
    const headBefore = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8");
    await RECOVERY_TOOLS.repair_head(ctx(repo, "totally-missing-branch"), {});
    const headAfter = fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8");
    expect(headAfter).toBe(headBefore);
  });

  it("preserves commit data — same HEAD sha after repair", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    const shaBefore = git(repo, "git rev-parse refs/heads/main").trim();

    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/totally-broken\n");
    await RECOVERY_TOOLS.repair_head(ctx(repo, "main"), {});

    const shaAfter = git(repo, "git rev-parse HEAD").trim();
    expect(shaAfter).toBe(shaBefore);
  });
});

// ---------------------------------------------------------------------------
// skip_large_file
// ---------------------------------------------------------------------------

describe("skip_large_file", () => {
  it("adds filename to .gitignore and removes from index", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "big.bin", "large content");
    git(repo, "git add . && git commit -m init");

    await RECOVERY_TOOLS.skip_large_file(ctx(repo), { filename: "big.bin" });

    const ignore = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
    expect(ignore).toContain("big.bin");
    const lsFiles = git(repo, "git ls-files").trim().split("\n");
    expect(lsFiles).not.toContain("big.bin");
  });

  it("does nothing when filename is empty", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");

    await RECOVERY_TOOLS.skip_large_file(ctx(repo), { filename: "" });
    expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false);
  });

  it("does not duplicate an existing .gitignore entry", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, ".gitignore", "big.bin\n");
    write(repo, "big.bin", "x");
    git(repo, "git add . && git commit -m init");

    await RECOVERY_TOOLS.skip_large_file(ctx(repo), { filename: "big.bin" });
    const ignore = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
    const occurrences = ignore.split("\n").filter((l) => l === "big.bin").length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// reinit_from_remote
// ---------------------------------------------------------------------------

describe("reinit_from_remote", () => {
  it("backs up .git to .git.broken-<ts>/ and rebuilds from remote", async () => {
    const bare = makeRemoteWithCommit();
    const local = tmp();
    git(local, `git clone ${bare} .`);
    git(local, "git config user.email test@test.com && git config user.name Test");
    write(local, "untracked.md", "user note");

    await RECOVERY_TOOLS.reinit_from_remote(ctx(local), {});

    const backups = fs.readdirSync(local).filter((n) => n.startsWith(".git.broken-"));
    expect(backups.length).toBe(1);
    expect(fs.existsSync(path.join(local, ".git", "HEAD"))).toBe(true);
    const remoteUrl = git(local, "git remote get-url origin").trim();
    expect(remoteUrl).toBe(bare);
    expect(fs.existsSync(path.join(local, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(local, "untracked.md"))).toBe(true);
  });

  it("uses ctx.remoteUrl fallback when .git/config has no remote", async () => {
    const bare = makeRemoteWithCommit();
    const local = tmp();
    initRepo(local);

    await RECOVERY_TOOLS.reinit_from_remote({ ...ctx(local), remoteUrl: bare }, {});

    const remoteUrl = git(local, "git remote get-url origin").trim();
    expect(remoteUrl).toBe(bare);
  });

  it("rolls back when fetch fails — backup restored, no half-built .git", async () => {
    const local = tmp();
    initRepo(local);
    write(local, "a.txt", "x");
    git(local, "git add . && git commit -m init");
    git(local, "git remote add origin /nonexistent/path/that/does/not/exist");

    await expect(RECOVERY_TOOLS.reinit_from_remote(ctx(local), {})).rejects.toThrow();

    expect(fs.existsSync(path.join(local, ".git", "HEAD"))).toBe(true);
    const backups = fs.readdirSync(local).filter((n) => n.startsWith(".git.broken-"));
    expect(backups.length).toBe(0);
    const head = git(local, "git rev-parse HEAD").trim();
    expect(head.length).toBe(40);
  });

  it("throws when no remote URL is available", async () => {
    const local = tmp();
    initRepo(local);
    await expect(RECOVERY_TOOLS.reinit_from_remote(ctx(local), {})).rejects.toThrow(/no remote URL/i);
  });
});

// ---------------------------------------------------------------------------
// git_exec — the meta-tool that replaces 14 wrapper tools
// ---------------------------------------------------------------------------

describe("git_exec", () => {
  it("runs an arbitrary git subcommand (merge --abort)", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "base");
    git(repo, "git add . && git commit -m base");
    git(repo, "git checkout -b feat");
    write(repo, "a.txt", "feat");
    git(repo, "git commit -am feat");
    git(repo, "git checkout main");
    write(repo, "a.txt", "main");
    git(repo, "git commit -am main");
    try { git(repo, "git merge feat"); } catch { /* expected conflict */ }
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);

    await RECOVERY_TOOLS.git_exec(ctx(repo), { args: JSON.stringify(["merge", "--abort"]) });

    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("runs config core.longpaths via git_exec", async () => {
    const repo = tmp();
    initRepo(repo);
    await RECOVERY_TOOLS.git_exec(ctx(repo), {
      args: JSON.stringify(["config", "core.longpaths", "true"]),
    });
    expect(git(repo, "git config --get core.longpaths").trim()).toBe("true");
  });

  it("runs reset --hard origin/<branch>", async () => {
    const bare = makeRemoteWithCommit();
    const local = tmp();
    git(local, `git clone ${bare} .`);
    git(local, "git config user.email test@test.com && git config user.name Test");
    write(local, "drift.txt", "local-only");
    git(local, "git add . && git commit -m local-drift");

    const remoteHead = git(local, "git rev-parse origin/main").trim();
    await RECOVERY_TOOLS.git_exec(ctx(local), {
      args: JSON.stringify(["reset", "--hard", "origin/main"]),
    });

    expect(git(local, "git rev-parse HEAD").trim()).toBe(remoteHead);
    expect(fs.existsSync(path.join(local, "drift.txt"))).toBe(false);
  });

  it("REFUSES git clean — protects untracked user data", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "untracked.md", "user note");

    await expect(
      RECOVERY_TOOLS.git_exec(ctx(repo), { args: JSON.stringify(["clean", "-fdx"]) }),
    ).rejects.toThrow(/refused|blocked/i);

    expect(fs.existsSync(path.join(repo, "untracked.md"))).toBe(true);
  });

  it("REFUSES git clean -n (dry run) too — uniform deny on the verb", async () => {
    // We deny the entire `git clean` verb, not just dangerous flags. A non-
    // technical recovery loop has no legitimate reason to run any clean.
    const repo = tmp();
    initRepo(repo);
    await expect(
      RECOVERY_TOOLS.git_exec(ctx(repo), { args: JSON.stringify(["clean", "-n"]) }),
    ).rejects.toThrow(/refused|blocked/i);
  });

  it("rejects invalid args JSON", async () => {
    const repo = tmp();
    initRepo(repo);
    await expect(
      RECOVERY_TOOLS.git_exec(ctx(repo), { args: "not-json" }),
    ).rejects.toThrow(/JSON array of strings/);
  });

  it("rejects non-string args", async () => {
    const repo = tmp();
    initRepo(repo);
    await expect(
      RECOVERY_TOOLS.git_exec(ctx(repo), { args: JSON.stringify(["status", 42]) }),
    ).rejects.toThrow(/JSON array of strings/);
  });

  it("rejects empty args", async () => {
    const repo = tmp();
    initRepo(repo);
    await expect(
      RECOVERY_TOOLS.git_exec(ctx(repo), { args: JSON.stringify([]) }),
    ).rejects.toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// resolveGitDir
// ---------------------------------------------------------------------------

describe("resolveGitDir", () => {
  it("returns .git path for a normal repo", () => {
    const repo = tmp();
    initRepo(repo);
    expect(resolveGitDir(repo)).toBe(path.join(repo, ".git"));
  });

  it("follows a gitfile pointer (submodule pattern)", () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, "elsewhere"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git"), `gitdir: ${path.join(repo, "elsewhere")}\n`);
    expect(resolveGitDir(repo)).toBe(path.join(repo, "elsewhere"));
  });

  it("returns null when no .git exists", () => {
    const repo = tmp();
    expect(resolveGitDir(repo)).toBeNull();
  });
});
