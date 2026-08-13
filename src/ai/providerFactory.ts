/**
 * Turns a configured provider entry (settings) into runtime objects:
 *
 *   - ToolCallBackend — native tool-calling chat for the recovery agent
 *   - AIProvider      — single-turn completions for conflict suggestions,
 *                       PR summaries, and the settings Test button
 *
 * Both paths share the same resolution: catalog defaults (providerCatalog.ts,
 * generated from pi-ai's registry) overlaid with the user's model/baseUrl
 * overrides. "custom" entries are user-defined OpenAI-compatible endpoints.
 */

import type { AIProvider } from "./AIProvider";
import { OpenAIProvider } from "./OpenAIProvider";
import { ClaudeProvider } from "./ClaudeProvider";
import { GeminiProvider } from "./GeminiProvider";
import {
  AnthropicBackend,
  GeminiBackend,
  OpenAICompatBackend,
  type BackendConfig,
  type ToolCallBackend,
} from "./piBackends";
import {
  CUSTOM_PROVIDER_ID,
  catalogEntry,
  type ProviderKind,
} from "./providerCatalog";

/**
 * One configured provider, as persisted in settings. Array order is the
 * failover preference order for every LLM path. The token is hydrated from
 * the per-device secret store — data.json never carries it.
 */
export interface AIProviderEntry {
  /** Catalog id, or CUSTOM_PROVIDER_ID for a user-defined endpoint. */
  provider: string;
  token: string;
  /** Empty → catalog default model. */
  model: string;
  /** Empty → catalog default URL. Required for custom entries. */
  baseUrl: string;
  /** Display label for custom entries. */
  label?: string;
}

export interface ResolvedProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  token: string;
  model: string;
  baseUrl: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Resolve an entry against the catalog. Returns null for entries that can't
 * run (unknown provider id, custom without a URL/model) — callers skip them.
 */
export function resolveProvider(entry: AIProviderEntry): ResolvedProvider | null {
  if (entry.provider === CUSTOM_PROVIDER_ID) {
    if (!entry.baseUrl.trim() || !entry.model.trim()) return null;
    return {
      id: CUSTOM_PROVIDER_ID,
      name: entry.label?.trim() || "Custom",
      kind: "openai-compat",
      token: entry.token,
      model: entry.model.trim(),
      baseUrl: stripTrailingSlash(entry.baseUrl.trim()),
    };
  }
  const cat = catalogEntry(entry.provider);
  if (!cat) return null;
  return {
    id: cat.id,
    name: cat.name,
    kind: cat.kind,
    token: entry.token,
    model: entry.model.trim() || cat.defaultModel,
    baseUrl: stripTrailingSlash(entry.baseUrl.trim() || cat.baseUrl),
  };
}

/** Recovery-agent backend for one entry, or null if it can't run. */
export function buildBackend(entry: AIProviderEntry): ToolCallBackend | null {
  const r = resolveProvider(entry);
  if (!r || !r.token) return null;
  const cfg: BackendConfig = {
    id: r.id,
    name: r.name,
    token: r.token,
    model: r.model,
    baseUrl: r.baseUrl,
  };
  switch (r.kind) {
    case "anthropic":
      return new AnthropicBackend(cfg);
    case "gemini":
      return new GeminiBackend(cfg);
    default:
      return new OpenAICompatBackend(cfg);
  }
}

/** Single-turn AIProvider (suggestions / PR summaries / Test) for one entry. */
export function buildSuggestProvider(entry: AIProviderEntry): AIProvider | null {
  const r = resolveProvider(entry);
  if (!r) return null;
  switch (r.kind) {
    case "anthropic":
      return new ClaudeProvider({
        token: r.token,
        model: r.model,
        baseUrl: r.baseUrl,
        id: r.id,
        name: r.name,
      });
    case "gemini":
      return new GeminiProvider({ token: r.token, model: r.model, baseUrl: r.baseUrl });
    default:
      return new OpenAIProvider({
        token: r.token,
        model: r.model,
        baseUrl: r.baseUrl,
        id: r.id,
        name: r.name,
      });
  }
}

/**
 * The single entry the runtime should use. The providers array keeps every
 * key the user ever entered; only the active one is called.
 */
export function activeEntries(
  entries: AIProviderEntry[],
  activeProvider: string,
): AIProviderEntry[] {
  const active = entries.find((e) => e.provider === activeProvider);
  return active ? [active] : [];
}

export function buildBackends(entries: AIProviderEntry[]): ToolCallBackend[] {
  return entries.map(buildBackend).filter((b): b is ToolCallBackend => b !== null);
}

export function buildSuggestProviders(entries: AIProviderEntry[]): AIProvider[] {
  return entries.map(buildSuggestProvider).filter((p): p is AIProvider => p !== null);
}
