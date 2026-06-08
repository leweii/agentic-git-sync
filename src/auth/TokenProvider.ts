/**
 * Token resolution, decoupled from how tokens are consumed.
 *
 * Git transport and the REST API both just need "a valid token for this
 * repo owner". PatTokenProvider returns the single PAT; the App provider
 * resolves owner → installation → a short-lived installation token minted
 * by the backend, cached per installation until it nears expiry.
 *
 * See DESIGN.md §9.1 / §6A.
 */
import { BackendClient, BackendError } from "./BackendClient";
import type { GitHubAppConnection } from "../settings";

export type GitUser = "oauth2" | "x-access-token";

export interface TokenProvider {
  /** A valid token for `owner` (PAT mode ignores `owner`). */
  getTokenForOwner(owner: string): Promise<string>;
  /** Username half of the git `insteadOf` rewrite. */
  gitUser(): GitUser;
}

/** Thrown when no connected installation covers `owner` — the UI turns
 *  this into actionable guidance (install the app / connect an account). */
export class NoInstallationError extends Error {
  constructor(public owner: string) {
    super(`No Agentic Git Sync installation grants access to "${owner}".`);
    this.name = "NoInstallationError";
  }
}

// ── PAT (fallback / advanced) ────────────────────────────────────────
export class PatTokenProvider implements TokenProvider {
  constructor(private getPat: () => string) {}
  getTokenForOwner(_owner: string): Promise<string> {
    return Promise.resolve(this.getPat());
  }
  gitUser(): GitUser {
    return "oauth2";
  }
}

// ── GitHub App (default) ─────────────────────────────────────────────
interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Refresh when fewer than this many ms remain, so a sync never expires mid-flight. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface AppProviderDeps {
  getDeviceId: () => string;
  getConnections: () => GitHubAppConnection[];
  /** Called when a session is rejected (invalid/device mismatch) so the
   *  plugin can drop it from settings and prompt a reconnect. */
  onSessionInvalid: (sessionId: string) => void;
  now?: () => number;
}

export class BackendAppTokenProvider implements TokenProvider {
  private cache = new Map<number, CachedToken>();
  private now: () => number;

  constructor(private deps: AppProviderDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  gitUser(): GitUser {
    return "x-access-token";
  }

  /** Resolve owner login → the connection + installation that covers it. */
  resolveOwner(owner: string): { sessionId: string; installationId: number } | null {
    const target = owner.toLowerCase();
    for (const conn of this.deps.getConnections()) {
      const inst = conn.installations.find((i) => i.accountLogin.toLowerCase() === target);
      if (inst) return { sessionId: conn.sessionId, installationId: inst.id };
    }
    return null;
  }

  async getTokenForOwner(owner: string): Promise<string> {
    const resolved = this.resolveOwner(owner);
    if (!resolved) throw new NoInstallationError(owner);
    const { sessionId, installationId } = resolved;

    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAtMs - this.now() > REFRESH_SKEW_MS) {
      return cached.token;
    }

    try {
      const minted = await BackendClient.mintToken(
        sessionId,
        this.deps.getDeviceId(),
        installationId,
      );
      this.cache.set(installationId, {
        token: minted.token,
        expiresAtMs: Date.parse(minted.expiresAt),
      });
      return minted.token;
    } catch (e) {
      if (e instanceof BackendError && (e.code === "session_invalid" || e.code === "device_mismatch")) {
        this.cache.delete(installationId);
        this.deps.onSessionInvalid(sessionId);
      }
      throw e;
    }
  }

  /** Drop cached tokens (e.g. after disconnect / reconnect). */
  clearCache(): void {
    this.cache.clear();
  }
}
