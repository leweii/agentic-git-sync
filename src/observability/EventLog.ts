/**
 * Append-only JSONL session log.
 *
 * Captures everything that happens in the plugin so users can ship a single
 * log file when reporting bugs and we can replay the timeline. Each event is
 * one line of JSON. One file per day under
 *   <vault>/.obsidian/plugins/agentic-git-sync/event-log/YYYY-MM-DD.jsonl
 *
 * Retention: 7 days. Writes are synchronous (small lines, desktop only) so
 * a crash mid-operation still leaves a flushed log.
 */

import { fs, path } from "../node-builtins";

export type EventKind =
  | "user_action"
  | "git_op"
  | "agent_step"
  | "agent_trace_persisted"
  | "llm_call"
  | "sync_phase"
  | "sync_complete"
  | "recovery_attempt"
  | "error"
  | "info";

export interface BaseEvent {
  /** Unix ms timestamp. Auto-added. */
  ts?: number;
  /** Plugin-load UUID — groups events from one Obsidian session. Auto-added. */
  session?: string;
  kind: EventKind;
  /** Repo id (VAULT_REPO_ID or submodule id) when applicable. */
  repo?: string;
  /** Arbitrary payload — kind-specific fields. */
  [key: string]: unknown;
}

// Relative to the vault's config dir (e.g. `.obsidian`), which the caller
// passes in — Obsidian lets users rename it, so we never hardcode it.
const LOG_PLUGIN_SUBDIR = path.join("plugins", "agentic-git-sync", "event-log");
const RETENTION_DAYS = 7;

// Max characters per arg string in git_op events. Long file content / diffs
// shouldn't bloat the log.
const MAX_ARG_CHARS = 400;
const MAX_ARG_ITEMS = 25;

export class EventLog {
  private readonly session: string;
  private readonly dir: string;
  /** Captures very early events before vaultPath is available. Flushed on init(). */
  private buffer: BaseEvent[] = [];
  private ready = false;

  constructor(vaultPath: string, configDir: string) {
    this.session = generateSessionId();
    this.dir = path.join(vaultPath, configDir, LOG_PLUGIN_SUBDIR);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.ready = true;
      this.cleanupOld();
      // Mark session start so logs can be segmented by session.
      this.log({ kind: "info", subkind: "session_start", session: this.session });
      for (const evt of this.buffer) this.writeRaw(evt);
      this.buffer = [];
    } catch (e) {
      console.warn("[github-sync] EventLog could not initialise:", e);
    }
  }

  /**
   * Append an event. Synchronous fs write so it's flushed before any crash.
   * Errors are swallowed — logging must never break sync.
   */
  log(event: BaseEvent): void {
    const enriched: BaseEvent = {
      ts: Date.now(),
      session: this.session,
      ...event,
    };
    if (!this.ready) {
      this.buffer.push(enriched);
      return;
    }
    this.writeRaw(enriched);
  }

  /** Where the log file directory lives — surfaced in settings UI. */
  get directory(): string {
    return this.dir;
  }

  private writeRaw(event: BaseEvent): void {
    try {
      const file = path.join(this.dir, `${dateStamp(event.ts)}.jsonl`);
      // Sanitize the serialized line, not individual fields — every event
      // kind that can carry git's error text (which includes the
      // insteadOf-rewritten URL, token and all) is covered without each
      // call site having to remember.
      fs.appendFileSync(file, sanitizeSecrets(JSON.stringify(event)) + "\n");
    } catch (e) {
      console.warn("[github-sync] EventLog write failed:", e);
    }
  }

  private cleanupOld(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const full = path.join(this.dir, name);
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
        } catch { /* ok */ }
      }
    } catch { /* ok */ }
  }
}

/**
 * Trim arguments to a sensible size for the log. Strips credentials from
 * URLs (https://token@host) so PATs don't end up in plaintext logs.
 */
export function sanitizeArgs(args: unknown[]): unknown[] {
  const trimmed = args.length > MAX_ARG_ITEMS
    ? [...args.slice(0, MAX_ARG_ITEMS), `…(+${args.length - MAX_ARG_ITEMS} more)`]
    : args;
  return trimmed.map(sanitizeOne);
}

/**
 * Strip credentials from a string: URL userinfo (https://user:token@host) and
 * GitHub token prefixes. git prints the insteadOf-rewritten URL — embedded
 * token included — in its error messages, so this must be applied to every
 * sink that can carry git error text: log lines, agent prompts/observations,
 * UI messages, bug-report bundles.
 */
export function sanitizeSecrets(s: string): string {
  return s
    .replace(/(https?:\/\/)([^:@\s/]+:)?[^@\s/]+@/g, "$1<creds>@")
    .replace(/(github_pat_|ghp_|gho_|ghu_|ghs_)[A-Za-z0-9_]+/g, "<token>");
}

function sanitizeOne(v: unknown): unknown {
  if (typeof v === "string") {
    let s = sanitizeSecrets(v);
    if (s.length > MAX_ARG_CHARS) s = s.slice(0, MAX_ARG_CHARS) + "…";
    return s;
  }
  if (Array.isArray(v)) return v.slice(0, MAX_ARG_ITEMS).map(sanitizeOne);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeOne(val);
    }
    return out;
  }
  return v;
}

function dateStamp(ts: number): string {
  const d = new Date(ts);
  // YYYY-MM-DD in local time so daily files match the user's day.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
