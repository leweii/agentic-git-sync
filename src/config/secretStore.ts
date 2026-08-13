// Per-device secret store — credentials live OUTSIDE the vault.
//
// Why this exists: the vault is a Git repo that is synced to a remote and
// routinely cloned/copied between machines and people. Anything written
// into the vault (or into `data.json`, which sits in `<vault>/<configDir>/
// plugins/agentic-git-sync/`) can therefore leak. Sharing such a file
// hands the recipient the owner's backend `sessionId` + `deviceId` (full
// impersonation), GitHub PAT, and AI provider keys.
//
// So the secrets below are kept in a file under the OS user-config
// directory — per machine, never inside any vault, never synced:
//
//   macOS    ~/Library/Application Support/agentic-git-sync/
//   Windows  %APPDATA%\agentic-git-sync\          (…\AppData\Roaming\…)
//   Linux    $XDG_CONFIG_HOME/agentic-git-sync/   (default ~/.config/…)
//
// `data.json` keeps only non-secret machine state (sync history, git
// identity, structural config); see redactSecrets().

import { fs, path, os, crypto } from "../node-builtins";
import type { GitHubSyncSettings, GitHubAppConnection } from "../settings";

const APP_DIR_NAME = "agentic-git-sync";
const SECRETS_VERSION = 1 as const;

/** Environment access that tolerates `process` being absent. */
function env(key: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[key] : undefined;
}

/**
 * OS-appropriate per-user config directory, outside any vault. The three
 * platforms diverge here — this is the whole point of the module.
 */
function appConfigDir(): string {
  const home = os.homedir();
  switch (os.platform()) {
    case "win32":
      return path.join(env("APPDATA") || path.join(home, "AppData", "Roaming"), APP_DIR_NAME);
    case "darwin":
      return path.join(home, "Library", "Application Support", APP_DIR_NAME);
    default:
      // Linux and any other POSIX-like platform.
      return path.join(env("XDG_CONFIG_HOME") || path.join(home, ".config"), APP_DIR_NAME);
  }
}

/**
 * One secret file per vault, keyed by the vault's absolute path, so two
 * vaults open on the same machine don't clobber each other's credentials.
 * The basename is a hash so the on-disk filename doesn't leak the vault
 * path.
 */
function secretFilePath(vaultBasePath: string): string {
  const key = crypto.createHash("sha256").update(vaultBasePath).digest("hex").slice(0, 16);
  return path.join(appConfigDir(), `vault-${key}.json`);
}

export interface LocalSecrets {
  version: typeof SECRETS_VERSION;
  /** Per-device id, paired with the backend session — a secret half. */
  deviceId: string;
  /** Personal access token (PAT auth mode). */
  githubToken: string;
  /** GitHub App connections — each carries a backend `sessionId`. */
  connections: GitHubAppConnection[];
  ai: {
    /** Provider id (providerCatalog.ts) → API key. */
    providers: Record<string, string>;
    /**
     * True when this object was read from a pre-1.5 secret file whose
     * tokens were stored under per-provider fields. applySecrets() then
     * stages them into the legacy settings fields so
     * migrateLegacyProviders() can create the provider entries.
     */
    legacy?: boolean;
  };
}

/** Pre-1.5 secret-file field → provider id in the new map. */
const LEGACY_AI_FIELDS: Array<[key: string, providerId: string]> = [
  ["openaiToken", "openai"],
  ["geminiToken", "google"],
  ["claudeToken", "anthropic"],
  ["deepseekToken", "deepseek"],
];

/** Pull the secret fields out of an in-memory settings object. */
export function extractSecrets(s: GitHubSyncSettings): LocalSecrets {
  return {
    version: SECRETS_VERSION,
    deviceId: s.deviceId ?? "",
    githubToken: s.githubToken ?? "",
    connections: s.githubApp?.connections ?? [],
    ai: {
      providers: Object.fromEntries(
        (s.ai?.providers ?? [])
          .filter((p) => p.token)
          .map((p) => [p.provider, p.token]),
      ),
    },
  };
}

/** Overlay external secrets onto an in-memory settings object (mutates). */
export function applySecrets(s: GitHubSyncSettings, sec: LocalSecrets): void {
  s.deviceId = sec.deviceId ?? "";
  s.githubToken = sec.githubToken ?? "";
  s.githubApp = { connections: sec.connections ?? [] };
  const map = sec.ai?.providers ?? {};
  for (const entry of s.ai.providers ?? []) {
    entry.token = map[entry.provider] ?? "";
  }
  if (sec.ai?.legacy) {
    // Old-shape file: tokens may belong to providers that have no entry yet
    // (they lived only in the secret store). Stage them in the legacy fields;
    // migrateLegacyProviders() turns them into entries right after this.
    s.ai.openaiToken = map["openai"] ?? "";
    s.ai.geminiToken = map["google"] ?? "";
    s.ai.claudeToken = map["anthropic"] ?? "";
    s.ai.deepseekToken = map["deepseek"] ?? "";
  }
}

/**
 * A copy of settings with every secret blanked — exactly what is allowed
 * to be written into `data.json`. Non-secret fields pass through.
 */
export function redactSecrets(s: GitHubSyncSettings): GitHubSyncSettings {
  return {
    ...s,
    githubToken: "",
    deviceId: "",
    githubApp: { connections: [] },
    ai: {
      ...s.ai,
      providers: (s.ai.providers ?? []).map((p) => ({ ...p, token: "" })),
      openaiToken: "",
      geminiToken: "",
      claudeToken: "",
      deepseekToken: "",
    },
  };
}

/** True if a raw data.json blob still carries any inline secret (→ migrate). */
export function settingsHaveInlineSecrets(s: Partial<GitHubSyncSettings> | null): boolean {
  if (!s) return false;
  if (s.githubToken) return true;
  if (s.deviceId) return true;
  if (s.githubApp?.connections?.length) return true;
  const ai = s.ai;
  if (ai && (ai.openaiToken || ai.geminiToken || ai.claudeToken || ai.deepseekToken)) return true;
  if (ai?.providers?.some((p) => p.token)) return true;
  return false;
}

/** Read the external secret file for a vault, or null if missing/unreadable. */
export function readSecrets(vaultBasePath: string): LocalSecrets | null {
  try {
    const file = secretFilePath(vaultBasePath);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      deviceId?: string;
      githubToken?: string;
      connections?: GitHubAppConnection[];
      ai?: Record<string, unknown> & { providers?: Record<string, string> };
    };
    // New shape stores a provider→token map; pre-1.5 files stored one field
    // per provider. Normalise to the map and flag legacy so applySecrets can
    // stage the old fields for entry migration.
    let providers: Record<string, string> = {};
    let legacy = false;
    if (raw.ai?.providers && typeof raw.ai.providers === "object") {
      for (const [k, v] of Object.entries(raw.ai.providers)) {
        if (typeof v === "string" && v) providers[k] = v;
      }
    } else if (raw.ai) {
      legacy = true;
      for (const [field, id] of LEGACY_AI_FIELDS) {
        const v = raw.ai[field];
        if (typeof v === "string" && v) providers[id] = v;
      }
    }
    return {
      version: SECRETS_VERSION,
      deviceId: typeof raw.deviceId === "string" ? raw.deviceId : "",
      githubToken: typeof raw.githubToken === "string" ? raw.githubToken : "",
      connections: Array.isArray(raw.connections) ? raw.connections : [],
      ai: { providers, ...(legacy ? { legacy: true } : {}) },
    };
  } catch (e) {
    console.warn("[github-sync] couldn't read secret store:", e);
    return null;
  }
}

/** Write the external secret file (owner-only perms where supported). */
export function writeSecrets(vaultBasePath: string, secrets: LocalSecrets): void {
  fs.mkdirSync(appConfigDir(), { recursive: true });
  const file = secretFilePath(vaultBasePath);
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  // mode on open() is masked by umask and ignored on Windows; chmod again
  // so a pre-existing looser file is tightened.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows / filesystem without POSIX perms — nothing to do. */
  }
}

/** Delete the external secret file (used by the hard reset). */
export function clearSecrets(vaultBasePath: string): void {
  try {
    fs.unlinkSync(secretFilePath(vaultBasePath));
  } catch {
    /* already absent */
  }
}
