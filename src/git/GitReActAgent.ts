/**
 * ReAct loop for git error recovery.
 *
 * Iterates Reason → Act → Observe up to `MAX_STEPS` times, choosing
 * observation tools (read-only) or recovery tools (write) at each step.
 * Code-level guardrails enforce the safety rules independently of the
 * prompt — the LLM is treated as an untrusted planner.
 *
 * Trace JSON is persisted under
 *   <vault>/.obsidian/plugins/agentic-git-sync/agent-traces/<iso>.json
 * with a rolling cap of TRACE_RETENTION files.
 */

import type { SimpleGit } from "simple-git";
import { fs, path } from "../node-builtins";
import type { AIProvider } from "../ai/AIProvider";
import { sanitizeSecrets, type EventLog } from "../observability/EventLog";
import {
  REACT_SYSTEM_PROMPT,
  buildReactStepPrompt,
  parseReactStep,
  type ReactStep,
  type ReactTrace,
} from "../ai/reactPrompt";
import {
  RECOVERY_TOOLS,
  DESTRUCTIVE_TOOLS,
  CATASTROPHIC_TOOLS,
  isRecoveryTool,
  type RecoveryContext,
} from "./recoveryTools";
import {
  OBSERVATION_TOOLS,
  isObservationTool,
  truncate,
  type ObservationContext,
} from "./observationTools";

const MAX_STEPS = 5;
const MAX_OBSERVATIONS_IN_A_ROW = 3;
// Two guardrail blocks in a row mean the model isn't reading the feedback —
// stop paying for LLM calls. A single block is fed back as an observation.
const MAX_CONSECUTIVE_BLOCKS = 2;
// Each provider call is individually bounded (requestUrl has no timeout, so a
// hung provider would otherwise stall sync indefinitely). With per-call
// timeouts in place the wall clock only needs to cap total loop time.
const PROVIDER_TIMEOUT_MS = 10_000;
const WALL_CLOCK_BUDGET_MS = 30_000;
const TRACE_RETENTION = 50;

// Relative to the vault's config dir (e.g. `.obsidian`), which is threaded in
// as `configDir` — Obsidian lets users rename it, so we never hardcode it.
const TRACE_PLUGIN_SUBDIR = path.join(
  "plugins",
  "agentic-git-sync",
  "agent-traces",
);

/**
 * Evidence the trace has accumulated so far, used to gate destructive tools.
 * We OR the original error with every prior observation.
 */
function accumulatedEvidence(initialError: string, steps: ReactStep[]): string {
  const parts = [initialError];
  for (const s of steps) {
    // Blocked steps never executed — and their block reason quotes the very
    // keywords the gates look for, so counting them would let one refusal
    // unlock the next attempt.
    if (s.observation && !s.observation.startsWith("blocked:")) parts.push(s.observation);
  }
  return parts.join("\n").toLowerCase();
}

const DESTRUCTIVE_EVIDENCE: Record<string, RegExp[]> = {
  // The remaining destructive tool. `reset_to_remote` / `force_push_with_lease`
  // were moved into git_exec (model picks the args) — git_exec isn't tier-gated
  // by error keyword because the model has full visibility and the executor
  // refuses the only truly irreversible op (`git clean`).
  skip_large_file: [
    /gh001/,
    /large files? detected/,
    /file size limit/,
    /exceeds github/,
  ],
};

function hasDestructiveEvidence(tool: string, evidence: string): boolean {
  const patterns = DESTRUCTIVE_EVIDENCE[tool];
  if (!patterns) return false;
  return patterns.some((re) => re.test(evidence));
}

/**
 * git_exec arg lists that discard work the reflog can't restore — uncommitted
 * working-tree changes (reset --hard) or remote history on hosts that don't
 * expose a reflog (force push). They ride the same evidence gate as the
 * specialised destructive tools. Evidence is matched against lowercased text.
 */
function dangerousGitExec(
  argsJson: string | undefined,
): { label: string; evidence: RegExp[] } | null {
  let args: unknown;
  try {
    args = JSON.parse(argsJson ?? "[]");
  } catch {
    return null; // executor rejects malformed args with its own message
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return null;
  const list = args as string[];
  const cmd = list.find((a) => !a.startsWith("-"));
  if (cmd === "reset" && list.includes("--hard")) {
    return {
      label: "git reset --hard",
      // "behind" needs a non-zero count nearby: git_remote_state emits
      // "behind=0" / "behind=?" on every call, which is not evidence.
      evidence: [/non-fast-forward/, /\[rejected\]/, /behind\D{0,20}[1-9]/, /diverged/],
    };
  }
  if (cmd === "push" && list.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease"))) {
    return {
      label: "force push",
      evidence: [/non-fast-forward/, /\[rejected\]/, /diverged/, /stale info/],
    };
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { window.clearTimeout(t); resolve(v); },
      (e) => { window.clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

export interface AgentBudgets {
  wallClockMs?: number;
  providerTimeoutMs?: number;
}

export class GitReActAgent {
  private providers: AIProvider[];
  private wallClockMs: number;
  private providerTimeoutMs: number;

  constructor(
    private git: SimpleGit,
    private vaultPath: string,
    providers: AIProvider[] = [],
    private eventLog: EventLog | null = null,
    private repoId = "main",
    // Vault config dir (e.g. `.obsidian`). Empty in tests, where traces aren't asserted.
    private configDir = "",
    budgets: AgentBudgets = {},
  ) {
    this.providers = providers.filter((p) => p.isAvailable());
    this.wallClockMs = budgets.wallClockMs ?? WALL_CLOCK_BUDGET_MS;
    this.providerTimeoutMs = budgets.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
  }

  hasProvider(): boolean {
    return this.providers.length > 0;
  }

  async run(
    initialError: string,
    operation: string,
    branch: string,
    remoteUrl?: string,
  ): Promise<ReactTrace> {
    // Everything that reaches the model or the persisted trace must be free
    // of credentials. loggedGit scrubs git errors at the source, but this
    // agent can be constructed without an EventLog — sanitize here too.
    initialError = sanitizeSecrets(initialError);
    const startedAt = Date.now();
    const deadline = startedAt + this.wallClockMs;
    const trace: ReactStep[] = [];
    let outcome: ReactTrace["outcome"] = "gave_up";
    let reason = "no steps taken";
    let blockedStreak = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      if (Date.now() > deadline) {
        outcome = "guardrail_aborted";
        reason = "wall-clock budget exceeded";
        break;
      }

      let step: ReactStep;
      try {
        step = await this.callModel(initialError, operation, branch, trace, deadline);
      } catch (e) {
        outcome = "gave_up";
        reason = `all providers failed: ${(e as Error).message}`;
        break;
      }

      // A blocked step is fed back as an observation so the model can correct
      // course (it still consumes a step). Two blocks in a row mean it isn't
      // reading the feedback — abort rather than burn the remaining budget.
      const block = this.guardrail(step, trace, initialError);
      if (block) {
        blockedStreak++;
        trace.push({ ...step, observation: `blocked: ${block}` });
        this.logStep(i + 1, step, `blocked: ${block}`);
        if (blockedStreak >= MAX_CONSECUTIVE_BLOCKS) {
          outcome = "guardrail_aborted";
          reason = block;
          break;
        }
        continue;
      }
      blockedStreak = 0;

      // Terminal action — record but do not execute.
      if (step.action === "finish") {
        const o = step.params.outcome === "ready_to_retry" ? "ready_to_retry" : "gave_up";
        outcome = o;
        reason = step.thought || "model chose to finish";
        const finishObs = `finished with ${o}`;
        trace.push({ ...step, observation: finishObs });
        this.logStep(i + 1, step, finishObs);
        break;
      }

      // Execute the chosen tool. Observations can quote credential-bearing
      // text (git error URLs, `git config --list` via git_exec) — sanitize
      // before the model or the trace file sees them.
      const observation = sanitizeSecrets(await this.executeTool(step, branch, remoteUrl));
      trace.push({ ...step, observation });
      this.logStep(i + 1, step, observation);
    }

    if (trace.length >= MAX_STEPS && outcome === "gave_up") {
      outcome = "step_budget_exceeded";
      reason = "ran out of steps without finishing";
    }

    const finishedAt = Date.now();
    const fullTrace: ReactTrace = {
      startedAt,
      finishedAt,
      initialError,
      operation,
      branch,
      steps: trace,
      outcome,
      reason,
    };
    await this.persistTrace(fullTrace);
    this.eventLog?.log({
      kind: "agent_trace_persisted",
      repo: this.repoId,
      outcome,
      reason,
      steps: trace.length,
      durationMs: finishedAt - startedAt,
    });
    return fullTrace;
  }

  private logStep(stepNo: number, step: ReactStep, observation: string): void {
    this.eventLog?.log({
      kind: "agent_step",
      repo: this.repoId,
      step: stepNo,
      thought: step.thought.slice(0, 300),
      action: step.action,
      params: step.params,
      confidence: step.confidence,
      observation: observation.slice(0, 500),
    });
  }

  private async callModel(
    initialError: string,
    operation: string,
    branch: string,
    steps: ReactStep[],
    deadline: number,
  ): Promise<ReactStep> {
    const user = buildReactStepPrompt(initialError, operation, branch, steps);
    const errors: string[] = [];
    for (const p of this.providers) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        errors.push("wall-clock budget exhausted before trying remaining providers");
        break;
      }
      const start = Date.now();
      try {
        const raw = await withTimeout(
          p.complete(REACT_SYSTEM_PROMPT, user),
          Math.min(this.providerTimeoutMs, remaining),
          p.name,
        );
        this.eventLog?.log({
          kind: "llm_call",
          repo: this.repoId,
          provider: p.id,
          providerName: p.name,
          systemChars: REACT_SYSTEM_PROMPT.length,
          userChars: user.length,
          responseChars: raw?.length ?? 0,
          ms: Date.now() - start,
          ok: !!raw,
        });
        if (raw) return parseReactStep(raw);
      } catch (e) {
        this.eventLog?.log({
          kind: "llm_call",
          repo: this.repoId,
          provider: p.id,
          providerName: p.name,
          systemChars: REACT_SYSTEM_PROMPT.length,
          userChars: user.length,
          ms: Date.now() - start,
          ok: false,
          error: (e as Error).message?.slice(0, 300),
        });
        errors.push(`${p.name}: ${(e as Error).message}`);
      }
    }
    throw new Error(errors.join("; ") || "no providers available");
  }

  /**
   * Returns null if the step is allowed, or a short reason string if blocked.
   */
  guardrail(step: ReactStep, prev: ReactStep[], initialError: string): string | null {
    // finish is always allowed
    if (step.action === "finish") return null;

    // Unknown tool
    if (!isObservationTool(step.action) && !isRecoveryTool(step.action)) {
      return `unknown tool '${step.action}'`;
    }

    // Blocked steps are feedback, not history — they never executed, so they
    // must not count toward once-per-loop / same-args / observation checks.
    const executed = prev.filter((s) => !s.observation?.startsWith("blocked:"));

    // Catastrophic tool gate — strictest tier, checked before any other recovery
    // gate so the loop reports the most specific reason.
    if (CATASTROPHIC_TOOLS.has(step.action)) {
      if (step.confidence < 5) {
        return `catastrophic tool '${step.action}' requires confidence == 5`;
      }
      // Once-per-loop — any prior catastrophic step disqualifies a retry
      if (executed.some((s) => CATASTROPHIC_TOOLS.has(s.action))) {
        return `catastrophic tool '${step.action}' may only run once per loop`;
      }
      // EITHER fsck observed failure OR the initial error explicitly indicates
      // corruption. Both are sufficient on their own. Word boundaries avoid
      // matching "no errors" / "no missing" as a corruption signal.
      const corruptRe = /\b(error|missing|corrupt|broken|dangling)\b/i;
      const fsckStep = executed.find((s) => s.action === "git_fsck");
      const fsckFailed = fsckStep ? corruptRe.test(fsckStep.observation ?? "") : false;
      const initialIndicatesCorruption = /not a git repository|bad object|index file corrupt/i.test(
        initialError,
      );
      if (!fsckFailed && !initialIndicatesCorruption) {
        return `catastrophic tool '${step.action}' requires git_fsck failure or explicit corruption signal in the error`;
      }
    } else if (isRecoveryTool(step.action)) {
      // Specialised tools may run AT MOST ONCE per loop. git_exec is the
      // meta-tool — different arg lists are different actions, so we don't
      // gate it here. (The step budget caps total work, and the executor
      // refuses dangerous commands.)
      if (step.action !== "git_exec") {
        const alreadyRan = executed.some((s) => s.action === step.action);
        if (alreadyRan) {
          return `recovery tool '${step.action}' already ran earlier in this loop`;
        }
      } else {
        // Same git_exec args twice — that's the loop-stuck pattern we want
        // to block. Different args are fine.
        const same = executed.find(
          (s) => s.action === "git_exec" && s.params.args === step.params.args,
        );
        if (same) {
          return `git_exec with the same args (${step.params.args}) already ran`;
        }
        // History/working-tree-discarding arg lists ride the destructive
        // evidence gate — uncommitted changes aren't in the reflog, and
        // GitHub exposes no remote reflog after a force push.
        const danger = dangerousGitExec(step.params.args);
        if (danger) {
          if (step.confidence < 4) {
            return `${danger.label} requires confidence >= 4`;
          }
          const evidence = accumulatedEvidence(initialError, prev);
          if (!danger.evidence.some((re) => re.test(evidence))) {
            return `${danger.label} requires a non-fast-forward/behind/diverged signal in the error or observations`;
          }
        }
      }
    }

    // Destructive tool gate
    if (DESTRUCTIVE_TOOLS.has(step.action)) {
      if (step.confidence < 4) {
        return `destructive tool '${step.action}' requires confidence >= 4`;
      }
      const evidence = accumulatedEvidence(initialError, prev);
      if (!hasDestructiveEvidence(step.action, evidence)) {
        return `destructive tool '${step.action}' requires explicit error signal`;
      }
      // skip_large_file additionally requires a filename param
      if (step.action === "skip_large_file" && !step.params.filename?.trim()) {
        return "skip_large_file requires params.filename";
      }
    }

    // Too many consecutive observations
    if (isObservationTool(step.action)) {
      const tail = executed.slice(-MAX_OBSERVATIONS_IN_A_ROW);
      if (
        tail.length >= MAX_OBSERVATIONS_IN_A_ROW &&
        tail.every((s) => isObservationTool(s.action))
      ) {
        return `too many consecutive observations (>= ${MAX_OBSERVATIONS_IN_A_ROW})`;
      }
    }

    return null;
  }

  private async executeTool(step: ReactStep, branch: string, remoteUrl?: string): Promise<string> {
    try {
      if (isObservationTool(step.action)) {
        const ctx: ObservationContext = { git: this.git, vaultPath: this.vaultPath, branch };
        return await OBSERVATION_TOOLS[step.action](ctx);
      }
      const ctx: RecoveryContext = { git: this.git, vaultPath: this.vaultPath, branch, remoteUrl };
      // Tools report what they actually did (git_exec returns stdout) — the
      // model needs that to tell "fixed it" from "ran but changed nothing".
      const result = await RECOVERY_TOOLS[step.action](ctx, step.params);
      return typeof result === "string" && result.trim() ? truncate(result.trim()) : "ok";
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  }

  private async persistTrace(trace: ReactTrace): Promise<void> {
    try {
      const dir = path.join(this.vaultPath, this.configDir, TRACE_PLUGIN_SUBDIR);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(trace.startedAt).toISOString().replace(/[:.]/g, "-");
      const file = path.join(dir, `${stamp}.json`);
      fs.writeFileSync(file, JSON.stringify(trace, null, 2));
      this.rotateTraces(dir);
    } catch {
      // Trace persistence is best-effort; never fail recovery because the log
      // could not be written.
    }
  }

  private rotateTraces(dir: string): void {
    try {
      const entries = fs.readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const e of entries.slice(TRACE_RETENTION)) {
        try { fs.unlinkSync(path.join(dir, e.n)); } catch { /* ok */ }
      }
    } catch { /* ok */ }
  }
}
