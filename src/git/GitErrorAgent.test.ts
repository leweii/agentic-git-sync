/* eslint-disable obsidianmd/no-nodejs-modules -- test harness runs in Node, not shipped in main.js */
/**
 * Unit tests for the (now tiny) rule classifier and the dispatcher.
 *
 * The classifier only fast-paths one thing: stale lock files. Every other
 * error is routed through the ReAct loop where the model picks git_exec
 * args.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SimpleGit } from "simple-git";

import { classifyByRules, GitErrorAgent } from "./GitErrorAgent";
import { GitConflictError } from "./GitManager";
import type { AIProvider, AISuggestion, AISuggestionRequest } from "../ai/AIProvider";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubProvider implements AIProvider {
  readonly id = "stub";
  readonly name = "Stub";
  private responses: string[];
  available = true;
  callLog: { system: string; user: string }[] = [];

  constructor(scripted: string[]) { this.responses = [...scripted]; }
  isAvailable(): boolean { return this.available; }
  async suggest(_req: AISuggestionRequest): Promise<AISuggestion> { throw new Error("not used"); }
  async complete(system: string, user: string): Promise<string> {
    this.callLog.push({ system, user });
    if (this.responses.length === 0) throw new Error("script exhausted");
    return this.responses.shift()!;
  }
}

function stubGit(): { git: SimpleGit; calls: string[] } {
  const calls: string[] = [];
  const fn = (label: string) => (...args: unknown[]) => {
    calls.push(`${label}:${JSON.stringify(args)}`);
    return Promise.resolve("");
  };
  const git = {
    raw: fn("raw"),
    fetch: fn("fetch"),
    pull: fn("pull"),
    push: fn("push"),
    stash: fn("stash"),
    addConfig: fn("addConfig"),
  } as unknown as SimpleGit;
  return { git, calls };
}

function tmpVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghs-erragent-"));
}

// ---------------------------------------------------------------------------
// classifyByRules — only one rule remains
// ---------------------------------------------------------------------------

describe("classifyByRules", () => {
  it("matches stale index.lock", () => {
    const plan = classifyByRules("fatal: Unable to create '.git/index.lock': File exists");
    expect(plan.tool).toBe("clear_lock");
    expect(plan.confidence).toBe(5);
  });

  it("matches 'Another git process' message", () => {
    const plan = classifyByRules("Another git process seems to be running in this repository");
    expect(plan.tool).toBe("clear_lock");
    expect(plan.confidence).toBe(5);
  });

  it("matches 'Unable to lock ref'", () => {
    const plan = classifyByRules("error: Unable to lock ref 'refs/heads/main'");
    expect(plan.tool).toBe("clear_lock");
    expect(plan.confidence).toBe(5);
  });

  it("no longer fast-paths MERGE_HEAD — routes through agent", () => {
    const plan = classifyByRules("fatal: You have not concluded your merge (MERGE_HEAD exists)");
    expect(plan.confidence).toBe(0);
    expect(plan.tool).toBe("no_recovery");
  });

  it("no longer fast-paths non-fast-forward — routes through agent", () => {
    const plan = classifyByRules("! [rejected] main -> main (non-fast-forward)");
    expect(plan.confidence).toBe(0);
  });

  it("no longer fast-paths unrelated histories — routes through agent", () => {
    const plan = classifyByRules("fatal: refusing to merge unrelated histories");
    expect(plan.confidence).toBe(0);
  });

  it("unknown error returns no_recovery, confidence 0", () => {
    const plan = classifyByRules("fatal: something completely unexpected");
    expect(plan.confidence).toBe(0);
    expect(plan.tool).toBe("no_recovery");
  });
});

// ---------------------------------------------------------------------------
// tryRecover — dispatch
// ---------------------------------------------------------------------------

describe("GitErrorAgent.tryRecover dispatch", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("clear_lock fast-paths without calling LLM", async () => {
    const { git } = stubGit();
    const provider = new StubProvider([]); // would throw if called
    const agent = new GitErrorAgent(git, vault, [provider]);

    const ok = await agent.tryRecover(
      new Error("fatal: Unable to create '.git/index.lock': File exists"),
      "sync",
      "main",
    );
    expect(ok).toBe(true);
    expect(provider.callLog.length).toBe(0);
  });

  it("non-lock error routes through ReAct (used to fast-path on confidence-4 rules)", async () => {
    const { git } = stubGit();
    const provider = new StubProvider([
      JSON.stringify({
        thought: "abort the merge",
        action: "git_exec",
        params: { args: JSON.stringify(["merge", "--abort"]) },
        confidence: 5,
      }),
      JSON.stringify({
        thought: "done",
        action: "finish",
        params: { outcome: "ready_to_retry" },
        confidence: 5,
      }),
    ]);
    const agent = new GitErrorAgent(git, vault, [provider]);

    const ok = await agent.tryRecover(
      new Error("fatal: You have not concluded your merge (MERGE_HEAD exists)"),
      "sync",
      "main",
    );
    expect(ok).toBe(true);
    expect(provider.callLog.length).toBe(2);
  });

  it("ReAct gives_up → returns false (no rule fallback for confidence-0)", async () => {
    const { git } = stubGit();
    const provider = new StubProvider([
      JSON.stringify({ thought: "no idea", action: "finish", params: { outcome: "give_up" }, confidence: 1 }),
    ]);
    const agent = new GitErrorAgent(git, vault, [provider]);
    const ok = await agent.tryRecover(
      new Error("fatal: something completely unexpected"),
      "sync",
      "main",
    );
    expect(ok).toBe(false);
  });

  it("no providers + non-lock error → returns false (no LLM-less fallback for non-lock)", async () => {
    const { git } = stubGit();
    const agent = new GitErrorAgent(git, vault, []);
    const ok = await agent.tryRecover(
      new Error("fatal: refusing to merge unrelated histories"),
      "sync",
      "main",
    );
    expect(ok).toBe(false);
  });

  it("GitConflictError with modify/delete now routes through the agent (was previously bypassed)", async () => {
    const { git } = stubGit();
    const provider = new StubProvider([
      JSON.stringify({
        thought: "modify/delete — take the delete",
        action: "git_exec",
        params: { args: JSON.stringify(["rm", "Cookbook Business KB README.md"]) },
        confidence: 5,
      }),
      JSON.stringify({
        thought: "commit the merge resolution",
        action: "git_exec",
        params: { args: JSON.stringify(["commit", "-m", "merge: resolve modify/delete"]) },
        confidence: 5,
      }),
      JSON.stringify({
        thought: "done",
        action: "finish",
        params: { outcome: "ready_to_retry" },
        confidence: 5,
      }),
    ]);
    const agent = new GitErrorAgent(git, vault, [provider]);
    const conflictErr = new GitConflictError(
      ["Cookbook Business KB README.md"],
      false,
      "CONFLICT (modify/delete): Cookbook Business KB README.md deleted in HEAD and modified in 92020d02.",
    );
    const ok = await agent.tryRecover(conflictErr, "sync", "jakob");
    expect(ok).toBe(true);
    // Three LLM calls — rm, commit, finish
    expect(provider.callLog.length).toBe(3);
    // The user prompt should include the CONFLICT (modify/delete) signal
    expect(provider.callLog[0].user).toContain("modify/delete");
  });

  it("GitConflictError with content conflict — agent gives up, original error propagates", async () => {
    const { git } = stubGit();
    const provider = new StubProvider([
      JSON.stringify({
        thought: "content conflict — ConflictModal handles this",
        action: "finish",
        params: { outcome: "give_up" },
        confidence: 5,
      }),
    ]);
    const agent = new GitErrorAgent(git, vault, [provider]);
    const conflictErr = new GitConflictError(
      ["notes/foo.md"],
      false,
      "CONFLICT (content): Merge conflict in notes/foo.md",
    );
    const ok = await agent.tryRecover(conflictErr, "sync", "main");
    expect(ok).toBe(false);
    expect(provider.callLog.length).toBe(1);
  });

  it("no providers + lock error → still runs (fast path is LLM-independent)", async () => {
    const { git } = stubGit();
    const agent = new GitErrorAgent(git, vault, []);
    const ok = await agent.tryRecover(
      new Error("fatal: Unable to create '.git/index.lock': File exists"),
      "sync",
      "main",
    );
    expect(ok).toBe(true);
  });
});
