import { requestUrl } from "obsidian";
import type { AIProvider, AISuggestion, AISuggestionRequest } from "./AIProvider";
import { SYSTEM_PROMPT, buildPrompt, parseAIResponse } from "./prompt";

// OpenAI-compatible chat-completion response shape. Only the fields we
// actually read are declared; real responses contain many more.
interface DeepSeekChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// DeepSeek pricing per token (USD). Falls back to deepseek-chat rate
// if the configured model isn't listed. Source: deepseek.com docs, 2026.
const PRICING: Record<string, { in: number; out: number }> = {
  "deepseek-chat":    { in: 0.27 / 1_000_000, out: 1.10 / 1_000_000 },
  "deepseek-coder":   { in: 0.27 / 1_000_000, out: 1.10 / 1_000_000 },
  "deepseek-reasoner":{ in: 0.55 / 1_000_000, out: 2.19 / 1_000_000 },
};

export interface DeepSeekConfig {
  token: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  baseUrl?: string;
}

export class DeepSeekProvider implements AIProvider {
  readonly id = "deepseek";
  readonly name = "DeepSeek";

  private model: string;
  private maxTokens: number;
  private temperature: number;
  private baseUrl: string;

  constructor(private cfg: DeepSeekConfig) {
    this.model = cfg.model ?? "deepseek-v4-flash";
    this.maxTokens = cfg.maxTokens ?? 4096;
    this.temperature = cfg.temperature ?? 0.2;
    this.baseUrl = cfg.baseUrl ?? "https://api.deepseek.com";
  }

  isAvailable(): boolean {
    return !!this.cfg.token;
  }

  async suggest(req: AISuggestionRequest): Promise<AISuggestion> {
    const prompt = buildPrompt(req);
    const res = await requestUrl({
      url: `${this.baseUrl}/v1/chat/completions`,
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
      throw new Error(`DeepSeek HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as DeepSeekChatResponse | null;
    const content = body?.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("DeepSeek returned empty response");

    const parsed = parseAIResponse(content);
    const inputTokens = Number(body?.usage?.prompt_tokens ?? 0);
    const outputTokens = Number(body?.usage?.completion_tokens ?? 0);
    const price = PRICING[this.model] ?? PRICING["deepseek-chat"];

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
      url: `${this.baseUrl}/v1/chat/completions`,
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
      throw new Error(`DeepSeek HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as DeepSeekChatResponse | null;
    return body?.choices?.[0]?.message?.content ?? "";
  }
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
