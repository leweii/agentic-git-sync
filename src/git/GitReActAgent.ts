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
import type { EventLog } from "../observability/EventLog";
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
  type ObservationContext,
} from "./observationTools";

const MAX_STEPS = 5;
const MAX_OBSERVATIONS_IN_A_ROW = 3;
const WALL_CLOCK_BUDGET_MS = 15_000;
const TRACE_RETENTION = 50;

const TRACE_SUBDIR = path.join(
  ".obsidian",
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
    if (s.observation) parts.push(s.observation);
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

export class GitReActAgent {
  private providers: AIProvider[];

  constructor(
    private git: SimpleGit,
    private vaultPath: string,
    providers: AIProvider[] = [],
    private eventLog: EventLog | null = null,
    private repoId = "main",
  ) {
    this.providers = providers.filter((p) => p.isAvailable());
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
    const startedAt = Date.now();
    const trace: ReactStep[] = [];
    let outcome: ReactTrace["outcome"] = "gave_up";
    let reason = "no steps taken";

    for (let i = 0; i < MAX_STEPS; i++) {
      if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
        outcome = "guardrail_aborted";
        reason = "wall-clock budget exceeded";
        break;
      }

      let step: ReactStep;
      try {
        step = await this.callModel(initialError, operation, branch, trace);
      } catch (e) {
        outcome = "gave_up";
        reason = `all providers failed: ${(e as Error).message}`;
        break;
      }

      const block = this.guardrail(step, trace, initialError);
      if (block) {
        outcome = "guardrail_aborted";
        reason = block;
        trace.push({ ...step, observation: `blocked: ${block}` });
        this.logStep(i + 1, step, `blocked: ${block}`);
        break;
      }

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

      // Execute the chosen tool.
      const observation = await this.executeTool(step, branch, remoteUrl);
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
  ): Promise<ReactStep> {
    const user = buildReactStepPrompt(initialError, operation, branch, steps);
    const errors: string[] = [];
    for (const p of this.providers) {
      const start = Date.now();
      try {
        const raw = await p.complete(REACT_SYSTEM_PROMPT, user);
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

    // Catastrophic tool gate — strictest tier, checked before any other recovery
    // gate so the loop reports the most specific reason.
    if (CATASTROPHIC_TOOLS.has(step.action)) {
      if (step.confidence < 5) {
        return `catastrophic tool '${step.action}' requires confidence == 5`;
      }
      // Once-per-loop — any prior catastrophic step disqualifies a retry
      if (prev.some((s) => CATASTROPHIC_TOOLS.has(s.action))) {
        return `catastrophic tool '${step.action}' may only run once per loop`;
      }
      // EITHER fsck observed failure OR the initial error explicitly indicates
      // corruption. Both are sufficient on their own. Word boundaries avoid
      // matching "no errors" / "no missing" as a corruption signal.
      const corruptRe = /\b(error|missing|corrupt|broken|dangling)\b/i;
      const fsckStep = prev.find((s) => s.action === "git_fsck");
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
        const alreadyRan = prev.some((s) => s.action === step.action);
        if (alreadyRan) {
          return `recovery tool '${step.action}' already ran earlier in this loop`;
        }
      } else {
        // Same git_exec args twice — that's the loop-stuck pattern we want
        // to block. Different args are fine.
        const same = prev.find(
          (s) => s.action === "git_exec" && s.params.args === step.params.args,
        );
        if (same) {
          return `git_exec with the same args (${step.params.args}) already ran`;
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
      const tail = prev.slice(-MAX_OBSERVATIONS_IN_A_ROW);
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
      await RECOVERY_TOOLS[step.action](ctx, step.params);
      return "ok";
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  }

  private async persistTrace(trace: ReactTrace): Promise<void> {
    try {
      const dir = path.join(this.vaultPath, TRACE_SUBDIR);
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
