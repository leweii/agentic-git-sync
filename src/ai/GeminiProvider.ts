import { requestUrl } from "obsidian";
import type { AIProvider, AISuggestion, AISuggestionRequest } from "./AIProvider";
import { SYSTEM_PROMPT, buildPrompt, parseAIResponse } from "./prompt";

// Gemini generateContent response shape — only the fields we read.
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

// Gemini free-tier pricing — 0 for flash on free tier. Paid pricing
// per the docs (USD per token, 2026). Conservative fallback to flash rate.
const PRICING: Record<string, { in: number; out: number }> = {
  "gemini-1.5-flash":     { in: 0,                       out: 0 },
  "gemini-1.5-flash-8b":  { in: 0,                       out: 0 },
  "gemini-1.5-pro":       { in: 1.25 / 1_000_000,        out: 5.00 / 1_000_000 },
  "gemini-2.0-flash":     { in: 0.075 / 1_000_000,       out: 0.30 / 1_000_000 },
};

export interface GeminiConfig {
  token: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export class GeminiProvider implements AIProvider {
  readonly id = "gemini";
  readonly name = "Google Gemini";

  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(private cfg: GeminiConfig) {
    this.model = cfg.model ?? "gemini-1.5-flash";
    this.maxTokens = cfg.maxTokens ?? 4096;
    this.temperature = cfg.temperature ?? 0.2;
  }

  isAvailable(): boolean {
    return !!this.cfg.token;
  }

  async suggest(req: AISuggestionRequest): Promise<AISuggestion> {
    const userPrompt = buildPrompt(req);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model
    )}:generateContent?key=${encodeURIComponent(this.cfg.token)}`;

    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }],
          },
        ],
        generationConfig: {
          maxOutputTokens: this.maxTokens,
          temperature: this.temperature,
          responseMimeType: "application/json",
        },
      }),
      throw: false,
    });

    if (res.status !== 200) {
      throw new Error(`Gemini HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as GeminiResponse | null;
    const content = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!content) throw new Error("Gemini returned empty response");

    const parsed = parseAIResponse(content);
    const inputTokens = Number(body?.usageMetadata?.promptTokenCount ?? 0);
    const outputTokens = Number(body?.usageMetadata?.candidatesTokenCount ?? 0);
    const price = PRICING[this.model] ?? PRICING["gemini-1.5-flash"];

    return {
      ...parsed,
      model: this.model,
      inputTokens,
      outputTokens,
      costUsd: inputTokens * price.in + outputTokens * price.out,
    };
  }

  async complete(system: string, user: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model
    )}:generateContent?key=${encodeURIComponent(this.cfg.token)}`;

    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${system}\n\n${user}` }] }],
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
      throw: false,
    });

    if (res.status !== 200) {
      throw new Error(`Gemini HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as GeminiResponse | null;
    return body?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  }
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
