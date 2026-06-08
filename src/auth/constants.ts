/**
 * GitHub App + backend (zhiyu-online) constants.
 *
 * The backend domain (easy-sync.zhiyu-online.com) is infrastructure and
 * does not need to change when the App display name changes.
 *
 * NOTE: APP_SLUG must match the slug GitHub assigned the app (App ID
 * 3994678, owner leweii). It only affects the install URL.
 */
export const BACKEND_BASE = "https://sync.zhiyu-online.com";
export const APP_SLUG = "agentic-git-sync";
/** OAuth client id — public (appears in authorize URLs), safe to embed. */
export const CLIENT_ID = "Iv23liLjLbidWsPa5flK";

/** obsidian:// protocol action the backend deep-links back to. */
export const PROTOCOL_ACTION = "agentic-git-sync";

/**
 * OAuth authorize URL — the Connect entry point. Unlike `installations/new`,
 * this always issues a `code` to the callback regardless of whether the app
 * is already installed, so it works for reconnects too. The backend derives
 * the accessible installations from the resulting user token.
 */
export function authorizeUrl(state: string): string {
  const p = new URLSearchParams({ client_id: CLIENT_ID, state });
  return `https://github.com/login/oauth/authorize?${p.toString()}`;
}

/** Browser URL to install the app on a new account/org (guidance flow). */
export function installUrl(state?: string): string {
  const base = `https://github.com/apps/${APP_SLUG}/installations/new`;
  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

/** Page where a user manages/uninstalls the app for an account. */
export function manageInstallUrl(): string {
  return `https://github.com/settings/installations`;
}
