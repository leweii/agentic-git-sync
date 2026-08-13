import { requestUrl } from "obsidian";
import type { AIProvider, AISuggestion, AISuggestionRequest } from "./AIProvider";
import { SYSTEM_PROMPT, buildPrompt, parseAIResponse } from "./prompt";

// OpenAI chat-completion response shape. Only the fields we actually
// read are declared; real responses contain many more.
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// OpenAI pricing per token (USD). Falls back to gpt-4o-mini if the
// configured model isn't listed. Source: openai.com/api/pricing, 2026.
const PRICING: Record<string, { in: number; out: number }> = {
  "gpt-4o-mini":  { in: 0.15 / 1_000_000, out: 0.60 / 1_000_000 },
  "gpt-4o":       { in: 2.50 / 1_000_000, out: 10.00 / 1_000_000 },
  "gpt-4.1-nano": { in: 0.10 / 1_000_000, out: 0.40 / 1_000_000 },
  "gpt-4.1-mini": { in: 0.40 / 1_000_000, out: 1.60 / 1_000_000 },
  "gpt-4.1":      { in: 2.00 / 1_000_000, out: 8.00 / 1_000_000 },
  "gpt-5":        { in: 2.50 / 1_000_000, out: 10.00 / 1_000_000 },
  "gpt-5.5":      { in: 3.00 / 1_000_000, out: 12.00 / 1_000_000 },
};

export interface OpenAIConfig {
  token: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** URL prefix including the version segment, e.g. "https://api.openai.com/v1". */
  baseUrl?: string;
  /** Override id/name when serving another OpenAI-compatible provider. */
  id?: string;
  name?: string;
}

/**
 * Speaks the OpenAI chat-completions dialect — the de-facto standard served
 * by most providers in the catalog (Groq, xAI, Moonshot, Together, …), so
 * one class covers them all via id/name/baseUrl config.
 */
export class OpenAIProvider implements AIProvider {
  readonly id: string;
  readonly name: string;

  private model: string;
  private maxTokens: number;
  private temperature: number;
  private baseUrl: string;

  constructor(private cfg: OpenAIConfig) {
    this.id = cfg.id ?? "openai";
    this.name = cfg.name ?? "OpenAI";
    this.model = cfg.model ?? "gpt-5.5";
    this.maxTokens = cfg.maxTokens ?? 4096;
    this.temperature = cfg.temperature ?? 0.2;
    this.baseUrl = cfg.baseUrl ?? "https://api.openai.com/v1";
  }

  isAvailable(): boolean {
    return !!this.cfg.token;
  }

  async suggest(req: AISuggestionRequest): Promise<AISuggestion> {
    const prompt = buildPrompt(req);
    const res = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
      throw: false,
    });

    if (res.status !== 200) {
      throw new Error(`${this.name} HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as OpenAIChatResponse | null;
    const content = body?.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error(`${this.name} returned empty response`);

    const parsed = parseAIResponse(content);
    const inputTokens = Number(body?.usage?.prompt_tokens ?? 0);
    const outputTokens = Number(body?.usage?.completion_tokens ?? 0);
    // Unknown model (e.g. a non-OpenAI provider through this class): report
    // zero cost rather than a wrong OpenAI rate.
    const price = PRICING[this.model] ?? (this.id === "openai" ? PRICING["gpt-5.5"] : { in: 0, out: 0 });

    return {
      ...parsed,
      model: this.model,
      inputTokens,
      outputTokens,
      costUsd: inputTokens * price.in + outputTokens * price.out,
    };
  }

  async complete(system: string, user: string): Promise<string> {
    const res = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        temperature: 0.1,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
      throw: false,
    });

    if (res.status !== 200) {
      throw new Error(`${this.name} HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as OpenAIChatResponse | null;
    return body?.choices?.[0]?.message?.content ?? "";
  }
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
