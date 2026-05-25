/* eslint-disable obsidianmd/no-nodejs-modules -- test harness runs in Node, not shipped in main.js */
/**
 * ReAct loop unit tests.
 *
 * Uses scripted AIProvider responses + a stub git that records but does not
 * execute. Real-git executor behaviour is covered in recoveryTools.test.ts /
 * observationTools.test.ts; here we focus on loop control, guardrails, and
 * trace persistence.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SimpleGit } from "simple-git";

import { GitReActAgent } from "./GitReActAgent";
import type { AIProvider, AISuggestion, AISuggestionRequest } from "../ai/AIProvider";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class ScriptedProvider implements AIProvider {
  readonly id = "scripted";
  readonly name = "Scripted";
  private queue: (string | Error)[];
  callLog: { user: string }[] = [];

  constructor(responses: (string | Error)[]) { this.queue = [...responses]; }
  isAvailable(): boolean { return true; }
  async suggest(_req: AISuggestionRequest): Promise<AISuggestion> { throw new Error("not used"); }
  async complete(_system: string, user: string): Promise<string> {
    this.callLog.push({ user });
    if (this.queue.length === 0) throw new Error("script exhausted");
    const next = this.queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }
}

class UnavailableProvider implements AIProvider {
  readonly id = "off";
  readonly name = "Off";
  isAvailable(): boolean { return false; }
  async suggest(_req: AISuggestionRequest): Promise<AISuggestion> { throw new Error("not used"); }
  async complete(): Promise<string> { throw new Error("never available"); }
}

function stubGit(): SimpleGit {
  const noop = () => Promise.resolve("");
  return {
    raw: noop,
    fetch: noop,
    pull: noop,
    push: noop,
    stash: noop,
    addConfig: noop,
  } as unknown as SimpleGit;
}

function tmpVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ghs-react-"));
}

function step(action: string, params: Record<string, string> = {}, confidence = 5, thought = ""): string {
  return JSON.stringify({ thought: thought || action, action, params, confidence });
}

/** Convenience for git_exec steps — wraps args array into the params shape. */
function exec(args: string[], confidence = 5): string {
  return step("git_exec", { args: JSON.stringify(args) }, confidence);
}

function tracesDir(vault: string): string {
  return path.join(vault, ".obsidian", "plugins", "agentic-git-sync", "agent-traces");
}

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

describe("GitReActAgent — happy paths", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("single-step: model picks a git_exec then finishes", async () => {
    const provider = new ScriptedProvider([
      exec(["merge", "--abort"]),
      step("finish", { outcome: "ready_to_retry" }),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("MERGE_HEAD exists", "sync", "main");

    expect(trace.outcome).toBe("ready_to_retry");
    expect(trace.steps.map((s) => s.action)).toEqual(["git_exec", "finish"]);
  });

  it("observation then recovery then finish", async () => {
    const provider = new ScriptedProvider([
      step("git_status"),
      exec(["merge", "--abort"]),
      step("finish", { outcome: "ready_to_retry" }),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("ambiguous error", "sync", "main");

    expect(trace.outcome).toBe("ready_to_retry");
    expect(trace.steps.map((s) => s.action)).toEqual(["git_status", "git_exec", "finish"]);
    expect(provider.callLog[2].user).toContain("Trace so far");
    expect(provider.callLog[2].user).toContain("git_exec");
  });

  it("model decides to give up — returns gave_up outcome", async () => {
    const provider = new ScriptedProvider([
      step("finish", { outcome: "give_up" }),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("pre-receive hook declined", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
  });

  it("multiple git_exec calls with different args are allowed in one loop", async () => {
    // git_exec is a meta-tool — different arg lists are different actions
    // and don't trip the once-per-loop guardrail.
    const provider = new ScriptedProvider([
      exec(["fetch", "origin"]),
      exec(["reset", "--hard", "origin/main"]),
      step("finish", { outcome: "ready_to_retry" }),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("non-fast-forward", "sync", "main");
    expect(trace.outcome).toBe("ready_to_retry");
    expect(trace.steps.filter((s) => s.action === "git_exec").length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

describe("GitReActAgent — guardrails", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("step budget exceeded when model keeps observing", async () => {
    const provider = new ScriptedProvider([
      step("git_status"),
      step("git_log_recent"),
      step("git_remote_state"),
      step("git_status"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).not.toBe("ready_to_retry");
    expect(trace.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("specialised tool repeated with observation in between is blocked", async () => {
    const provider = new ScriptedProvider([
      step("clear_lock"),
      step("git_status"),
      step("clear_lock"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("index.lock blocked", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/clear_lock.*already ran/);
  });

  it("specialised tool twice in a row is blocked", async () => {
    const provider = new ScriptedProvider([
      step("clear_lock"),
      step("clear_lock"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("index.lock", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/clear_lock.*already ran/);
  });

  it("git_exec with the SAME args twice is blocked", async () => {
    const provider = new ScriptedProvider([
      exec(["merge", "--abort"]),
      exec(["merge", "--abort"]),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("MERGE_HEAD", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/git_exec.*same args/);
  });

  it("destructive tool (skip_large_file) with confidence < 4 is blocked", async () => {
    const provider = new ScriptedProvider([
      step("skip_large_file", { filename: "big.bin" }, 3),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("GH001 Large files detected: big.bin", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/confidence/);
  });

  it("destructive tool without explicit error signal is blocked", async () => {
    const provider = new ScriptedProvider([
      step("skip_large_file", { filename: "big.bin" }, 5),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    // No GH001 / large file keywords in error → no destructive evidence
    const trace = await agent.run("some random error", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/signal/);
  });

  it("destructive tool with matching signal in initial error is allowed", async () => {
    const provider = new ScriptedProvider([
      step("skip_large_file", { filename: "big.bin" }, 5),
      step("finish", { outcome: "ready_to_retry" }),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run(
      "remote: error: GH001: Large files detected.",
      "sync",
      "main",
    );
    expect(trace.outcome).toBe("ready_to_retry");
  });

  it("skip_large_file without filename param is blocked", async () => {
    const provider = new ScriptedProvider([
      step("skip_large_file", {}, 5),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("GH001: Large files detected", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/filename/);
  });

  it("unknown tool name is blocked", async () => {
    const provider = new ScriptedProvider([
      step("nuke_repo", {}, 5),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/unknown tool/);
  });
});

// ---------------------------------------------------------------------------
// Provider behaviour
// ---------------------------------------------------------------------------

describe("GitReActAgent — provider behaviour", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("all providers fail → outcome gave_up", async () => {
    const provider = new ScriptedProvider([new Error("network down")]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("any error", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
    expect(trace.reason).toMatch(/network down|providers failed/);
  });

  it("first provider fails, second succeeds (fallback)", async () => {
    const p1 = new ScriptedProvider([new Error("auth")]);
    const p2 = new ScriptedProvider([step("finish", { outcome: "ready_to_retry" })]);
    const agent = new GitReActAgent(stubGit(), vault, [p1, p2]);
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).toBe("ready_to_retry");
  });

  it("unavailable providers are filtered out", () => {
    const agent = new GitReActAgent(stubGit(), tmpVault(), [new UnavailableProvider()]);
    expect(agent.hasProvider()).toBe(false);
  });

  it("invalid JSON from model is treated as give_up", async () => {
    const provider = new ScriptedProvider(["not even close to JSON"]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
  });
});

// ---------------------------------------------------------------------------
// Trace persistence
// ---------------------------------------------------------------------------

describe("GitReActAgent — trace persistence", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("writes a JSON trace file after each run", async () => {
    const provider = new ScriptedProvider([
      step("finish", { outcome: "ready_to_retry" }),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    await agent.run("err", "sync", "main");

    const dir = tracesDir(vault);
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    const trace = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
    expect(trace.outcome).toBe("ready_to_retry");
    expect(trace.steps.length).toBe(1);
    expect(trace.initialError).toBe("err");
  });

  it("rotates traces past the retention cap", async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 55 }, () => step("finish", { outcome: "ready_to_retry" })),
    );
    const agent = new GitReActAgent(stubGit(), vault, [provider]);

    for (let i = 0; i < 55; i++) {
      await agent.run(`err-${i}`, "sync", "main");
      const dir = tracesDir(vault);
      const files = fs.readdirSync(dir);
      const latest = files.sort().slice(-1)[0];
      const newTime = new Date(Date.now() + i * 1000);
      fs.utimesSync(path.join(dir, latest), newTime, newTime);
    }
    const dir = tracesDir(vault);
    const files = fs.readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// Catastrophic tier guardrails (reinit_from_remote)
// ---------------------------------------------------------------------------

describe("GitReActAgent — Catastrophic tier", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  function fakeGitWithFsck(fsckOutput: string): SimpleGit {
    return {
      raw: async (args: string[]) => {
        if (args[0] === "fsck") return fsckOutput;
        return "";
      },
      fetch: async () => "",
    } as unknown as SimpleGit;
  }

  function stepFor(trace: Awaited<ReturnType<GitReActAgent["run"]>>, action: string) {
    return trace.steps.find((s) => s.action === action);
  }

  it("blocks reinit_from_remote with confidence < 5", async () => {
    const provider = new ScriptedProvider([
      step("reinit_from_remote", {}, 4),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("fatal: not a git repository", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/confidence == 5/);
  });

  it("blocks reinit_from_remote without prior git_fsck or corruption signal", async () => {
    const provider = new ScriptedProvider([
      step("reinit_from_remote", {}, 5),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [provider]);
    const trace = await agent.run("error: failed to push some refs", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/git_fsck/);
  });

  it("blocks reinit_from_remote when git_fsck ran but reported no errors", async () => {
    const provider = new ScriptedProvider([
      step("git_fsck"),
      step("reinit_from_remote", {}, 5),
    ]);
    const agent = new GitReActAgent(fakeGitWithFsck("ok (no errors)"), vault, [provider]);
    const trace = await agent.run("ambiguous error", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/fsck failure/);
  });

  it("allows reinit_from_remote when initial error has explicit corruption signal", async () => {
    const provider = new ScriptedProvider([
      step("reinit_from_remote", {}, 5),
      step("finish", { outcome: "give_up" }),
    ]);
    const agent = new GitReActAgent(fakeGitWithFsck(""), vault, [provider]);
    const trace = await agent.run("fatal: not a git repository: '.'", "sync", "main");
    const reinitStep = stepFor(trace, "reinit_from_remote");
    expect(reinitStep).toBeDefined();
    expect(reinitStep!.observation).toMatch(/error/);
  });

  it("blocks a second reinit_from_remote attempt in the same loop", async () => {
    const provider = new ScriptedProvider([
      step("reinit_from_remote", {}, 5),
      step("reinit_from_remote", {}, 5),
    ]);
    const agent = new GitReActAgent(fakeGitWithFsck(""), vault, [provider]);
    const trace = await agent.run("fatal: bad object HEAD", "sync", "main", "https://example.com/repo.git");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/once per loop/);
  });
});
