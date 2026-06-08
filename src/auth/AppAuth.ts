/**
 * Orchestrates GitHub App authentication on the plugin side:
 *   - builds the active TokenProvider from settings.authMethod
 *   - the Connect flow (open browser → install/authorize → deep link back)
 *   - the obsidian://agentic-git-sync callback (verify nonce, store
 *     session, fetch installations)
 *   - disconnect + installation refresh + accessible-repo listing
 *
 * Web Crypto (Electron renderer) is used for the device id / hash so the
 * plugin has no Node-crypto dependency; the SHA-256 hex matches what the
 * backend computes for device binding.
 */
import { Notice } from "obsidian";
import type { GitHubSyncSettings, GitHubAppConnection } from "../settings";
import {
  type TokenProvider,
  type GitUser,
  PatTokenProvider,
  BackendAppTokenProvider,
} from "./TokenProvider";
import { BackendClient } from "./BackendClient";
import { authorizeUrl } from "./constants";
import { listInstallationRepos } from "../git/githubApi";

export interface AppAuthHost {
  settings: GitHubSyncSettings;
  saveSettings: () => Promise<void>;
}

function randomB64url(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = "";
  for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function encodeState(nonce: string, deviceIdHash: string): string {
  const json = JSON.stringify({ n: nonce, d: deviceIdHash });
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface ProtocolParams {
  action?: string;
  session?: string;
  login?: string;
  installation?: string;
  state?: string;
}

export class AppAuth implements TokenProvider {
  private patProvider: PatTokenProvider;
  private appProvider: BackendAppTokenProvider;
  private pendingNonce: string | null = null;

  constructor(private host: AppAuthHost) {
    this.patProvider = new PatTokenProvider(() => host.settings.githubToken);
    this.appProvider = new BackendAppTokenProvider({
      getDeviceId: () => host.settings.deviceId,
      getConnections: () => host.settings.githubApp.connections,
      onSessionInvalid: (sessionId) => void this.dropSession(sessionId),
    });
  }

  /** The provider matching the current auth method. */
  provider(): TokenProvider {
    return this.host.settings.authMethod === "githubApp"
      ? this.appProvider
      : this.patProvider;
  }

  // AppAuth is itself a TokenProvider that delegates to whichever provider
  // is active *now*, so consumers (GitManager) bind once and automatically
  // follow auth-method changes (e.g. after Connect) without reconstruction.
  getTokenForOwner(owner: string): Promise<string> {
    return this.provider().getTokenForOwner(owner);
  }
  gitUser(): GitUser {
    return this.provider().gitUser();
  }

  /** Expose the App provider for owner-resolution checks in the UI. */
  app(): BackendAppTokenProvider {
    return this.appProvider;
  }

  private async ensureDeviceId(): Promise<string> {
    if (!this.host.settings.deviceId) {
      this.host.settings.deviceId = randomB64url();
      await this.host.saveSettings();
    }
    return this.host.settings.deviceId;
  }

  /** Open the browser to install + authorize the app. */
  async beginConnect(): Promise<void> {
    const deviceId = await this.ensureDeviceId();
    const deviceIdHash = await sha256Hex(deviceId);
    const nonce = randomB64url(16);
    this.pendingNonce = nonce;
    const state = encodeState(nonce, deviceIdHash);
    window.open(authorizeUrl(state), "_blank");
    new Notice("Complete the GitHub authorization in your browser, then return to Obsidian.");
  }

  /** Handle the obsidian://easy-sync deep link from the backend.
   *  (`params.action` here is Obsidian's registered action = "easy-sync",
   *  not a sub-path — we key off the presence of session/state instead.) */
  async handleCallback(params: ProtocolParams): Promise<void> {
    if (!params.session || !params.login) {
      new Notice("Agentic Git Sync: connection response was incomplete.");
      return;
    }
    if (!this.pendingNonce || params.state !== this.pendingNonce) {
      new Notice("Agentic Git Sync: connection couldn't be verified (state mismatch).");
      return;
    }
    this.pendingNonce = null;

    const login = params.login;
    const sessionId = params.session;
    const connections = this.host.settings.githubApp.connections.filter(
      (c) => c.login.toLowerCase() !== login.toLowerCase(),
    );
    const conn: GitHubAppConnection = { sessionId, login, installations: [] };
    connections.push(conn);
    this.host.settings.githubApp = { connections };
    this.host.settings.authMethod = "githubApp";
    await this.host.saveSettings();
    this.appProvider.clearCache();

    // Populate the installation list (best-effort — the connection is
    // already usable, this just enriches the owner→installation map).
    try {
      conn.installations = await BackendClient.listInstallations(
        sessionId,
        this.host.settings.deviceId,
      );
      await this.host.saveSettings();
    } catch {
      /* will be refreshed lazily on first token mint / manual refresh */
    }
    new Notice(`Agentic Git Sync connected as @${login}.`);
  }

  /** Re-list installations for a connection (e.g. after installing on a new org). */
  async refreshInstallations(login: string): Promise<void> {
    const conn = this.host.settings.githubApp.connections.find(
      (c) => c.login.toLowerCase() === login.toLowerCase(),
    );
    if (!conn) return;
    conn.installations = await BackendClient.listInstallations(
      conn.sessionId,
      this.host.settings.deviceId,
    );
    await this.host.saveSettings();
    this.appProvider.clearCache();
  }

  /** Disconnect one identity (best-effort backend revoke + local removal). */
  async disconnect(login: string): Promise<void> {
    const conn = this.host.settings.githubApp.connections.find(
      (c) => c.login.toLowerCase() === login.toLowerCase(),
    );
    if (conn) {
      try {
        await BackendClient.disconnect(conn.sessionId, this.host.settings.deviceId);
      } catch {
        /* best-effort */
      }
    }
    const remaining = this.host.settings.githubApp.connections.filter(
      (c) => c.login.toLowerCase() !== login.toLowerCase(),
    );
    this.host.settings.githubApp = { connections: remaining };
    // No App connections left → fall back to the PAT path.
    if (remaining.length === 0) this.host.settings.authMethod = "pat";
    await this.host.saveSettings();
    this.appProvider.clearCache();
  }

  /**
   * Repos the connected installations can access, grouped by account
   * login — the data source for the repo picker (DESIGN.md §9.7). Empty
   * in PAT mode.
   */
  async listAccessibleRepos(): Promise<Array<{ login: string; repos: string[] }>> {
    if (this.host.settings.authMethod !== "githubApp") return [];
    const groups: Array<{ login: string; repos: string[] }> = [];
    for (const conn of this.host.settings.githubApp.connections) {
      for (const inst of conn.installations) {
        try {
          const token = await this.appProvider.getTokenForOwner(inst.accountLogin);
          groups.push({ login: inst.accountLogin, repos: await listInstallationRepos(token) });
        } catch {
          groups.push({ login: inst.accountLogin, repos: [] });
        }
      }
    }
    return groups;
  }

  private async dropSession(sessionId: string): Promise<void> {
    const before = this.host.settings.githubApp.connections;
    const after = before.filter((c) => c.sessionId !== sessionId);
    if (after.length !== before.length) {
      this.host.settings.githubApp = { connections: after };
      await this.host.saveSettings();
      new Notice("Agentic Git Sync: a GitHub connection expired — please reconnect.");
    }
  }
}
