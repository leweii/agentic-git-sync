import simpleGit, { type SimpleGit } from "simple-git";

/**
 * Env keys simple-git's unsafe-operations plugin refuses to forward (they
 * let git spawn arbitrary commands: editors, pagers, ssh wrappers, askpass,
 * config redirection). The plugin never needs any of them — every commit or
 * merge passes -m / --no-edit and nothing runs on a tty — so they are
 * dropped rather than allowlisted.
 */
const UNSAFE_ENV_KEY =
  /^(editor|pager|prefix|ssh_askpass|git_(editor|sequence_editor|askpass|pager|ssh|ssh_command|exec_path|external_diff|proxy_command|template_dir|config(_global|_system|_count)?))$/i;

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !UNSAFE_ENV_KEY.test(k)) out[k] = v;
  }
  return out;
}

/**
 * Construct a SimpleGit bound to `baseDir` with a deterministic child
 * environment:
 *
 *  - LC_ALL=C — error handling throughout the plugin (GitManager's string
 *    matching, classifyByRules, the ReAct agent's recipes) keys off git's
 *    English message text; a localized git would silently defeat all of it.
 *  - GIT_TERMINAL_PROMPT=0 — never let git attempt an interactive credential
 *    prompt; fail fast with an auth error the plugin knows how to route.
 *
 * simple-git replaces the child environment wholesale when `.env(object)`
 * is used, so the rest of process.env (PATH, HOME, …) is spread in — minus
 * the command-executing keys above.
 */
export function makeGit(baseDir: string): SimpleGit {
  return simpleGit(baseDir).env({
    ...childEnv(),
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
  });
}
