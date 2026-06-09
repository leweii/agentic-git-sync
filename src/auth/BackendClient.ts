/**
 * Thin client for the zhiyu-online backend. Calls /token, /installations,
 * /disconnect. Maps the backend's { error, message } contract (DESIGN §12)
 * to a typed BackendError so callers can react (e.g. clear a dead session).
 */
import { requestUrl, type RequestUrlResponse } from "obsidian";
import { BACKEND_BASE } from "./constants";
import type { GitHubAppInstallation } from "../settings";

export type BackendErrorCode =
  | "session_invalid"
  | "device_mismatch"
  | "installation_revoked"
  | "installation_not_found"
  | "github_upstream"
  | "rate_limited"
  | "bad_request"
  | "network";

export class BackendError extends Error {
  constructor(
    public code: BackendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export interface MintedToken {
  token: string;
  expiresAt: string; // ISO 8601
  permissions: Record<string, string>;
}

interface ErrorBody {
  error?: BackendErrorCode;
  message?: string;
}

async function call<T>(
  path: string,
  opts: { method: string; sessionId: string; body?: unknown; query?: Record<string, string> },
): Promise<T> {
  const qs = opts.query
    ? "?" + new URLSearchParams(opts.query).toString()
    : "";
  let res: RequestUrlResponse;
  try {
    res = await requestUrl({
      url: `${BACKEND_BASE}${path}${qs}`,
      method: opts.method,
      headers: {
        Authorization: `Bearer ${opts.sessionId}`,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      throw: false,
    });
  } catch (e) {
    throw new BackendError("network", (e as Error).message ?? "Network error");
  }
  if (res.status >= 200 && res.status < 300) {
    return res.json as T;
  }
  const body = (res.json ?? {}) as ErrorBody;
  throw new BackendError(
    body.error ?? "github_upstream",
    body.message ?? `Backend returned ${res.status}`,
  );
}

export const BackendClient = {
  async mintToken(
    sessionId: string,
    deviceId: string,
    installationId: number,
  ): Promise<MintedToken> {
    return call<MintedToken>("/token", {
      method: "POST",
      sessionId,
      body: { deviceId, installationId },
    });
  },

  async listInstallations(
    sessionId: string,
    deviceId: string,
  ): Promise<GitHubAppInstallation[]> {
    const out = await call<{ installations: GitHubAppInstallation[] }>("/installations", {
      method: "GET",
      sessionId,
      query: { deviceId },
    });
    return out.installations ?? [];
  },

  async disconnect(sessionId: string, deviceId: string): Promise<void> {
    await call<{ disconnected: boolean }>("/disconnect", {
      method: "POST",
      sessionId,
      body: { deviceId },
    });
  },
};
