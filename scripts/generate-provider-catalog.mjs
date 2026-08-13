#!/usr/bin/env node
/**
 * Generate src/ai/providerCatalog.ts from pi-ai's provider registry.
 *
 * pi-ai (node_modules/@earendil-works/pi-ai/dist/providers/) is the source
 * of truth for provider ids, display names, base URLs, and model catalogs.
 * We curate that list down to providers a desktop Obsidian plugin can speak
 * to with an API key over Obsidian's requestUrl:
 *
 *   - openai-compat  → POST {baseUrl}/chat/completions   (Bearer auth)
 *   - anthropic      → POST {baseUrl}/v1/messages        (x-api-key auth)
 *   - gemini         → POST {baseUrl}/models/{m}:generateContent?key=…
 *
 * Excluded: OAuth/device-flow providers (github-copilot, openai-codex,
 * kimi-coding, opencode, radius), cloud-signature APIs (amazon-bedrock,
 * google-vertex), and providers needing per-account URLs (azure,
 * cloudflare-*). Users can still reach anything OpenAI-compatible via the
 * "custom" entry in the settings UI.
 *
 * Run: node scripts/generate-provider-catalog.mjs
 * Output is checked in — rerun after upgrading @earendil-works/pi-ai.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providersDir = path.join(root, "node_modules/@earendil-works/pi-ai/dist/providers");
const dataDir = path.join(providersDir, "data");
const outFile = path.join(root, "src/ai/providerCatalog.ts");

/**
 * Curated include list. `kind` decides the wire protocol our backends use.
 * `baseUrl` overrides pi's value where we deliberately use a provider's
 * OpenAI-compatible endpoint instead of pi's proprietary-API adapter
 * (mistral: conversations API; fireworks/vercel: pi prefers their
 * anthropic-compat endpoint, the OpenAI-compat one is the stable documented
 * path for arbitrary models).
 */
const INCLUDE = {
  openai: { kind: "openai-compat", baseUrl: "https://api.openai.com/v1", keyPlaceholder: "sk-…" },
  anthropic: { kind: "anthropic", keyPlaceholder: "sk-ant-…" },
  google: { kind: "gemini", keyPlaceholder: "AIza…" },
  deepseek: { kind: "openai-compat", keyPlaceholder: "sk-…" },
  xai: { kind: "openai-compat" },
  groq: { kind: "openai-compat" },
  cerebras: { kind: "openai-compat" },
  openrouter: { kind: "openai-compat", keyPlaceholder: "sk-or-…" },
  mistral: { kind: "openai-compat", baseUrl: "https://api.mistral.ai/v1" },
  fireworks: { kind: "openai-compat", baseUrl: "https://api.fireworks.ai/inference/v1" },
  together: { kind: "openai-compat" },
  moonshotai: { kind: "openai-compat" },
  "moonshotai-cn": { kind: "openai-compat" },
  minimax: { kind: "anthropic" },
  "minimax-cn": { kind: "anthropic" },
  nvidia: { kind: "openai-compat" },
  huggingface: { kind: "openai-compat" },
  baseten: { kind: "openai-compat" },
  xiaomi: { kind: "openai-compat" },
  "xiaomi-token-plan-cn": { kind: "openai-compat" },
  "xiaomi-token-plan-ams": { kind: "openai-compat" },
  "xiaomi-token-plan-sgp": { kind: "openai-compat" },
  zai: { kind: "openai-compat" },
  "zai-coding-cn": { kind: "openai-compat" },
  "vercel-ai-gateway": { kind: "openai-compat", baseUrl: "https://ai-gateway.vercel.sh/v1" },
  "qwen-token-plan": { kind: "openai-compat" },
  "qwen-token-plan-cn": { kind: "openai-compat" },
  "qwen-token-plan-individual": { kind: "openai-compat" },
  "ant-ling": { kind: "openai-compat" },
};

function parseProviderFile(id) {
  const file = path.join(providersDir, `${id}.js`);
  const src = fs.readFileSync(file, "utf8");
  const name = src.match(/name:\s*"([^"]+)"/)?.[1];
  const baseUrl = src.match(/baseUrl:\s*"([^"]+)"/)?.[1];
  if (!name) throw new Error(`no display name in ${file}`);
  return { name, baseUrl };
}

function modelCatalogFor(id) {
  const dataFile = path.join(dataDir, `${id}.json`);
  if (!fs.existsSync(dataFile)) return [];
  const byApi = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const seen = new Set();
  const models = [];
  for (const m of Object.values(byApi).flatMap((v) => Object.values(v))) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    models.push(m);
  }
  return models;
}

/**
 * Preferred defaults for the majors — current fast-tier models. The
 * generator asserts each override still exists in pi's model list, so a
 * pi-ai upgrade that retires one fails the build instead of shipping a
 * stale default (that's how "deepseek-chat" once lingered here).
 */
const DEFAULT_MODEL_OVERRIDES = {
  openai: "gpt-5-mini",
  google: "gemini-flash-latest", // rolling alias — tracks the current flash
  anthropic: "claude-sonnet-5",
};

function defaultModelFor(id, models) {
  const override = DEFAULT_MODEL_OVERRIDES[id];
  if (override) {
    if (!models.some((m) => m.id === override)) {
      throw new Error(`default model override '${override}' for ${id} is not in pi's current model list — update DEFAULT_MODEL_OVERRIDES`);
    }
    return override;
  }
  return models[0]?.id ?? "";
}

const entries = [];
for (const [id, overrides] of Object.entries(INCLUDE)) {
  const parsed = parseProviderFile(id);
  const baseUrl = overrides.baseUrl ?? parsed.baseUrl;
  if (!baseUrl) throw new Error(`no baseUrl for ${id}`);
  const models = modelCatalogFor(id);
  entries.push({
    id,
    name: parsed.name,
    kind: overrides.kind,
    baseUrl,
    defaultModel: defaultModelFor(id, models),
    // pi's order preserved — current models first, display names for the UI.
    models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
    keyPlaceholder: overrides.keyPlaceholder ?? "API key",
  });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const piVersion = JSON.parse(
  fs.readFileSync(path.join(root, "node_modules/@earendil-works/pi-ai/package.json"), "utf8"),
).version;

const body = entries
  .map(
    (e) => `  {
    id: ${JSON.stringify(e.id)},
    name: ${JSON.stringify(e.name)},
    kind: ${JSON.stringify(e.kind)},
    baseUrl: ${JSON.stringify(e.baseUrl)},
    defaultModel: ${JSON.stringify(e.defaultModel)},
    models: ${JSON.stringify(e.models)},
    keyPlaceholder: ${JSON.stringify(e.keyPlaceholder)},
  },`,
  )
  .join("\n");

fs.writeFileSync(
  outFile,
  `// GENERATED by scripts/generate-provider-catalog.mjs — do not edit by hand.
// Source: @earendil-works/pi-ai ${piVersion} provider registry, curated to
// API-key providers reachable over Obsidian requestUrl. Rerun the script
// after upgrading pi-ai. See the script header for inclusion criteria.

/** Wire protocol our backends speak to this provider. */
export type ProviderKind = "openai-compat" | "anthropic" | "gemini";

export interface ProviderCatalogEntry {
  /** pi-ai provider id — also the settings/secret-store key. */
  id: string;
  name: string;
  kind: ProviderKind;
  /**
   * URL prefix per kind: openai-compat → +"/chat/completions",
   * anthropic → +"/v1/messages", gemini → +"/models/{model}:generateContent".
   */
  baseUrl: string;
  /** pi's first listed model — the current sane default. */
  defaultModel: string;
  /** Models pi currently lists for this provider, pi's order (dropdown options). */
  models: Array<{ id: string; name: string }>;
  keyPlaceholder: string;
}

/** Sentinel id for user-defined OpenAI-compatible endpoints. */
export const CUSTOM_PROVIDER_ID = "custom";

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
${body}
];

export function catalogEntry(id: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((e) => e.id === id);
}
`,
);

console.log(`wrote ${outFile} with ${entries.length} providers (pi-ai ${piVersion})`);
