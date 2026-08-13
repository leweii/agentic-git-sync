/* eslint-disable obsidianmd/no-nodejs-modules -- test harness runs in Node, not shipped in main.js */
/**
 * Recovery-loop unit tests (pi-agent-core based).
 *
 * Uses scripted ToolCallBackends emitting native tool calls + a stub git that
 * records but does not execute. Real-git executor behaviour is covered in
 * recoveryTools.test.ts / observationTools.test.ts; here we focus on loop
 * control, guardrails, and trace persistence.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SimpleGit } from "simple-git";

import { GitReActAgent } from "./GitReActAgent";
import {
  ScriptedBackend,
  UnavailableBackend,
  HangingBackend,
  toolCallMessage,
  textMessage,
} from "../../test/scripted-backend";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

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

/** Model turn calling a tool. Confidence rides as a tool argument. */
function step(action: string, params: Record<string, unknown> = {}, confidence = 5, thought = "") {
  return toolCallMessage(action, { ...params, confidence }, thought || action);
}

/** Convenience for git_exec steps — args is a real array with native calling. */
function exec(args: string[], confidence = 5) {
  return toolCallMessage("git_exec", { args, confidence }, `git ${args.join(" ")}`);
}

function finish(outcome: "ready_to_retry" | "give_up") {
  return toolCallMessage("finish", { outcome }, "finishing");
}

const CONFIG_DIR = ".obsidian";

function tracesDir(vault: string): string {
  return path.join(vault, CONFIG_DIR, "plugins", "agentic-git-sync", "agent-traces");
}

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

describe("GitReActAgent — happy paths", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("single-step: model picks a git_exec then finishes", async () => {
    const backend = new ScriptedBackend([
      exec(["merge", "--abort"]),
      finish("ready_to_retry"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("MERGE_HEAD exists", "sync", "main");

    expect(trace.outcome).toBe("ready_to_retry");
    expect(trace.steps.map((s) => s.action)).toEqual(["git_exec", "finish"]);
  });

  it("observation then recovery then finish", async () => {
    const backend = new ScriptedBackend([
      step("git_status"),
      exec(["merge", "--abort"]),
      finish("ready_to_retry"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("ambiguous error", "sync", "main");

    expect(trace.outcome).toBe("ready_to_retry");
    expect(trace.steps.map((s) => s.action)).toEqual(["git_status", "git_exec", "finish"]);
    // The transcript replayed to the model carries the earlier tool calls.
    expect(backend.transcriptText(2)).toContain("git_exec");
    expect(backend.transcriptText(2)).toContain("git_status");
  });

  it("model decides to give up — returns gave_up outcome", async () => {
    const backend = new ScriptedBackend([finish("give_up")]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("pre-receive hook declined", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
  });

  it("multiple git_exec calls with different args are allowed in one loop", async () => {
    // git_exec is a meta-tool — different arg lists are different actions
    // and don't trip the once-per-loop guardrail.
    const backend = new ScriptedBackend([
      exec(["fetch", "origin"]),
      exec(["reset", "--hard", "origin/main"]),
      finish("ready_to_retry"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
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
    const backend = new ScriptedBackend([
      step("git_status"),
      step("git_log_recent"),
      step("git_remote_state"),
      step("git_status"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).not.toBe("ready_to_retry");
    expect(trace.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("a single blocked step is fed back — the model can correct course", async () => {
    // First attempt under-confident (blocked), second passes the gate.
    const backend = new ScriptedBackend([
      step("skip_large_file", { filename: "big.bin" }, 3),
      step("skip_large_file", { filename: "big.bin" }, 5),
      finish("ready_to_retry"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("GH001 Large files detected: big.bin", "sync", "main");
    expect(trace.outcome).toBe("ready_to_retry");
    expect(trace.steps[0].observation).toMatch(/^blocked: .*confidence/);
    // The blocked observation reached the model on the next call.
    expect(backend.transcriptText(1)).toContain("blocked:");
  });

  it("specialised tool repeated with observation in between is blocked", async () => {
    const backend = new ScriptedBackend([
      step("clear_lock"),
      step("git_status"),
      step("clear_lock"),
      step("clear_lock"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("index.lock blocked", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/clear_lock.*already ran/);
  });

  it("specialised tool retried twice after blocking aborts the loop", async () => {
    const backend = new ScriptedBackend([
      step("clear_lock"),
      step("clear_lock"),
      step("clear_lock"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("index.lock", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/clear_lock.*already ran/);
  });

  it("git_exec with the SAME args repeatedly is blocked", async () => {
    const backend = new ScriptedBackend([
      exec(["merge", "--abort"]),
      exec(["merge", "--abort"]),
      exec(["merge", "--abort"]),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("MERGE_HEAD", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/git_exec.*same args/);
  });

  it("destructive tool (skip_large_file) with confidence < 4 is blocked", async () => {
    const backend = new ScriptedBackend([
      step("skip_large_file", { filename: "big.bin" }, 3),
      step("skip_large_file", { filename: "big.bin" }, 3),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("GH001 Large files detected: big.bin", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/confidence/);
  });

  it("destructive tool without explicit error signal is blocked", async () => {
    const backend = new ScriptedBackend([
      step("skip_large_file", { filename: "big.bin" }, 5),
      step("skip_large_file", { filename: "big.bin" }, 5),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    // No GH001 / large file keywords in error → no destructive evidence
    const trace = await agent.run("some random error", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/signal/);
  });

  it("git_exec reset --hard without divergence evidence is blocked", async () => {
    const backend = new ScriptedBackend([
      exec(["reset", "--hard", "origin/main"]),
      exec(["reset", "--hard", "origin/main"], 4),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("some unrelated error", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/reset --hard.*signal/);
  });

  it("git_exec reset --hard with low confidence is blocked even with evidence", async () => {
    const backend = new ScriptedBackend([
      exec(["reset", "--hard", "origin/main"], 3),
      exec(["reset", "--hard", "origin/main"], 2),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("! [rejected] main -> main (non-fast-forward)", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/reset --hard.*confidence/);
  });

  it("git_exec force push without divergence evidence is blocked", async () => {
    const backend = new ScriptedBackend([
      exec(["push", "--force", "origin", "main"]),
      exec(["push", "-f", "origin", "main"]),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("some unrelated error", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/force push.*signal/);
  });

  it("destructive tool with matching signal in initial error is allowed", async () => {
    const backend = new ScriptedBackend([
      step("skip_large_file", { filename: "big.bin" }, 5),
      finish("ready_to_retry"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run(
      "remote: error: GH001: Large files detected.",
      "sync",
      "main",
    );
    expect(trace.outcome).toBe("ready_to_retry");
  });

  it("skip_large_file without filename fails schema validation before executing", async () => {
    // With native tool calling the parameter schema rejects the call — the
    // validation error is fed back like any tool failure and nothing runs.
    const backend = new ScriptedBackend([
      step("skip_large_file", {}, 5),
      finish("give_up"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("GH001: Large files detected", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
    expect(trace.steps[0].observation).toMatch(/filename/);
    expect(trace.steps[0].observation).toMatch(/^error:/);
  });

  it("whitespace-only filename passes the schema but is blocked by the guardrail", async () => {
    const backend = new ScriptedBackend([
      step("skip_large_file", { filename: "  " }, 5),
      step("skip_large_file", { filename: "  " }, 5),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("GH001: Large files detected", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/filename/);
  });

  it("unknown tool name is rejected without executing anything", async () => {
    // pi's loop refuses tool calls that don't match a declared tool and
    // feeds the error back to the model.
    const backend = new ScriptedBackend([
      step("nuke_repo", {}, 5),
      finish("give_up"),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
    expect(trace.steps[0].observation).toMatch(/error: .*nuke_repo.*not found/);
  });
});

// ---------------------------------------------------------------------------
// Provider behaviour
// ---------------------------------------------------------------------------

describe("GitReActAgent — provider behaviour", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("all providers fail → outcome gave_up", async () => {
    const backend = new ScriptedBackend([new Error("network down")]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("any error", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
    expect(trace.reason).toMatch(/network down|providers failed/);
  });

  it("first provider fails, second succeeds (fallback)", async () => {
    const p1 = new ScriptedBackend([new Error("auth")], "p1", "P1");
    const p2 = new ScriptedBackend([finish("ready_to_retry")], "p2", "P2");
    const agent = new GitReActAgent(stubGit(), vault, [p1, p2]);
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).toBe("ready_to_retry");
  });

  it("unavailable providers are filtered out", () => {
    const agent = new GitReActAgent(stubGit(), tmpVault(), [new UnavailableBackend()]);
    expect(agent.hasProvider()).toBe(false);
  });

  it("model answering in prose without a tool call is treated as give_up", async () => {
    const backend = new ScriptedBackend([textMessage("I cannot recover this repository.")]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
    expect(trace.reason).toMatch(/without calling finish/);
  });
});

// ---------------------------------------------------------------------------
// Trace persistence
// ---------------------------------------------------------------------------

describe("GitReActAgent — trace persistence", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("writes a JSON trace file after each run", async () => {
    const backend = new ScriptedBackend([finish("ready_to_retry")]);
    const agent = new GitReActAgent(stubGit(), vault, [backend], null, "main", CONFIG_DIR);
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
    const backend = new ScriptedBackend(
      Array.from({ length: 55 }, () => finish("ready_to_retry")),
    );
    const agent = new GitReActAgent(stubGit(), vault, [backend], null, "main", CONFIG_DIR);

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
    const backend = new ScriptedBackend([
      step("reinit_from_remote", {}, 4),
      step("reinit_from_remote", {}, 4),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("fatal: not a git repository", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/confidence == 5/);
  });

  it("blocks reinit_from_remote without prior git_fsck or corruption signal", async () => {
    const backend = new ScriptedBackend([
      step("reinit_from_remote", {}, 5),
      step("reinit_from_remote", {}, 5),
    ]);
    const agent = new GitReActAgent(stubGit(), vault, [backend]);
    const trace = await agent.run("error: failed to push some refs", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/git_fsck/);
  });

  it("blocks reinit_from_remote when git_fsck ran but reported no errors", async () => {
    const backend = new ScriptedBackend([
      step("git_fsck"),
      step("reinit_from_remote", {}, 5),
      step("reinit_from_remote", {}, 5),
    ]);
    const agent = new GitReActAgent(fakeGitWithFsck("ok (no issues)"), vault, [backend]);
    const trace = await agent.run("ambiguous error", "sync", "main");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/fsck failure/);
  });

  it("allows reinit_from_remote when initial error has explicit corruption signal", async () => {
    const backend = new ScriptedBackend([
      step("reinit_from_remote", {}, 5),
      finish("give_up"),
    ]);
    const agent = new GitReActAgent(fakeGitWithFsck(""), vault, [backend]);
    const trace = await agent.run("fatal: not a git repository: '.'", "sync", "main");
    const reinitStep = stepFor(trace, "reinit_from_remote");
    expect(reinitStep).toBeDefined();
    expect(reinitStep!.observation).toMatch(/error/);
  });

  it("blocks a second reinit_from_remote attempt in the same loop", async () => {
    const backend = new ScriptedBackend([
      step("reinit_from_remote", {}, 5),
      step("reinit_from_remote", {}, 5),
      step("reinit_from_remote", {}, 5),
    ]);
    const agent = new GitReActAgent(fakeGitWithFsck(""), vault, [backend]);
    const trace = await agent.run("fatal: bad object HEAD", "sync", "main", "https://example.com/repo.git");
    expect(trace.outcome).toBe("guardrail_aborted");
    expect(trace.reason).toMatch(/once per loop/);
  });
});

// ---------------------------------------------------------------------------
// Provider timeouts & tool feedback
// ---------------------------------------------------------------------------

describe("GitReActAgent — timeouts & feedback", () => {
  let vault: string;
  beforeEach(() => { vault = tmpVault(); });

  it("a hung provider times out instead of stalling the loop", async () => {
    const agent = new GitReActAgent(
      stubGit(), vault, [new HangingBackend()], null, "main", "",
      { providerTimeoutMs: 50 },
    );
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).toBe("gave_up");
    expect(trace.reason).toMatch(/timed out/);
  });

  it("falls back to the next provider after a timeout", async () => {
    const good = new ScriptedBackend([finish("ready_to_retry")]);
    const agent = new GitReActAgent(
      stubGit(), vault, [new HangingBackend(), good], null, "main", "",
      { providerTimeoutMs: 50 },
    );
    const trace = await agent.run("error", "sync", "main");
    expect(trace.outcome).toBe("ready_to_retry");
  });

  it("credentials are scrubbed from the initial error and observations", async () => {
    const tokenUrl = "https://oauth2:ghp_secret123@github.com/leweii/notes.git";
    const gitStub = {
      raw: async () => { throw new Error(`fatal: unable to access '${tokenUrl}': 403`); },
    } as unknown as SimpleGit;
    const backend = new ScriptedBackend([
      exec(["pull", "origin", "main", "--no-rebase"]),
      finish("give_up"),
    ]);
    const agent = new GitReActAgent(gitStub, vault, [backend]);
    const trace = await agent.run(
      `error: failed to push some refs to '${tokenUrl}'`,
      "sync",
      "main",
    );

    expect(trace.initialError).not.toContain("ghp_secret123");
    expect(trace.steps[0].observation).not.toContain("ghp_secret123");
    // Nothing the model was sent may contain the token either.
    for (let i = 0; i < backend.callLog.length; i++) {
      expect(backend.transcriptText(i)).not.toContain("ghp_secret123");
    }
  });

  it("git_exec stdout is fed back as the observation", async () => {
    const gitStub = {
      raw: async () => "Already up to date.\n",
    } as unknown as SimpleGit;
    const backend = new ScriptedBackend([
      exec(["pull", "origin", "main", "--no-rebase"]),
      finish("ready_to_retry"),
    ]);
    const agent = new GitReActAgent(gitStub, vault, [backend]);
    const trace = await agent.run("err", "sync", "main");
    expect(trace.steps[0].observation).toBe("Already up to date.");
    // The model sees the stdout in the next turn's transcript.
    expect(backend.transcriptText(1)).toContain("Already up to date.");
  });
});
