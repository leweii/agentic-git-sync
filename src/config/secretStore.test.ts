/**
 * Secret-store pure functions: extraction/hydration/redaction of the
 * provider token map, including migration from the pre-1.5 per-provider
 * fields (both in-memory and old-shape secret files).
 */

import { describe, it, expect } from "vitest";
import {
  extractSecrets,
  applySecrets,
  redactSecrets,
  settingsHaveInlineSecrets,
  type LocalSecrets,
} from "./secretStore";
import { DEFAULT_SETTINGS, migrateLegacyProviders, type GitHubSyncSettings } from "../settings";

function settingsWith(providers: GitHubSyncSettings["ai"]["providers"]): GitHubSyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    ai: { ...DEFAULT_SETTINGS.ai, providers: providers.map((p) => ({ ...p })) },
  };
}

describe("extractSecrets / redactSecrets", () => {
  it("extracts a provider→token map and redaction blanks it", () => {
    const s = settingsWith([
      { provider: "groq", token: "gk", model: "", baseUrl: "" },
      { provider: "anthropic", token: "", model: "", baseUrl: "" }, // no token → not stored
      { provider: "custom", token: "ck", model: "m", baseUrl: "https://x/v1" },
    ]);
    const sec = extractSecrets(s);
    expect(sec.ai.providers).toEqual({ groq: "gk", custom: "ck" });

    const redacted = redactSecrets(s);
    expect(redacted.ai.providers.every((p) => p.token === "")).toBe(true);
    // Structure survives redaction — only the secrets go.
    expect(redacted.ai.providers.map((p) => p.provider)).toEqual(["groq", "anthropic", "custom"]);
  });

  it("settingsHaveInlineSecrets sees provider tokens", () => {
    expect(settingsHaveInlineSecrets(settingsWith([]))).toBe(false);
    expect(
      settingsHaveInlineSecrets(settingsWith([{ provider: "groq", token: "x", model: "", baseUrl: "" }])),
    ).toBe(true);
  });
});

describe("applySecrets", () => {
  it("hydrates entry tokens by provider id", () => {
    const s = settingsWith([
      { provider: "groq", token: "", model: "", baseUrl: "" },
      { provider: "xai", token: "stale-inline", model: "", baseUrl: "" },
    ]);
    const sec: LocalSecrets = {
      version: 1,
      deviceId: "d",
      githubToken: "",
      connections: [],
      ai: { providers: { groq: "gk" } },
    };
    applySecrets(s, sec);
    expect(s.ai.providers[0].token).toBe("gk");
    // The store is the source of truth: entries without a stored token reset.
    expect(s.ai.providers[1].token).toBe("");
  });

  it("legacy-shape store stages tokens for entry migration", () => {
    const s = settingsWith([]);
    const sec: LocalSecrets = {
      version: 1,
      deviceId: "d",
      githubToken: "",
      connections: [],
      ai: { providers: { openai: "ok", anthropic: "ak" }, legacy: true },
    };
    applySecrets(s, sec);
    // Staged into the legacy fields…
    expect(s.ai.openaiToken).toBe("ok");
    expect(s.ai.claudeToken).toBe("ak");
    // …which migrateLegacyProviders (loadSettings runs it right after)
    // turns into provider entries, legacy order preserved.
    s.ai = migrateLegacyProviders(s.ai);
    expect(s.ai.providers.map((p) => [p.provider, p.token])).toEqual([
      ["openai", "ok"],
      ["anthropic", "ak"],
    ]);
    expect(s.ai.openaiToken).toBe("");
  });
});

describe("migrateLegacyProviders", () => {
  it("folds legacy fields into entries in the historical preference order", () => {
    const ai = {
      ...DEFAULT_SETTINGS.ai,
      openaiToken: "o",
      openaiModel: "gpt-5.5",
      geminiToken: "g",
      geminiModel: "gemini-2.5-flash",
      claudeToken: "c",
      claudeModel: "claude-sonnet-4-5",
      deepseekToken: "d",
      deepseekModel: "deepseek-chat",
    };
    const out = migrateLegacyProviders(ai);
    expect(out.providers.map((p) => p.provider)).toEqual([
      "openai",
      "google",
      "anthropic",
      "deepseek",
    ]);
    expect(out.providers[1]).toMatchObject({ token: "g", model: "gemini-2.5-flash" });
    expect(out.openaiToken).toBe("");
    expect(out.deepseekToken).toBe("");
  });

  it("is idempotent and never duplicates an existing entry", () => {
    const once = migrateLegacyProviders({
      ...DEFAULT_SETTINGS.ai,
      providers: [{ provider: "openai", token: "existing", model: "gpt-x", baseUrl: "" }],
      openaiToken: "legacy",
    });
    expect(once.providers).toHaveLength(1);
    // An entry that already has a token wins over the legacy field.
    expect(once.providers[0].token).toBe("existing");
    const twice = migrateLegacyProviders(once);
    expect(twice.providers).toEqual(once.providers);
  });

  it("fills a token-less existing entry from the legacy field", () => {
    const out = migrateLegacyProviders({
      ...DEFAULT_SETTINGS.ai,
      providers: [{ provider: "anthropic", token: "", model: "claude-haiku-4-5", baseUrl: "" }],
      claudeToken: "ck",
    });
    expect(out.providers).toHaveLength(1);
    expect(out.providers[0]).toMatchObject({ token: "ck", model: "claude-haiku-4-5" });
  });

  it("skips legacy providers without a token", () => {
    const out = migrateLegacyProviders({ ...DEFAULT_SETTINGS.ai, openaiModel: "gpt-5.5" });
    expect(out.providers).toEqual([]);
  });
});
