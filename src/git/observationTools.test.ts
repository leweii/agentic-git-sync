/* eslint-disable obsidianmd/no-nodejs-modules -- test harness runs in Node, not shipped in main.js */
/**
 * Integration tests for OBSERVATION_TOOLS against real temp git repos.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import simpleGit from "simple-git";

import { OBSERVATION_TOOLS } from "./observationTools";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghs-obs-"));
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
  write(work, "README.md", "hi");
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
// git_status
// ---------------------------------------------------------------------------

describe("git_status", () => {
  it("reports a clean working tree", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    const out = await OBSERVATION_TOOLS.git_status(ctx(repo));
    // porcelain v2 emits '# branch.head main' even when clean
    expect(out).toContain("branch.head");
    expect(out).toContain("main");
  });

  it("flags untracked files", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    write(repo, "new.txt", "untracked");
    const out = await OBSERVATION_TOOLS.git_status(ctx(repo));
    expect(out).toContain("new.txt");
  });

  it("reports detached HEAD state", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    git(repo, "git checkout --detach");
    const out = await OBSERVATION_TOOLS.git_status(ctx(repo));
    // porcelain v2 shows branch.head as the sha (or "(detached)") on detached HEAD
    expect(out.toLowerCase()).toMatch(/branch\.head/);
  });

  it("returns an error string on a non-repo", async () => {
    const out = await OBSERVATION_TOOLS.git_status(ctx(tmp()));
    expect(out).toMatch(/error/i);
  });
});

// ---------------------------------------------------------------------------
// git_log_recent
// ---------------------------------------------------------------------------

describe("git_log_recent", () => {
  it("returns up to 3 oneline commits", async () => {
    const repo = tmp();
    initRepo(repo);
    for (let i = 0; i < 5; i++) {
      write(repo, `f${i}.txt`, String(i));
      git(repo, `git add . && git commit -m commit-${i}`);
    }
    const out = await OBSERVATION_TOOLS.git_log_recent(ctx(repo));
    expect(out.split("\n").length).toBe(3);
    expect(out).toContain("commit-4");
  });
});

// ---------------------------------------------------------------------------
// git_remote_state
// ---------------------------------------------------------------------------

describe("git_remote_state", () => {
  it("reports ahead/behind counts", async () => {
    const bare = makeRemoteWithCommit();
    const local = tmp();
    git(local, `git clone ${bare} .`);
    git(local, "git config user.email test@test.com && git config user.name Test");

    // Push remote ahead via another clone
    const other = tmp();
    git(other, `git clone ${bare} .`);
    git(other, "git config user.email test@test.com && git config user.name Test");
    write(other, "remote1.md", "r");
    git(other, "git add . && git commit -m remote1 && git push");
    write(other, "remote2.md", "r");
    git(other, "git add . && git commit -m remote2 && git push");

    // Make local ahead too
    write(local, "local.md", "l");
    git(local, "git add . && git commit -m local");
    git(local, "git fetch origin");

    const out = await OBSERVATION_TOOLS.git_remote_state(ctx(local));
    expect(out).toBe("ahead=1 behind=2");
  });
});

// ---------------------------------------------------------------------------
// list_git_dir
// ---------------------------------------------------------------------------

describe("list_git_dir", () => {
  it("reports MERGE_HEAD when an unconcluded merge exists", async () => {
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
    try { git(repo, "git merge feat"); } catch { /* conflict */ }

    const out = await OBSERVATION_TOOLS.list_git_dir(ctx(repo));
    expect(out).toContain("MERGE_HEAD");
  });

  it("reports lock files under refs/", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    const refLock = path.join(repo, ".git", "refs", "heads", "main.lock");
    fs.writeFileSync(refLock, "");
    const out = await OBSERVATION_TOOLS.list_git_dir(ctx(repo));
    expect(out).toContain("refs/heads/main.lock");
  });

  it("reports a clean state when no markers exist", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    const out = await OBSERVATION_TOOLS.list_git_dir(ctx(repo));
    expect(out).toBe("no merge/rebase/lock markers");
  });

  it("returns a sentinel when no .git dir exists", async () => {
    const out = await OBSERVATION_TOOLS.list_git_dir(ctx(tmp()));
    expect(out).toMatch(/no \.git/);
  });
});

// ---------------------------------------------------------------------------
// git_fsck
// ---------------------------------------------------------------------------

describe("git_fsck", () => {
  it("reports ok on a healthy repo", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    const out = await OBSERVATION_TOOLS.git_fsck(ctx(repo));
    // Either explicit "ok" or empty fsck output (which we map to "ok"). The
    // exact phrasing varies by git version; what matters is no error keywords.
    expect(out.toLowerCase()).not.toMatch(/corrupt|missing object|broken/);
  });

  it("flags a corrupt object", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    // Corrupt one of the loose objects. Git writes loose objects with mode 0444
    // on macOS, so we have to chmod before overwriting.
    const objectsDir = path.join(repo, ".git", "objects");
    const buckets = fs.readdirSync(objectsDir).filter((n) => n.length === 2);
    expect(buckets.length).toBeGreaterThan(0);
    const bucket = path.join(objectsDir, buckets[0]);
    const file = fs.readdirSync(bucket)[0];
    const fullPath = path.join(bucket, file);
    fs.chmodSync(fullPath, 0o644);
    fs.writeFileSync(fullPath, "garbage");

    const out = await OBSERVATION_TOOLS.git_fsck(ctx(repo));
    expect(out.toLowerCase()).toMatch(/error|corrupt|missing|invalid|broken/);
  });
});

// ---------------------------------------------------------------------------
// git_reflog
// ---------------------------------------------------------------------------

describe("git_reflog", () => {
  it("returns recent reflog entries", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "1");
    git(repo, "git add . && git commit -m one");
    write(repo, "a.txt", "2");
    git(repo, "git commit -am two");
    const out = await OBSERVATION_TOOLS.git_reflog(ctx(repo));
    expect(out).toMatch(/commit/);
  });
});

// ---------------------------------------------------------------------------
// git_diff_summary
// ---------------------------------------------------------------------------

describe("git_diff_summary", () => {
  it("lists changed files with stats", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    write(repo, "a.txt", "x\ny\nz\n");
    const out = await OBSERVATION_TOOLS.git_diff_summary(ctx(repo));
    expect(out).toContain("a.txt");
  });

  it("reports no changes for a clean tree", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, "a.txt", "x");
    git(repo, "git add . && git commit -m init");
    const out = await OBSERVATION_TOOLS.git_diff_summary(ctx(repo));
    expect(out).toBe("(no tracked changes)");
  });
});

// ---------------------------------------------------------------------------
// git_remote_list
// ---------------------------------------------------------------------------

describe("git_remote_list", () => {
  it("returns configured remote URL", async () => {
    const bare = makeBareRemote();
    const repo = tmp();
    initRepo(repo);
    git(repo, `git remote add origin ${bare}`);
    const out = await OBSERVATION_TOOLS.git_remote_list(ctx(repo));
    expect(out).toContain("origin");
    expect(out).toContain(bare);
  });

  it("returns sentinel when no remotes are configured", async () => {
    const repo = tmp();
    initRepo(repo);
    const out = await OBSERVATION_TOOLS.git_remote_list(ctx(repo));
    expect(out).toBe("(no remotes)");
  });
});

// ---------------------------------------------------------------------------
// read_gitignore
// ---------------------------------------------------------------------------

describe("read_gitignore", () => {
  it("returns .gitignore content", async () => {
    const repo = tmp();
    initRepo(repo);
    write(repo, ".gitignore", "node_modules\n*.log\n");
    const out = await OBSERVATION_TOOLS.read_gitignore(ctx(repo));
    expect(out).toContain("node_modules");
    expect(out).toContain("*.log");
  });

  it("returns a sentinel when .gitignore is absent", async () => {
    const out = await OBSERVATION_TOOLS.read_gitignore(ctx(tmp()));
    expect(out).toBe("(no .gitignore)");
  });

  it("truncates very large .gitignore files", async () => {
    const repo = tmp();
    initRepo(repo);
    const big = "pattern\n".repeat(500); // > 600 chars
    write(repo, ".gitignore", big);
    const out = await OBSERVATION_TOOLS.read_gitignore(ctx(repo));
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/truncated/);
  });
});
