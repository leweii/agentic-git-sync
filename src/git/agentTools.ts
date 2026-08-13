/**
 * pi-agent-core tool definitions for the git error-recovery agent.
 *
 * Thin declarative wrappers: schemas + descriptions live here, the actual
 * executors stay in observationTools.ts / recoveryTools.ts (which also serve
 * the LLM-less rules fast path in GitErrorAgent). Tool arguments arrive as
 * native tool calls — already validated against the JSON schemas below by
 * pi-ai's `validateToolArguments` before `execute` runs.
 *
 * Schemas are hand-written JSON Schema cast to TSchema instead of TypeBox
 * builders: pi's validator has a first-class plain-JSON-Schema path, and
 * skipping the builder keeps ~350KB of typebox out of the plugin bundle.
 * Stick to the portable core (type/description/properties/required/items/
 * enum) — GeminiBackend feeds these to an OpenAPI-subset endpoint.
 *
 * Safety gates (confidence tiers, evidence, once-per-loop) are NOT here —
 * GitReActAgent enforces them in its beforeToolCall hook, because the LLM
 * is an untrusted planner and tool-level checks can't see the whole trace.
 */

import type { TSchema } from "typebox";
import type { SimpleGit } from "simple-git";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { OBSERVATION_TOOLS, type ObservationContext } from "./observationTools";
import { RECOVERY_TOOLS, type RecoveryContext } from "./recoveryTools";

export type FinishOutcome = "ready_to_retry" | "give_up";

export interface AgentToolsContext {
  git: SimpleGit;
  vaultPath: string;
  branch: string;
  remoteUrl?: string;
  /** Called when the model invokes `finish`; the loop ends after this batch. */
  onFinish: (outcome: FinishOutcome, reason: string) => void;
}

/** Integer 0–5 self-assessment; guardrails gate destructive tools on it. */
const CONFIDENCE = {
  type: "integer",
  minimum: 0,
  maximum: 5,
  description:
    "Your confidence (0-5) that this action is correct AND safe given the evidence so far. Destructive actions require >= 4, catastrophic ones == 5.",
};

const NO_PARAMS = { type: "object", properties: {} } as unknown;

function schema(properties: Record<string, unknown>, required: string[]): TSchema {
  return { type: "object", properties, required };
}

function textResult(text: string): AgentToolResult<{ observation: string }> {
  return { content: [{ type: "text", text }], details: { observation: text } };
}

/**
 * What each observation tool returns, shown to the model as the tool
 * description. Executors live in OBSERVATION_TOOLS under the same key.
 */
const OBSERVATION_DESCRIPTIONS: Record<string, string> = {
  git_status: "Read-only: porcelain v2 status, including branch and ahead/behind counts.",
  git_log_recent: "Read-only: the last 3 commits, one line each.",
  git_remote_state: 'Read-only: "ahead=N behind=M" relative to origin/<branch>.',
  list_git_dir:
    "Read-only: which marker files (MERGE_HEAD, lock files, rebase-merge/, …) exist under .git/.",
  read_gitignore: "Read-only: current .gitignore content.",
  git_fsck: "Read-only: repository integrity check — surfaces corrupt objects and missing refs.",
  git_reflog:
    "Read-only: last 10 reflog entries — reveals what the user did manually before the error.",
  git_diff_summary:
    "Read-only: --stat summary of changed tracked files (names + line counts only).",
  git_remote_list: "Read-only: output of git remote -v.",
};

export function buildAgentTools(ctx: AgentToolsContext): AgentTool[] {
  const obsCtx: ObservationContext = { git: ctx.git, vaultPath: ctx.vaultPath, branch: ctx.branch };
  const recCtx: RecoveryContext = {
    git: ctx.git,
    vaultPath: ctx.vaultPath,
    branch: ctx.branch,
    remoteUrl: ctx.remoteUrl,
  };

  const tools: AgentTool[] = [];

  for (const [name, description] of Object.entries(OBSERVATION_DESCRIPTIONS)) {
    tools.push({
      name,
      label: name,
      description,
      parameters: NO_PARAMS,
      execute: async () => textResult(await OBSERVATION_TOOLS[name](obsCtx)),
    });
  }

  tools.push({
    name: "git_exec",
    label: "git_exec",
    description: [
      "Run one git subcommand against the vault repo — your primary recovery tool.",
      "The runtime refuses: `git clean` (deletes untracked user data), global flags before",
      "the subcommand (-C, -c, --git-dir, …), and `git config` on alias/credential/",
      "command-executing keys. Everything else is allowed; be deliberate.",
      "Returns the command's stdout so you can tell 'fixed it' from 'ran but changed nothing'.",
    ].join(" "),
    parameters: schema(
      {
        args: {
          type: "array",
          items: { type: "string" },
          description:
            'Argument list without the leading "git", e.g. ["merge", "--abort"] or ["pull", "origin", "main", "--no-rebase"].',
        },
        confidence: CONFIDENCE,
      },
      ["args", "confidence"],
    ),
    execute: async (_id, params: { args: string[] }) => {
      // The shared executor (also used by the rules fast path) takes the
      // JSON-stringified form; native tool calls give us a real array.
      const out = await RECOVERY_TOOLS.git_exec(recCtx, { args: JSON.stringify(params.args) });
      return textResult(typeof out === "string" && out.trim() ? out.trim() : "ok");
    },
  });

  tools.push({
    name: "clear_lock",
    label: "clear_lock",
    description:
      "Delete stale .git/*.lock files older than 30 s. Use for 'index.lock' / 'Unable to lock ref' / 'Another git process'. Git has no command for this — direct fs mutation, at most once per loop.",
    parameters: NO_PARAMS,
    execute: async () => textResult(String((await RECOVERY_TOOLS.clear_lock(recCtx, {})) ?? "ok")),
  });

  tools.push({
    name: "repair_head",
    label: "repair_head",
    description:
      "Rewrite .git/HEAD to refs/heads/<branch>. Use when HEAD points at a missing/broken ref but commits exist. Never touches commit data. At most once per loop.",
    parameters: NO_PARAMS,
    execute: async () => textResult(String((await RECOVERY_TOOLS.repair_head(recCtx, {})) ?? "ok")),
  });

  tools.push({
    name: "skip_large_file",
    label: "skip_large_file",
    description:
      "DESTRUCTIVE (requires confidence >= 4 and a GH001/large-file signal in the error): add the file to .gitignore and remove it from the index. Use for 'GH001' / 'Large files detected'. The filename must be parseable from the error.",
    parameters: schema(
      {
        filename: {
          type: "string",
          description: "Vault-relative path of the oversized file, exactly as the error reports it.",
        },
        confidence: CONFIDENCE,
      },
      ["filename", "confidence"],
    ),
    execute: async (_id, params: { filename: string }) =>
      textResult(
        String((await RECOVERY_TOOLS.skip_large_file(recCtx, { filename: params.filename })) ?? "ok"),
      ),
  });

  tools.push({
    name: "reinit_from_remote",
    label: "reinit_from_remote",
    description:
      "CATASTROPHIC last resort (requires confidence == 5 plus a git_fsck failure or explicit corruption signal): backup .git/ to .git.broken-<ts>/, then init + fetch + reset from origin. Working-tree files untouched. ONLY for 'not a git repository' / 'bad object' / unrecoverable fsck corruption.",
    parameters: schema({ confidence: CONFIDENCE }, ["confidence"]),
    execute: async () =>
      textResult(String((await RECOVERY_TOOLS.reinit_from_remote(recCtx, {})) ?? "ok")),
  });

  tools.push({
    name: "finish",
    label: "finish",
    description:
      "End the recovery loop. outcome='ready_to_retry' when you believe the original git operation will now succeed; outcome='give_up' when no safe recovery is available (auth failures, LFS, protected branches, content conflicts, disk/network issues).",
    parameters: schema(
      {
        outcome: { type: "string", enum: ["ready_to_retry", "give_up"] },
        reason: {
          type: "string",
          description: "One short sentence: what state you observed and why this outcome follows.",
        },
      },
      ["outcome"],
    ),
    execute: async (_id, params: { outcome: FinishOutcome; reason?: string }) => {
      ctx.onFinish(
        params.outcome === "ready_to_retry" ? "ready_to_retry" : "give_up",
        params.reason ?? "model chose to finish",
      );
      return { ...textResult(`finished with ${params.outcome}`), terminate: true };
    },
  });

  return tools;
}
