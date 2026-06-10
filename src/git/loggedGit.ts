/**
 * Wrap a SimpleGit instance so every method call is logged.
 *
 * Catches the entire git surface area (raw, pull, push, fetch, commit, add,
 * stash, addConfig, revparse, status, init, ...) without manually
 * instrumenting each call site. We intercept any function returned by the
 * SimpleGit instance, run the original, and log the result.
 *
 * simple-git methods return "chainable" objects that are also thenables.
 * Our code always `await`s them, so we hook into the promise resolution to
 * record success / failure / duration. Non-promise return values (chainable
 * objects used for further calls before awaiting) pass through unmodified;
 * the codebase doesn't use that pattern.
 */

import type { SimpleGit } from "simple-git";
import { EventLog, sanitizeArgs, sanitizeSecrets } from "../observability/EventLog";

/** Methods we don't want to log — too noisy / not actual git operations. */
const SKIP_METHODS = new Set<string>([
  "then",
  "catch",
  "finally",
  "constructor",
  "_getCommands",
  "outputHandler",
]);

export function wrapGitWithLogging(
  git: SimpleGit,
  log: EventLog,
  repoId: string,
): SimpleGit {
  return new Proxy(git, {
    get(target, prop, receiver) {
      const original: unknown = Reflect.get(target, prop, receiver);
      if (typeof original !== "function") return original;
      const name = String(prop);
      if (SKIP_METHODS.has(name) || name.startsWith("_")) {
        return original.bind(target) as (...args: unknown[]) => unknown;
      }

      return (...args: unknown[]) => {
        const start = Date.now();
        let result: unknown;
        try {
          result = original.apply(target, args);
        } catch (e) {
          scrubError(e);
          log.log({
            kind: "git_op",
            repo: repoId,
            method: name,
            args: sanitizeArgs(args),
            ms: Date.now() - start,
            ok: false,
            error: errSummary(e),
          });
          throw e;
        }

        // simple-git methods return a chainable/thenable. Tap into it.
        if (result && typeof (result as { then?: unknown }).then === "function") {
          return (result as Promise<unknown>).then(
            (v) => {
              log.log({
                kind: "git_op",
                repo: repoId,
                method: name,
                args: sanitizeArgs(args),
                ms: Date.now() - start,
                ok: true,
              });
              return v;
            },
            (e) => {
              scrubError(e);
              log.log({
                kind: "git_op",
                repo: repoId,
                method: name,
                args: sanitizeArgs(args),
                ms: Date.now() - start,
                ok: false,
                error: errSummary(e),
              });
              throw e;
            },
          );
        }

        // Non-promise return — log immediately. Used for sync ops like cwd().
        log.log({
          kind: "git_op",
          repo: repoId,
          method: name,
          args: sanitizeArgs(args),
          ms: Date.now() - start,
          ok: true,
        });
        return result;
      };
    },
  });
}

function errSummary(e: unknown): string {
  if (e instanceof Error) return sanitizeSecrets(e.message ?? String(e)).slice(0, 500);
  return sanitizeSecrets(String(e)).slice(0, 500);
}

/**
 * Scrub credentials out of the error in place before it propagates. git's
 * failures quote the insteadOf-rewritten transport URL — token included —
 * and this error text flows on to the recovery agent's LLM prompt, the UI,
 * and sync history. Mutating here cleans every downstream consumer at once.
 */
function scrubError(e: unknown): void {
  if (!(e instanceof Error)) return;
  if (typeof e.message === "string") e.message = sanitizeSecrets(e.message);
  if (typeof e.stack === "string") e.stack = sanitizeSecrets(e.stack);
}
