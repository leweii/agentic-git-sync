/**
 * Git error-recovery loop on pi-agent-core.
 *
 * The Agent from pi-agent-core owns the Reason → Act → Observe cycle with
 * native tool calling; this class supplies the pieces around it:
 *   - streamFn: provider fan-out over ToolCallBackends (Obsidian requestUrl,
 *     per-call timeout, first available provider wins each step)
 *   - beforeToolCall: the guardrails — the LLM is an untrusted planner, so
 *     every safety rule is enforced in code independently of the prompt
 *   - afterToolCall: secret-scrubbing + truncation of tool output before the
 *     model or the persisted trace sees it
 *   - shouldStopAfterTurn: step budget / finish / abort
 *
 * Trace JSON (same ReactTrace shape as the pre-pi loop) is persisted under
 *   <vault>/.obsidian/plugins/agentic-git-sync/agent-traces/<iso>.json
 * with a rolling cap of TRACE_RETENTION files.
 */

import type { SimpleGit } from "simple-git";
import { fs, path } from "../node-builtins";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { BackendChatRequest, ToolCallBackend } from "../ai/piBackends";
import { sanitizeSecrets, type EventLog } from "../observability/EventLog";
import {
  REACT_SYSTEM_PROMPT,
  buildInitialPrompt,
  type ReactStep,
  type ReactTrace,
} from "../ai/reactPrompt";
import {
  DESTRUCTIVE_TOOLS,
  CATASTROPHIC_TOOLS,
  isRecoveryTool,
} from "./recoveryTools";
import { isObservationTool, truncate } from "./observationTools";
import { buildAgentTools, type FinishOutcome } from "./agentTools";

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
  const list = args;
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

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Placeholder Model for pi's Agent state. Provider routing happens inside our
 * streamFn (which fans out over the configured backends), so nothing reads
 * these fields — pi just requires a model on the loop config.
 */
const RECOVERY_MODEL: Model<Api> = {
  id: "agentic-git-sync-recovery",
  name: "Agentic Git Sync recovery backends",
  api: "anthropic-messages",
  provider: "agentic-git-sync",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1024,
};

export interface AgentBudgets {
  wallClockMs?: number;
  providerTimeoutMs?: number;
}

/** Per-run mutable state, so one GitReActAgent can serve sequential runs. */
interface RunState {
  initialError: string;
  deadline: number;
  steps: ReactStep[];
  byToolCallId: Map<string, ReactStep>;
  lastAssistantText: string;
  blockedStreak: number;
  finished?: { outcome: FinishOutcome; reason: string };
  abort?: { outcome: ReactTrace["outcome"]; reason: string };
  providerFailure?: string;
}

export class GitReActAgent {
  private backends: ToolCallBackend[];
  private wallClockMs: number;
  private providerTimeoutMs: number;

  constructor(
    private git: SimpleGit,
    private vaultPath: string,
    backends: ToolCallBackend[] = [],
    private eventLog: EventLog | null = null,
    private repoId = "main",
    // Vault config dir (e.g. `.obsidian`). Empty in tests, where traces aren't asserted.
    private configDir = "",
    budgets: AgentBudgets = {},
  ) {
    this.backends = backends.filter((b) => b.isAvailable());
    this.wallClockMs = budgets.wallClockMs ?? WALL_CLOCK_BUDGET_MS;
    this.providerTimeoutMs = budgets.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
  }

  hasProvider(): boolean {
    return this.backends.length > 0;
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
    const run: RunState = {
      initialError,
      deadline: startedAt + this.wallClockMs,
      steps: [],
      byToolCallId: new Map(),
      lastAssistantText: "",
      blockedStreak: 0,
    };

    const tools = buildAgentTools({
      git: this.git,
      vaultPath: this.vaultPath,
      branch,
      remoteUrl,
      onFinish: (outcome, reason) => {
        run.finished = { outcome, reason: sanitizeSecrets(reason) };
      },
    });

    const agent = new Agent({
      initialState: {
        systemPrompt: REACT_SYSTEM_PROMPT,
        model: RECOVERY_MODEL,
        tools,
        thinkingLevel: "off",
      },
      streamFn: this.makeStreamFn(run),
      // One tool at a time: guardrails reason about a linear trace, and a
      // recovery step's outcome must be observed before the next mutation.
      toolExecution: "sequential",
      beforeToolCall: async (c) => this.beforeToolCall(run, c),
      afterToolCall: async (c) => this.afterToolCall(c),
      shouldStopAfterTurn: async () =>
        !!run.finished || !!run.abort || run.steps.length >= MAX_STEPS,
    });

    this.subscribeTraceRecorder(agent, run);

    // The wall clock caps total loop time even if a backend ignores its
    // per-call timeout. The abort surfaces as a normal loop exit.
    const wallClockTimer = window.setTimeout(() => {
      run.abort ??= { outcome: "guardrail_aborted", reason: "wall-clock budget exceeded" };
      agent.abort();
    }, this.wallClockMs);

    try {
      await agent.prompt(buildInitialPrompt(initialError, operation, branch));
      await agent.waitForIdle();
    } catch (e) {
      run.providerFailure ??= (e as Error).message;
    } finally {
      window.clearTimeout(wallClockTimer);
    }

    const { outcome, reason } = this.resolveOutcome(run, agent.state.errorMessage);

    const finishedAt = Date.now();
    const fullTrace: ReactTrace = {
      startedAt,
      finishedAt,
      initialError,
      operation,
      branch,
      steps: run.steps,
      outcome,
      reason,
    };
    await this.persistTrace(fullTrace);
    this.eventLog?.log({
      kind: "agent_trace_persisted",
      repo: this.repoId,
      outcome,
      reason,
      steps: run.steps.length,
      durationMs: finishedAt - startedAt,
    });
    return fullTrace;
  }

  /**
   * Fold the run's end states into the ReactTrace outcome. Precedence:
   * explicit finish > guardrail/wall-clock abort > step budget > provider or
   * model failure.
   */
  private resolveOutcome(
    run: RunState,
    agentError: string | undefined,
  ): { outcome: ReactTrace["outcome"]; reason: string } {
    if (run.finished) {
      return {
        outcome: run.finished.outcome === "ready_to_retry" ? "ready_to_retry" : "gave_up",
        reason: run.finished.reason,
      };
    }
    if (run.abort) return { outcome: run.abort.outcome, reason: run.abort.reason };
    if (run.steps.length >= MAX_STEPS) {
      return { outcome: "step_budget_exceeded", reason: "ran out of steps without finishing" };
    }
    const failure = run.providerFailure ?? agentError;
    if (failure) return { outcome: "gave_up", reason: sanitizeSecrets(failure) };
    if (run.lastAssistantText) {
      return {
        outcome: "gave_up",
        reason: `model stopped without calling finish: ${sanitizeSecrets(run.lastAssistantText).slice(0, 300)}`,
      };
    }
    return { outcome: "gave_up", reason: "no steps taken" };
  }

  /**
   * Provider fan-out as a pi StreamFn: one non-streaming completion per turn,
   * first available backend wins, each attempt individually timed out.
   * Contract: never throws — failures become an `error` protocol event.
   */
  private makeStreamFn(run: RunState): StreamFn {
    return (_model, context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const req = contextToChatRequest(context);
        const errors: string[] = [];
        for (const backend of this.backends) {
          if (options?.signal?.aborted) break;
          const remaining = run.deadline - Date.now();
          if (remaining <= 0) {
            errors.push("wall-clock budget exhausted before trying remaining providers");
            break;
          }
          const start = Date.now();
          try {
            const message = await withTimeout(
              backend.chat(req),
              Math.min(this.providerTimeoutMs, remaining),
              backend.name,
            );
            this.eventLog?.log({
              kind: "llm_call",
              repo: this.repoId,
              provider: backend.id,
              providerName: backend.name,
              systemChars: req.system.length,
              userChars: JSON.stringify(req.messages).length,
              responseChars: JSON.stringify(message.content).length,
              ms: Date.now() - start,
              ok: true,
            });
            stream.push({ type: "start", partial: message });
            stream.push({
              type: "done",
              reason: message.stopReason === "toolUse" || message.stopReason === "length"
                ? message.stopReason
                : "stop",
              message,
            });
            return;
          } catch (e) {
            this.eventLog?.log({
              kind: "llm_call",
              repo: this.repoId,
              provider: backend.id,
              providerName: backend.name,
              systemChars: req.system.length,
              userChars: JSON.stringify(req.messages).length,
              ms: Date.now() - start,
              ok: false,
              error: (e as Error).message?.slice(0, 300),
            });
            errors.push(`${backend.name}: ${(e as Error).message}`);
          }
        }
        const reason = options?.signal?.aborted ? "aborted" : "error";
        const errorMessage = options?.signal?.aborted
          ? "recovery loop aborted"
          : `all providers failed: ${errors.join("; ") || "no providers available"}`;
        run.providerFailure ??= errorMessage;
        stream.push({
          type: "error",
          reason,
          error: {
            role: "assistant",
            content: [],
            api: RECOVERY_MODEL.api,
            provider: RECOVERY_MODEL.provider,
            model: RECOVERY_MODEL.id,
            usage: emptyUsage(),
            stopReason: reason,
            errorMessage,
            timestamp: Date.now(),
          },
        });
      })();
      return stream;
    };
  }

  /** Mirror pi's transcript into the ReactTrace step list + EventLog. */
  private subscribeTraceRecorder(agent: Agent, run: RunState): void {
    agent.subscribe((event) => {
      if (event.type === "message_end") {
        const m = event.message;
        if ("role" in m && m.role === "assistant") {
          const text = (m).content
            .filter((c) => c.type === "text")
            .map((c) => (c as { text: string }).text)
            .join(" ")
            .trim();
          if (text) run.lastAssistantText = sanitizeSecrets(text);
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        const args = (event.args ?? {}) as Record<string, unknown>;
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          params[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
        const step: ReactStep = {
          thought: run.lastAssistantText,
          action: event.toolName,
          params,
          confidence: clampConfidence(args.confidence),
          observation: undefined,
        };
        run.steps.push(step);
        run.byToolCallId.set(event.toolCallId, step);
        return;
      }
      if (event.type === "tool_execution_end") {
        const step = run.byToolCallId.get(event.toolCallId);
        if (!step) return;
        const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
        const text = (result?.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n")
          .trim();
        // Guardrail blocks keep their `blocked:` prefix (accumulatedEvidence
        // and the abort reason rely on it); other errors get `error:` so the
        // trace reads the same as the pre-pi loop.
        step.observation = event.isError && !text.startsWith("blocked:")
          ? `error: ${text || "tool failed"}`
          : text || "ok";
        this.eventLog?.log({
          kind: "agent_step",
          repo: this.repoId,
          step: run.steps.indexOf(step) + 1,
          thought: step.thought.slice(0, 300),
          action: step.action,
          params: step.params,
          confidence: step.confidence,
          observation: step.observation.slice(0, 500),
        });
      }
    });
  }

  /**
   * Guardrail hook. Returning `{block: true}` makes pi emit an error tool
   * result (our `blocked: …` reason) that feeds back to the model — a blocked
   * step still consumes budget, exactly like the pre-pi loop.
   */
  private beforeToolCall(run: RunState, c: BeforeToolCallContext): BeforeToolCallResult | undefined {
    const step = run.byToolCallId.get(c.toolCall.id);
    const prev = run.steps.filter((s) => s !== step && s.observation !== undefined);
    const current: ReactStep = step ?? {
      thought: "",
      action: c.toolCall.name,
      params: {},
      confidence: 0,
    };

    const block = this.guardrail(current, prev, run.initialError);
    if (!block) {
      run.blockedStreak = 0;
      return undefined;
    }

    run.blockedStreak++;
    if (run.blockedStreak >= MAX_CONSECUTIVE_BLOCKS) {
      run.abort ??= { outcome: "guardrail_aborted", reason: block };
      return { block: true, reason: `blocked: ${block}`, terminate: true };
    }
    return { block: true, reason: `blocked: ${block}` };
  }

  /**
   * Tool output can quote credential-bearing text (git error URLs,
   * `git config --list` via git_exec) — sanitize and cap it before the model
   * or the trace file sees it. Runs for executed tools and thrown errors;
   * guardrail blocks bypass it, but their text is our own reason string.
   */
  private afterToolCall(c: AfterToolCallContext): AfterToolCallResult | undefined {
    const content = c.result.content.map((block) =>
      block.type === "text" ? { ...block, text: truncate(sanitizeSecrets(block.text)) } : block,
    );
    return { content };
  }

  /**
   * Returns null if the step is allowed, or a short reason string if blocked.
   * Identical rules to the pre-pi loop; `prev` contains executed AND blocked
   * steps (blocked ones are filtered where the rule demands it).
   */
  guardrail(step: ReactStep, prev: ReactStep[], initialError: string): string | null {
    // finish is always allowed
    if (step.action === "finish") return null;

    // Unknown tool (pi also rejects these, but keep the tiered reason)
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
      const tail = prev.filter((s) => !s.observation?.startsWith("blocked:"))
        .slice(-MAX_OBSERVATIONS_IN_A_ROW);
      if (
        tail.length >= MAX_OBSERVATIONS_IN_A_ROW &&
        tail.every((s) => isObservationTool(s.action))
      ) {
        return `too many consecutive observations (>= ${MAX_OBSERVATIONS_IN_A_ROW})`;
      }
    }

    return null;
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

function clampConfidence(v: unknown): number {
  return Math.min(5, Math.max(0, Number(v) || 0));
}

/** pi Context → the neutral request shape ToolCallBackends consume. */
function contextToChatRequest(context: Context): BackendChatRequest {
  return {
    system: context.systemPrompt ?? REACT_SYSTEM_PROMPT,
    messages: context.messages,
    tools: (context.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };
}
