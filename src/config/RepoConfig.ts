// Per-repo configuration file (`.github-sync.json` at repo root).
//
// Lives in the repo so it travels with it: clone the repo on a new
// machine, install the plugin, and the structural config is already
// there. Only secrets (GitHub PAT, AI tokens) and per-machine state
// (git identity, sync history) stay in `data.json`.

import type { GitHubSyncSettings } from "../settings";

export const REPO_CONFIG_FILENAME = ".github-sync.json";

export interface RepoConfigSubmoduleV1 {
  path: string;
  remote: string;
  branch: string;
}

export interface RepoConfigV1 {
  version: 1;
  remote: string;
  branch: string;
  sync: {
    autoIntervalMin: number;
    ignorePatterns: string[];
  };
  ai: {
    enabled: boolean;
    silentMode: boolean;
    silentMinConfidence: number;
    deepseekModel: string;
    geminiModel: string;
    sendFilePaths: boolean;
    sendGitMetadata: boolean;
    sendSurroundingContext: boolean;
    excludePatterns: string[];
  };
  submodules: RepoConfigSubmoduleV1[];
}

/**
 * Parse a JSON value into RepoConfigV1, accepting partial / loosely-typed
 * input. Returns null if it's not even an object or version is unknown.
 */
export function parseRepoConfig(raw: unknown): RepoConfigV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  const ai = (obj.ai ?? {}) as Record<string, unknown>;
  const sync = (obj.sync ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    remote: typeof obj.remote === "string" ? obj.remote : "",
    branch: typeof obj.branch === "string" ? obj.branch : "main",
    sync: {
      autoIntervalMin: typeof sync.autoIntervalMin === "number" ? sync.autoIntervalMin : 30,
      ignorePatterns: Array.isArray(sync.ignorePatterns)
        ? sync.ignorePatterns.map(String)
        : [],
    },
    ai: {
      enabled: typeof ai.enabled === "boolean" ? ai.enabled : true,
      silentMode: typeof ai.silentMode === "boolean" ? ai.silentMode : false,
      silentMinConfidence:
        typeof ai.silentMinConfidence === "number" ? ai.silentMinConfidence : 3,
      deepseekModel: typeof ai.deepseekModel === "string" ? ai.deepseekModel : "deepseek-v4-flash",
      geminiModel: typeof ai.geminiModel === "string" ? ai.geminiModel : "gemini-1.5-flash",
      sendFilePaths: typeof ai.sendFilePaths === "boolean" ? ai.sendFilePaths : true,
      sendGitMetadata: typeof ai.sendGitMetadata === "boolean" ? ai.sendGitMetadata : true,
      sendSurroundingContext:
        typeof ai.sendSurroundingContext === "boolean" ? ai.sendSurroundingContext : true,
      excludePatterns: Array.isArray(ai.excludePatterns)
        ? ai.excludePatterns.map(String)
        : [],
    },
    submodules: Array.isArray(obj.submodules)
      ? obj.submodules.map((s) => {
          const ss = (s ?? {}) as Record<string, unknown>;
          return {
            path: typeof ss.path === "string" ? ss.path : "",
            remote: typeof ss.remote === "string" ? ss.remote : "",
            branch: typeof ss.branch === "string" ? ss.branch : "main",
          };
        }).filter((s) => s.path && s.remote)
      : [],
  };
}

export function serializeRepoConfig(cfg: RepoConfigV1): string {
  return JSON.stringify(cfg, null, 2) + "\n";
}

/**
 * Extract repo-level fields from runtime settings into the file shape.
 * Used when writing `.github-sync.json` after a UI change.
 */
export function settingsToRepoConfig(s: GitHubSyncSettings): RepoConfigV1 {
  return {
    version: 1,
    remote: s.mainRepoUrl,
    branch: s.mainRepoBranch,
    sync: {
      autoIntervalMin: s.autoSyncInterval,
      ignorePatterns: s.ignorePatterns,
    },
    ai: {
      enabled: s.ai.enabled,
      silentMode: s.ai.silentMode,
      silentMinConfidence: s.ai.silentMinConfidence,
      deepseekModel: s.ai.deepseekModel,
      geminiModel: s.ai.geminiModel,
      sendFilePaths: s.ai.sendFilePaths,
      sendGitMetadata: s.ai.sendGitMetadata,
      sendSurroundingContext: s.ai.sendSurroundingContext,
      excludePatterns: s.ai.excludePatterns,
    },
    submodules: s.submodules.map((sub) => ({
      path: sub.localPath,
      remote: sub.remoteUrl,
      branch: sub.branch,
    })),
  };
}

/**
 * Overlay a parsed RepoConfig onto runtime settings, preserving local-only
 * fields like submodule ids and autoSync toggles. Used at startup after
 * reading `.github-sync.json` from disk.
 */
export function applyRepoConfig(
  s: GitHubSyncSettings,
  cfg: RepoConfigV1
): GitHubSyncSettings {
  const merged: GitHubSyncSettings = {
    ...s,
    mainRepoUrl: cfg.remote || s.mainRepoUrl,
    mainRepoBranch: cfg.branch || s.mainRepoBranch,
    autoSyncInterval: cfg.sync.autoIntervalMin,
    ignorePatterns: cfg.sync.ignorePatterns,
    ai: {
      ...s.ai,
      enabled: cfg.ai.enabled,
      silentMode: cfg.ai.silentMode,
      silentMinConfidence: cfg.ai.silentMinConfidence,
      deepseekModel: cfg.ai.deepseekModel,
      geminiModel: cfg.ai.geminiModel,
      sendFilePaths: cfg.ai.sendFilePaths,
      sendGitMetadata: cfg.ai.sendGitMetadata,
      sendSurroundingContext: cfg.ai.sendSurroundingContext,
      excludePatterns: cfg.ai.excludePatterns,
    },
  };

  // Reconcile submodule list with existing local state. Keep id + autoSync
  // for known submodules; add new ones; drop entries not in the config.
  merged.submodules = cfg.submodules.map((c) => {
    const existing = s.submodules.find((sub) => sub.localPath === c.path);
    return {
      id: existing?.id ?? generateSubmoduleId(c.path),
      localPath: c.path,
      remoteUrl: c.remote,
      branch: c.branch,
      autoSync: existing?.autoSync ?? true,
      syncInterval: existing?.syncInterval ?? cfg.sync.autoIntervalMin,
    };
  });

  return merged;
}

function generateSubmoduleId(path: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `sub_${path.replace(/[^a-z0-9]/gi, "_")}_${Date.now().toString(36)}`;
}
