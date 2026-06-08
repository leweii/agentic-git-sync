import { requestUrl } from "obsidian";

/**
 * Parse owner/repo from any GitHub URL form we accept (https or ssh-style,
 * with or without `.git` suffix). Returns null when it doesn't look like
 * github.com.
 */
export function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * List all repositories visible to a PAT via `GET /user/repos`, paginated.
 * Returns repos grouped by owner login — the same shape as
 * `AppAuth.listAccessibleRepos()` so `RepoPickerModal` can use either source.
 *
 * Stops fetching on the first non-200 page and returns whatever was gathered.
 * Best-effort: network errors surface as an empty list.
 */
export async function listUserRepos(
  token: string,
): Promise<Array<{ login: string; repos: string[] }>> {
  if (!token) return [];
  const byLogin = new Map<string, string[]>();
  for (let page = 1; page <= 20; page++) {
    const res = await requestUrl({
      url: `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ObsidianGitHubSync",
      },
      throw: false,
    }).catch(() => null);
    if (!res || res.status !== 200) break;
    const repos = res.json as { full_name?: string }[] | null;
    if (!Array.isArray(repos) || repos.length === 0) break;
    for (const r of repos) {
      if (!r.full_name) continue;
      const slash = r.full_name.indexOf("/");
      if (slash < 0) continue;
      const login = r.full_name.slice(0, slash);
      const existing = byLogin.get(login);
      if (existing) existing.push(r.full_name);
      else byLogin.set(login, [r.full_name]);
    }
    if (repos.length < 100) break;
  }
  return Array.from(byLogin.entries()).map(([login, repos]) => ({ login, repos }));
}

/**
 * List the repositories an installation token can access
 * (`GET /installation/repositories`, paginated). Used to populate the
 * repo picker — the plugin holds the installation token, so this hits
 * GitHub directly with no extra backend endpoint.
 *
 * Returns full names ("owner/repo"). Best-effort: stops on the first
 * non-200 and returns whatever it gathered.
 */
export async function listInstallationRepos(token: string): Promise<string[]> {
  if (!token) return [];
  const names: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await requestUrl({
      url: `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ObsidianGitHubSync",
      },
      throw: false,
    }).catch(() => null);
    if (!res || res.status !== 200) break;
    const body = res.json as { repositories?: { full_name?: string }[] } | null;
    const repos = body?.repositories ?? [];
    for (const r of repos) if (r.full_name) names.push(r.full_name);
    if (repos.length < 100) break;
  }
  return names;
}

export interface RepoAccessCheck {
  ok: boolean;
  // populated when ok === true
  fullName?: string;
  canPush?: boolean;
  isEmpty?: boolean;
  // populated when ok === false
  status?: number;
  reason?: string;
}

// Minimal shape of the GitHub API responses we read. We only declare the
// fields actually accessed by the plugin — the real responses contain
// many more keys.
export interface GitHubUser {
  login: string;
  name?: string | null;
  email?: string | null;
}

interface GitHubRepo {
  full_name: string;
  permissions?: { push?: boolean };
}

interface GitHubErrorBody {
  message?: string;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

type TokenKind = "fine-grained" | "classic" | "other";

/**
 * Classify a GitHub token by its prefix. The distinction matters for 404
 * diagnostics: a fine-grained PAT (`github_pat_`) only sees repositories
 * explicitly added to its "Repository access" list, so "repo not found"
 * is most often a missing grant rather than a missing repo — which needs
 * very different remediation than a classic token.
 */
function classifyToken(token: string): TokenKind {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_") || /^[0-9a-f]{40}$/i.test(token)) return "classic";
  return "other";
}

/**
 * GitHub returns an identical 404 for "repo doesn't exist" and "repo
 * exists but this token isn't authorized to see it" — deliberately, so
 * private-repo existence can't be probed. That ambiguity is the single
 * most confusing failure for non-technical users, especially with
 * fine-grained PATs where the repo allowlist is easy to forget.
 *
 * We disambiguate as far as the API allows with two extra probes:
 *   1. GET /user with the token  → is the token itself valid at all?
 *   2. GET /repos/:o/:r WITHOUT auth → does the repo exist & is public?
 * then build an actionable message keyed on the token kind.
 */
// Obsidian's requestUrl() typings expose `status`/`json` as `any`; a full
// typed-wrapper refactor is deferred. Suppress the unsafe-access rules for
// this function so the rest of the file keeps strict typing.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
async function explainNotFound(
  owner: string,
  repo: string,
  token: string,
): Promise<string> {
  const slug = `${owner}/${repo}`;
  const kind = classifyToken(token);
  const ua = { "User-Agent": "ObsidianGitHubSync" };

  const userRes = await requestUrl({
    url: "https://api.github.com/user",
    headers: { Authorization: `token ${token}`, ...ua },
    throw: false,
  }).catch(() => null);
  if (userRes && (userRes.status === 401 || userRes.status === 403)) {
    return "Token is invalid or expired — generate a new one (GitHub → Settings → Developer settings) and paste it in Settings.";
  }
  const userLogin = (userRes?.json as GitHubUser | null | undefined)?.login;
  const login = isString(userLogin) ? userLogin : null;

  const pubRes = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}`,
    headers: ua,
    throw: false,
  }).catch(() => null);

  if (pubRes?.status === 200) {
    // Repo provably exists (public) — so a valid token getting 404 simply
    // lacks access to it.
    return kind === "fine-grained"
      ? `Repo ${slug} exists, but this fine-grained token isn't granted access to it. Edit the token on GitHub → "Repository access" → add ${slug}, then set Permissions → Contents: Read and write.`
      : `Repo ${slug} exists, but the token${login ? ` (account ${login})` : ""} can't access it. Add that account as a collaborator on the repo, or use a token from an account that has access.`;
  }

  // pubRes is 404 (private or nonexistent — GitHub hides which).
  return kind === "fine-grained"
    ? `Can't find ${slug}. Either it doesn't exist yet — create the repo on GitHub first — or it exists but this fine-grained token isn't granted access (fine-grained tokens only see repos explicitly added under "Repository access"). After creating it, add ${slug} to the token and grant Contents: Read and write.`
    : `Can't find ${slug}. Either it doesn't exist yet — create the repo on GitHub first — or it's private and this token${login ? ` (account ${login})` : ""} has no access / is missing the "repo" scope.`;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

/**
 * Probe a GitHub repo URL for access and write permission. Returns a
 * structured result the caller can render in a diagnostic UI; never
 * throws.
 *
 * - `status: 200 + permissions.push` → token can write
 * - `status: 200, permissions.push=false` → token can read but not push
 * - `status: 404` → disambiguated by explainNotFound (missing repo vs.
 *   missing access vs. fine-grained token not granted the repo)
 * - `status: 401/403` → token rejected (often SSO not authorized)
 */
export async function checkRepoAccess(
  remoteUrl: string,
  token: string,
): Promise<RepoAccessCheck> {
  const parsed = parseOwnerRepo(remoteUrl);
  if (!parsed) {
    return { ok: false, status: 0, reason: "Not a github.com URL" };
  }
  const { owner, repo } = parsed;
  const headers = token
    ? { Authorization: `token ${token}`, "User-Agent": "ObsidianGitHubSync" }
    : { "User-Agent": "ObsidianGitHubSync" };
  const res = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}`,
    headers,
    throw: false,
  });
  if (res.status !== 200) {
    const apiMsg = (res.json as GitHubErrorBody | null | undefined)?.message;
    const reason =
      res.status === 404 ? (token ? await explainNotFound(owner, repo, token) : "Repository not found (or it's private and no token was given)")
      : res.status === 401 ? "Token is invalid or expired — generate a new one and paste it in Settings."
      : res.status === 403 ? (isString(apiMsg) && apiMsg.includes("SAML") ? "SSO not authorized for this token — open the token on GitHub and authorize SSO for this org." : "Access forbidden")
      : `GitHub returned ${res.status}`;
    return { ok: false, status: res.status, reason };
  }
  const repoBody = res.json as GitHubRepo | null;
  const fullName = repoBody?.full_name ?? `${owner}/${repo}`;
  const canPush = !!repoBody?.permissions?.push;
  // Cheap follow-up: check for empty repo (only matters for diagnostic
  // completeness — auto-init already handles it).
  const commits = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`,
    headers,
    throw: false,
  });
  const isEmpty = commits.status === 409;
  return { ok: true, fullName, canPush, isEmpty };
}

/**
 * If the remote GitHub repo has no commits, create an initial README via
 * the Contents API so subsequent git operations (clone, submodule add,
 * push --set-upstream) have a default branch to work with.
 *
 * No-op if the remote already has commits, isn't on github.com, or we
 * have no token. Throws only on a hard failure that we want to surface
 * to the user.
 *
 * Why this matters: non-technical users routinely create a GitHub repo
 * via the web UI and try to connect it before pushing anything. Bare git
 * fails with cryptic "branch yet to be born" / "couldn't find remote ref"
 * messages — this turns the empty-repo case into a silent success.
 */
export async function ensureRemoteHasCommits(
  remoteUrl: string,
  token: string,
): Promise<void> {
  if (!token) return; // no creds → leave it to git layer
  const parsed = parseOwnerRepo(remoteUrl);
  if (!parsed) return; // not github.com — nothing to do via API
  const { owner, repo } = parsed;

  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "ObsidianGitHubSync",
  };

  // Probe: GitHub returns 409 "Git Repository is empty." for repos with no commits.
  const probe = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`,
    headers,
    throw: false,
  });
  if (probe.status !== 409) return; // 200 = has commits; 404/401/403 = let git surface it

  // Create an initial README on the repo's default branch (empty repos
  // auto-create the default branch on first PUT — don't pass an explicit
  // `branch` because that branch doesn't exist yet).
  const res = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/contents/README.md`,
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Initialize repository",
      content: btoa(`# ${repo}\n`),
    }),
    throw: false,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Couldn't initialize empty repository (HTTP ${res.status}).`);
  }
}

interface GitHubRefObject { object?: { sha?: string } }
interface GitHubRepoMeta { default_branch?: string }

/**
 * Resolve the repo's actual default branch via the GitHub API. Returns null
 * on any failure (bad URL, missing token, network error, repo not found).
 *
 * Used by the setup wizard to pre-fill the Branch field — not every repo
 * uses "main"; many older ones still use "master", and self-hosted policies
 * vary. Guessing wrong here causes "src refspec ... does not match" on first
 * push, which is the kind of cryptic error this plugin exists to avoid.
 */
export async function fetchRepoDefaultBranch(
  remoteUrl: string,
  token: string,
): Promise<string | null> {
  const parsed = parseOwnerRepo(remoteUrl);
  if (!parsed) return null;
  const { owner, repo } = parsed;
  const headers: Record<string, string> = { "User-Agent": "ObsidianGitHubSync" };
  if (token) headers["Authorization"] = `token ${token}`;
  try {
    const res = await requestUrl({
      url: `https://api.github.com/repos/${owner}/${repo}`,
      headers,
      throw: false,
    });
    if (res.status !== 200) return null;
    return (res.json as GitHubRepoMeta | null)?.default_branch ?? null;
  } catch {
    return null;
  }
}

/**
 * If `branch` doesn't exist on the remote yet, create it from the repo's
 * default branch via the GitHub Git Refs API. Returns whether the branch
 * was newly created and the default branch it was based on.
 *
 * No-op for non-github URLs or when no token is provided — git's
 * `push --set-upstream` already handles the simple "branch doesn't exist
 * yet" case. The API path is what unlocks the protected-default-branch
 * scenario: when the user can't push to main, they pick a new branch
 * name, and we materialise it on the remote from main's tip so the
 * subsequent push has a destination ref to land on.
 */
export async function ensureRemoteBranch(
  remoteUrl: string,
  branch: string,
  token: string,
): Promise<{ created: boolean; defaultBranch: string | null }> {
  if (!token) return { created: false, defaultBranch: null };
  const parsed = parseOwnerRepo(remoteUrl);
  if (!parsed) return { created: false, defaultBranch: null };
  const { owner, repo } = parsed;
  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "ObsidianGitHubSync",
  };

  const branchProbe = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
    headers,
    throw: false,
  });
  if (branchProbe.status === 200) return { created: false, defaultBranch: null };
  if (branchProbe.status !== 404) {
    // 401/403 → leave it to the git layer to surface the right error.
    return { created: false, defaultBranch: null };
  }

  const repoMeta = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}`,
    headers,
    throw: false,
  });
  const defaultBranch = (repoMeta.json as GitHubRepoMeta | null)?.default_branch ?? null;
  if (repoMeta.status !== 200 || !defaultBranch) {
    throw new Error(`Couldn't read repository default branch (HTTP ${repoMeta.status}).`);
  }

  const refRes = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(defaultBranch)}`,
    headers,
    throw: false,
  });
  const sha = (refRes.json as GitHubRefObject | null)?.object?.sha;
  if (refRes.status !== 200 || !sha) {
    throw new Error(`Couldn't read tip of ${defaultBranch} (HTTP ${refRes.status}).`);
  }

  const createRes = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/git/refs`,
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    throw: false,
  });
  if (createRes.status !== 201 && createRes.status !== 200) {
    const apiMsg = (createRes.json as GitHubErrorBody | null)?.message;
    throw new Error(
      `Couldn't create branch ${branch} (HTTP ${createRes.status}${apiMsg ? `: ${apiMsg}` : ""}).`
    );
  }
  return { created: true, defaultBranch };
}

export interface CreatePullRequestParams {
  remoteUrl: string;
  token: string;
  head: string;
  base: string;
  title: string;
  body?: string;
}

export interface CreatePullRequestResult {
  ok: boolean;
  url?: string;
  number?: number;
  reason?: string;
  /** When ok=false because a PR already exists, this points at it. */
  existingUrl?: string;
}

interface GitHubPullCreated { html_url?: string; number?: number }
interface GitHubValidationError {
  message?: string;
  errors?: { message?: string; resource?: string; field?: string; code?: string }[];
}
interface GitHubPullSummary { html_url?: string; number?: number; head?: { ref?: string }; base?: { ref?: string } }

/**
 * Open a pull request from `head` → `base` on the given GitHub repo.
 *
 * Returns a structured result; never throws on HTTP errors. The most
 * common failure paths get friendly messages:
 *
 *   - 422 "No commits between" → nothing to PR; tell the user to sync first
 *   - 422 "A pull request already exists" → re-query open PRs and surface
 *     the existing URL in `existingUrl`
 *   - 401/403/404 → reuse the token-diagnostic vocabulary from the rest
 *     of this file (missing scope / SSO / fine-grained allowlist)
 *
 * Required token permissions:
 *   - Classic PAT: `repo` scope (covers PR creation)
 *   - Fine-grained PAT: "Pull requests: Read and write" on the target repo
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-member-access */
export async function createPullRequest(
  p: CreatePullRequestParams,
): Promise<CreatePullRequestResult> {
  const parsed = parseOwnerRepo(p.remoteUrl);
  if (!parsed) {
    return { ok: false, reason: "Not a github.com URL — PR creation is only supported on github.com." };
  }
  if (!p.token) {
    return { ok: false, reason: "No GitHub token configured. Set a Personal Access Token in Settings first." };
  }
  if (!p.head || !p.base) {
    return { ok: false, reason: "Both head and base branch must be set." };
  }
  if (p.head === p.base) {
    return { ok: false, reason: "Head and base are the same branch — nothing to PR." };
  }
  if (!p.title.trim()) {
    return { ok: false, reason: "PR title is required." };
  }

  const { owner, repo } = parsed;
  const headers = {
    Authorization: `token ${p.token}`,
    "User-Agent": "ObsidianGitHubSync",
    "Content-Type": "application/json",
    Accept: "application/vnd.github+json",
  };

  const res = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/pulls`,
    method: "POST",
    headers,
    body: JSON.stringify({
      title: p.title,
      head: p.head,
      base: p.base,
      body: p.body ?? "",
    }),
    throw: false,
  });

  if (res.status === 201) {
    const created = res.json as GitHubPullCreated | null;
    return { ok: true, url: created?.html_url, number: created?.number };
  }

  if (res.status === 422) {
    const body = res.json as GitHubValidationError | null;
    const errMsg = body?.errors?.[0]?.message ?? body?.message ?? "";
    if (/no commits between/i.test(errMsg)) {
      return { ok: false, reason: `No commits between ${p.base} and ${p.head} — sync the branch first so the remote has your changes.` };
    }
    if (/already exists/i.test(errMsg)) {
      const existing = await findExistingOpenPr(owner, repo, p.head, p.base, p.token);
      return {
        ok: false,
        reason: `A pull request from ${p.head} → ${p.base} is already open.`,
        existingUrl: existing ?? undefined,
      };
    }
    return { ok: false, reason: errMsg || `GitHub rejected the request (422).` };
  }

  if (res.status === 404) {
    const explained = await explainNotFound(owner, repo, p.token);
    return { ok: false, reason: explained };
  }
  if (res.status === 401) {
    return { ok: false, reason: "Token is invalid or expired — generate a new one and paste it in Settings." };
  }
  if (res.status === 403) {
    const apiMsg = (res.json as GitHubErrorBody | null)?.message ?? "";
    if (/SAML/i.test(apiMsg)) {
      return { ok: false, reason: "SSO not authorized for this token — open the token on GitHub and authorize SSO for this org." };
    }
    return {
      ok: false,
      reason: "GitHub rejected the PR request (403). For fine-grained tokens, make sure the token grants 'Pull requests: Read and write' on this repo.",
    };
  }
  return { ok: false, reason: `GitHub returned ${res.status}` };
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

/**
 * Look up the existing open PR for head → base. Used to surface a useful
 * URL when createPullRequest hits the "already exists" 422 case.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
async function findExistingOpenPr(
  owner: string,
  repo: string,
  head: string,
  base: string,
  token: string,
): Promise<string | null> {
  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "ObsidianGitHubSync",
    Accept: "application/vnd.github+json",
  };
  // GitHub's PR list filter wants the `head` qualifier as "<owner>:<branch>".
  const res = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`,
    headers,
    throw: false,
  });
  if (res.status !== 200) return null;
  const list = res.json as GitHubPullSummary[] | null;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list[0]?.html_url ?? null;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

/**
 * True when a git push failure looks like a *permission* issue on the
 * target branch — typically pushing to a protected default branch
 * without a PR, or pushing to a repo you can read but not write.
 *
 * Used to distinguish "switch branches" cases from generic auth or
 * network failures, which need different remediation.
 */
export function isPushPermissionError(msg: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  if (m.includes("publickey")) return false;
  if (m.includes("gh006")) return true;
  if (m.includes("protected branch")) return true;
  if (m.includes("hook declined")) return true;
  if (m.includes("permission") && m.includes("denied")) return true;
  if (m.includes("remote rejected") && (m.includes("protected") || m.includes("declined") || m.includes("permission"))) return true;
  return false;
}
