/**
 * Two-tier git error recovery dispatcher.
 *
 * Strategy:
 *   1. classifyByRules — deterministic keyword match on the error text.
 *      If it returns confidence >= 4, execute the chosen tool immediately
 *      (no LLM call). 95% of real-world errors hit this fast path.
 *   2. If an AI provider is configured, run the ReAct loop. If the loop
 *      finishes "ready_to_retry", we are done.
 *   3. If rules had confidence 2-3 and we still don't have a recovery,
 *      fall back to executing the rules plan (LLM-less safety net).
 *
 * The caller (GitManager.sync) wraps this in a 2-attempt retry — see
 * GitManager.ts:558. GitConflictError never reaches this dispatcher; user
 * content conflicts surface to the ConflictModal.
 */

import type { SimpleGit } from "simple-git";
import type { AIProvider } from "../ai/AIProvider";
import { RECOVERY_TOOLS, type RecoveryContext } from "./recoveryTools";
import { GitReActAgent } from "./GitReActAgent";
import type { EventLog } from "../observability/EventLog";

export interface RecoveryPlan {
  tool: string;
  params: Record<string, string>;
  reasoning: string;
  confidence: number;
}

/**
 * Tiny rule classifier — only matches the one error class that doesn't
 * benefit from an LLM round-trip: stale lock files left by a crashed git
 * process. Lock-file errors are common (every Obsidian-quit-mid-sync),
 * unambiguous (one signal → one tool), and don't risk data loss.
 *
 * Every other error class is now routed through the ReAct loop where the
 * model picks `git_exec` args (or one of the specialised fs tools). The
 * previous 16-rule table was deleted: too brittle, too many edge cases,
 * model handles them better with observations.
 */
export function classifyByRules(error: string): RecoveryPlan {
  const m = error.toLowerCase();
  if (m.includes("index.lock") || m.includes("another git process") || m.includes("unable to lock ref")) {
    return { tool: "clear_lock", params: {}, reasoning: "Stale lock file blocks git operation", confidence: 5 };
  }
  return { tool: "no_recovery", params: {}, reasoning: "No matching rule — route through agent", confidence: 0 };
}

export class GitErrorAgent {
  private reactAgent: GitReActAgent;

  constructor(
    private git: SimpleGit,
    private vaultPath: string,
    providers: AIProvider[] = [],
    private eventLog: EventLog | null = null,
    private repoId = "main",
  ) {
    this.reactAgent = new GitReActAgent(git, vaultPath, providers, eventLog, repoId);
  }

  /**
   * Attempt to recover from a git error.
   * Returns true if a recovery action was executed (caller should retry).
   * Returns false if no recovery is possible.
   */
  async tryRecover(
    error: Error,
    operation: string,
    branch: string,
    remoteUrl?: string,
  ): Promise<boolean> {
    const errMsg = error.message || String(error);
    const rules = classifyByRules(errMsg);

    this.eventLog?.log({
      kind: "recovery_attempt",
      repo: this.repoId,
      operation,
      branch,
      error: errMsg.slice(0, 500),
      ruleTool: rules.tool,
      ruleConfidence: rules.confidence,
      path: rules.confidence >= 5 ? "rule_fast" : this.reactAgent.hasProvider() ? "agent" : "no_recovery",
    });

    if (rules.confidence >= 5) {
      return this.executeRecovery(rules, branch, remoteUrl);
    }

    if (this.reactAgent.hasProvider()) {
      const trace = await this.reactAgent.run(errMsg, operation, branch, remoteUrl);
      if (trace.outcome === "ready_to_retry") return true;
    }

    return false;
  }

  private async executeRecovery(plan: RecoveryPlan, branch: string, remoteUrl?: string): Promise<boolean> {
    const executor = RECOVERY_TOOLS[plan.tool];
    if (!executor) return false;
    try {
      const ctx: RecoveryContext = { git: this.git, vaultPath: this.vaultPath, branch, remoteUrl };
      await executor(ctx, plan.params);
      return true;
    } catch (recoveryErr) {
      console.warn(
        `[agentic-git-sync] Recovery tool '${plan.tool}' failed:`,
        (recoveryErr as Error).message,
      );
      return false;
    }
  }
}
