import { requestUrl } from "obsidian";
import type { AIProvider, AISuggestion, AISuggestionRequest } from "./AIProvider";
import { SYSTEM_PROMPT, buildPrompt, parseAIResponse } from "./prompt";

// Anthropic Messages API response shape — only the fields we read.
interface ClaudeMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// Anthropic pricing per token (USD). Source: anthropic.com/pricing, 2026.
// Falls back to claude-sonnet-4-5 rate for unknown models.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-5":   { in: 3.00 / 1_000_000,  out: 15.00 / 1_000_000 },
  "claude-opus-4-1":     { in: 15.00 / 1_000_000, out: 75.00 / 1_000_000 },
  "claude-haiku-4-5":    { in: 0.80 / 1_000_000,  out: 4.00 / 1_000_000 },
  "claude-3-5-sonnet":   { in: 3.00 / 1_000_000,  out: 15.00 / 1_000_000 },
  "claude-3-5-haiku":    { in: 0.80 / 1_000_000,  out: 4.00 / 1_000_000 },
};

export interface ClaudeConfig {
  token: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
}

export class ClaudeProvider implements AIProvider {
  readonly id = "claude";
  readonly name = "Claude";

  private model: string;
  private maxTokens: number;
  private temperature: number;
  private baseUrl: string;

  constructor(private cfg: ClaudeConfig) {
    this.model = cfg.model ?? "claude-sonnet-4-5";
    this.maxTokens = cfg.maxTokens ?? 4096;
    this.temperature = cfg.temperature ?? 0.2;
    this.baseUrl = cfg.baseUrl ?? "https://api.anthropic.com";
  }

  isAvailable(): boolean {
    return !!this.cfg.token;
  }

  async suggest(req: AISuggestionRequest): Promise<AISuggestion> {
    const prompt = buildPrompt(req);
    const res = await requestUrl({
      url: `${this.baseUrl}/v1/messages`,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
      throw: false,
    });

    if (res.status !== 200) {
      throw new Error(`Claude HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as ClaudeMessagesResponse | null;
    const content = textFromContent(body);
    if (!content) throw new Error("Claude returned empty response");

    const parsed = parseAIResponse(content);
    const inputTokens = Number(body?.usage?.input_tokens ?? 0);
    const outputTokens = Number(body?.usage?.output_tokens ?? 0);
    const price = PRICING[this.model] ?? PRICING["claude-sonnet-4-5"];

    return {
      ...parsed,
      model: this.model,
      inputTokens,
      outputTokens,
      costUsd: inputTokens * price.in + outputTokens * price.out,
    };
  }

  /**
   * Anthropic's Messages API has no `response_format: json_object` toggle.
   * We rely on the system prompt's "return STRICT JSON" instruction (see
   * reactPrompt.ts) — the model complies reliably in practice. The agent's
   * parseReactStep is tolerant of stray markdown fences.
   */
  async complete(system: string, user: string): Promise<string> {
    const res = await requestUrl({
      url: `${this.baseUrl}/v1/messages`,
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 512,
        temperature: 0.1,
        system,
        messages: [{ role: "user", content: user }],
      }),
      throw: false,
    });

    if (res.status !== 200) {
      throw new Error(`Claude HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as ClaudeMessagesResponse | null;
    return textFromContent(body);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.cfg.token,
      "anthropic-version": "2023-06-01",
    };
  }
}

function textFromContent(body: ClaudeMessagesResponse | null): string {
  if (!body?.content) return "";
  const parts = body.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text);
  return parts.join("");
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
