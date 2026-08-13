/**
 * Provider factory + catalog resolution. The catalog itself is generated
 * from pi-ai's registry (scripts/generate-provider-catalog.mjs); these tests
 * pin the resolution rules, not the catalog contents.
 */

import { describe, it, expect } from "vitest";
import {
  resolveProvider,
  buildBackend,
  buildBackends,
  type AIProviderEntry,
} from "./providerFactory";
import { PROVIDER_CATALOG, catalogEntry, CUSTOM_PROVIDER_ID } from "./providerCatalog";
import { AnthropicBackend, GeminiBackend, OpenAICompatBackend } from "./piBackends";

function entry(overrides: Partial<AIProviderEntry> & { provider: string }): AIProviderEntry {
  return { token: "k", model: "", baseUrl: "", ...overrides };
}

describe("provider catalog", () => {
  it("covers the pi-supported API-key providers", () => {
    const ids = PROVIDER_CATALOG.map((c) => c.id);
    // Spot-check majors + the long tail is present at all.
    for (const id of ["openai", "anthropic", "google", "deepseek", "groq", "openrouter", "xai", "moonshotai", "zai", "together"]) {
      expect(ids).toContain(id);
    }
    expect(ids.length).toBeGreaterThanOrEqual(25);
  });

  it("every entry has a kind our backends speak and a usable baseUrl", () => {
    for (const c of PROVIDER_CATALOG) {
      expect(["openai-compat", "anthropic", "gemini"]).toContain(c.kind);
      expect(c.baseUrl).toMatch(/^https:\/\//);
      expect(c.baseUrl.endsWith("/")).toBe(false);
    }
  });
});

describe("resolveProvider", () => {
  it("fills model and baseUrl from the catalog", () => {
    const r = resolveProvider(entry({ provider: "groq" }));
    const cat = catalogEntry("groq")!;
    expect(r).toMatchObject({
      id: "groq",
      kind: "openai-compat",
      baseUrl: cat.baseUrl,
      model: cat.defaultModel,
    });
  });

  it("user model and baseUrl overrides win", () => {
    const r = resolveProvider(
      entry({ provider: "groq", model: "llama-x", baseUrl: "https://proxy.local/v1/" }),
    );
    expect(r?.model).toBe("llama-x");
    // Trailing slash is stripped so URL building stays uniform.
    expect(r?.baseUrl).toBe("https://proxy.local/v1");
  });

  it("unknown provider id resolves to null", () => {
    expect(resolveProvider(entry({ provider: "does-not-exist" }))).toBeNull();
  });

  it("custom entries need baseUrl and model", () => {
    expect(resolveProvider(entry({ provider: CUSTOM_PROVIDER_ID }))).toBeNull();
    expect(
      resolveProvider(entry({ provider: CUSTOM_PROVIDER_ID, baseUrl: "https://x/v1" })),
    ).toBeNull();
    const ok = resolveProvider(
      entry({
        provider: CUSTOM_PROVIDER_ID,
        baseUrl: "https://localhost:11434/v1",
        model: "qwen3",
        label: "Ollama",
      }),
    );
    expect(ok).toMatchObject({ kind: "openai-compat", name: "Ollama", model: "qwen3" });
  });
});

describe("buildBackend", () => {
  it("dispatches on catalog kind", () => {
    expect(buildBackend(entry({ provider: "anthropic" }))).toBeInstanceOf(AnthropicBackend);
    expect(buildBackend(entry({ provider: "google" }))).toBeInstanceOf(GeminiBackend);
    expect(buildBackend(entry({ provider: "groq" }))).toBeInstanceOf(OpenAICompatBackend);
    // MiniMax rides its Anthropic-compatible endpoint per pi's registry.
    expect(buildBackend(entry({ provider: "minimax" }))).toBeInstanceOf(AnthropicBackend);
  });

  it("carries the provider identity for logs and failover messages", () => {
    const b = buildBackend(entry({ provider: "xai" }))!;
    expect(b.id).toBe("xai");
    expect(b.name).toBe(catalogEntry("xai")!.name);
  });

  it("entries without a token yield no backend", () => {
    expect(buildBackend(entry({ provider: "groq", token: "" }))).toBeNull();
  });

  it("buildBackends keeps preference order and skips unusable entries", () => {
    const backends = buildBackends([
      entry({ provider: "groq" }),
      entry({ provider: "nope" }),
      entry({ provider: "anthropic" }),
      entry({ provider: CUSTOM_PROVIDER_ID }), // incomplete custom
    ]);
    expect(backends.map((b) => b.id)).toEqual(["groq", "anthropic"]);
  });
});
