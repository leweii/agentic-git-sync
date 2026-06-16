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
 *
 * The `config` array injects `-c <key>=<value>` before every git subcommand:
 *
 *  - credential.helper= (empty) — reset the inherited credential-helper chain
 *    so no helper runs. The plugin authenticates purely via inline `insteadOf`
 *    tokens; a helper is never needed. Crucially, leaving it enabled lets a
 *    GUI helper — Windows Git Credential Manager, macOS osxkeychain — pop an
 *    interactive account picker, which GIT_TERMINAL_PROMPT=0 does NOT suppress
 *    (that only gates git's own terminal prompt, not GUI helpers).
 *  - credential.interactive=false — belt-and-suspenders for GCM specifically.
 *
 * `-c` settings propagate to git subprocesses via GIT_CONFIG_PARAMETERS, so
 * this also disables the helper inside `git submodule add`'s clone subprocess.
 */
export function makeGit(baseDir: string): SimpleGit {
  return simpleGit(baseDir, {
    config: ["credential.helper=", "credential.interactive=false"],
    // simple-git's "unsafe" guard blocks any `-c credential.helper=` because a
    // helper can normally execute an arbitrary command. Our value is a
    // hardcoded EMPTY string — the safest possible setting (it disables every
    // helper, runs nothing) — so opting in here is intentional and safe.
    unsafe: { allowUnsafeCredentialHelper: true },
  }).env({
    ...childEnv(),
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
  });
}
