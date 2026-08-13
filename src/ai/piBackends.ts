/**
 * Native tool-calling backends for the pi-agent-core recovery loop.
 *
 * pi-ai ships real provider adapters, but they drag entire vendor SDKs into
 * the bundle and use `fetch`, which Obsidian's renderer CORS-blocks for most
 * providers. These backends speak each provider's wire format directly over
 * Obsidian's `requestUrl` (same approach as the AIProvider classes used for
 * conflict suggestions) and translate to/from pi-ai's neutral Message types,
 * so one transcript can replay against any provider mid-run.
 *
 * Each `chat()` call is one non-streaming completion: full pi context in,
 * one AssistantMessage (text + native tool calls) out. The GitReActAgent's
 * streamFn wraps the result in a synthetic event stream.
 */

import { requestUrl } from "obsidian";
import type {
  AssistantMessage,
  Message,
  TextContent,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";

export interface BackendChatRequest {
  system: string;
  messages: Message[];
  tools: Tool[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * One configured LLM endpoint the agent can plan with. The narrow interface
 * (vs AIProvider) exists so tests can script native tool calls without HTTP.
 */
export interface ToolCallBackend {
  id: string;
  name: string;
  isAvailable(): boolean;
  chat(req: BackendChatRequest): Promise<AssistantMessage>;
}

/**
 * Fully-resolved backend config. Resolution (catalog defaults, custom
 * overrides) happens in providerFactory.ts — backends never guess URLs.
 * `baseUrl` is the catalog-convention prefix: openai-compat appends
 * "/chat/completions", anthropic appends "/v1/messages", gemini appends
 * "/models/{model}:generateContent".
 */
export interface BackendConfig {
  id: string;
  name: string;
  token: string;
  model: string;
  baseUrl: string;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.1;

function zeroUsage(input = 0, output = 0): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Flatten a user/toolResult content field to plain text. */
function textOf(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export class AnthropicBackend implements ToolCallBackend {
  readonly id: string;
  readonly name: string;
  private model: string;
  private baseUrl: string;

  // Also serves Anthropic-compatible endpoints (MiniMax) via cfg.baseUrl.
  constructor(private cfg: BackendConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl;
  }

  isAvailable(): boolean {
    return !!this.cfg.token;
  }

  async chat(req: BackendChatRequest): Promise<AssistantMessage> {
    // Anthropic requires strictly alternating roles; tool results are user
    // blocks, so consecutive user-role entries are merged into one message.
    const wire: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];
    const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
      const last = wire[wire.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else wire.push({ role, content: blocks });
    };

    for (const m of req.messages) {
      if (m.role === "user") {
        push("user", [{ type: "text", text: textOf(m.content) }]);
      } else if (m.role === "assistant") {
        const blocks: AnthropicBlock[] = [];
        for (const c of m.content) {
          if (c.type === "text" && c.text.trim()) blocks.push({ type: "text", text: c.text });
          if (c.type === "toolCall") {
            blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
          }
        }
        if (blocks.length > 0) push("assistant", blocks);
      } else if (m.role === "toolResult") {
        push("user", [{
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: textOf(m.content),
          is_error: m.isError || undefined,
        }]);
      }
    }

    const res = await requestUrl({
      url: `${this.baseUrl}/v1/messages`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.cfg.token,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature ?? DEFAULT_TEMPERATURE,
        system: req.system,
        messages: wire,
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      }),
      throw: false,
    });
    if (res.status !== 200) {
      throw new Error(`${this.name} HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as {
      content?: AnthropicBlock[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    } | null;

    const content: AssistantMessage["content"] = [];
    for (const block of body?.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        content.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use" && block.id && block.name) {
        content.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: (block.input ?? {}),
        });
      }
    }

    return {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: this.id,
      model: this.model,
      usage: zeroUsage(Number(body?.usage?.input_tokens ?? 0), Number(body?.usage?.output_tokens ?? 0)),
      stopReason: content.some((c) => c.type === "toolCall")
        ? "toolUse"
        : body?.stop_reason === "max_tokens" ? "length" : "stop",
      timestamp: Date.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions (OpenAI, DeepSeek)
// ---------------------------------------------------------------------------

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export class OpenAICompatBackend implements ToolCallBackend {
  readonly id: string;
  readonly name: string;
  private model: string;
  private baseUrl: string;

  constructor(private cfg: BackendConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl;
  }

  isAvailable(): boolean {
    return !!this.cfg.token;
  }

  async chat(req: BackendChatRequest): Promise<AssistantMessage> {
    const wire: Array<Record<string, unknown>> = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "user") {
        wire.push({ role: "user", content: textOf(m.content) });
      } else if (m.role === "assistant") {
        const text = m.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        const toolCalls = m.content
          .filter((c): c is ToolCall => c.type === "toolCall")
          .map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          }));
        wire.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      } else if (m.role === "toolResult") {
        wire.push({ role: "tool", tool_call_id: m.toolCallId, content: textOf(m.content) });
      }
    }

    const res = await requestUrl({
      url: `${this.baseUrl}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature ?? DEFAULT_TEMPERATURE,
        messages: wire,
        tools: req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }),
      throw: false,
    });
    if (res.status !== 200) {
      throw new Error(`${this.name} HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const msg = body?.choices?.[0]?.message;

    const content: AssistantMessage["content"] = [];
    if (msg?.content) content.push({ type: "text", text: msg.content });
    for (const tc of msg?.tool_calls ?? []) {
      if (tc.type !== "function" || !tc.function?.name) continue;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch { /* malformed args — schema validation downstream reports it */ }
      content.push({
        type: "toolCall",
        id: tc.id ?? `call_${content.length}`,
        name: tc.function.name,
        arguments: args,
      });
    }

    return {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: this.id,
      model: this.model,
      usage: zeroUsage(Number(body?.usage?.prompt_tokens ?? 0), Number(body?.usage?.completion_tokens ?? 0)),
      stopReason: content.some((c) => c.type === "toolCall")
        ? "toolUse"
        : body?.choices?.[0]?.finish_reason === "length" ? "length" : "stop",
      timestamp: Date.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// Google Gemini generateContent
// ---------------------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

/**
 * Gemini's function declarations take an OpenAPI-flavoured schema subset.
 * Strip JSON-Schema keywords it rejects; our tool schemas only use the
 * portable core (type/description/properties/required/items/enum) anyway.
 */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "additionalProperties" || k === "$schema" || k === "default") continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

export class GeminiBackend implements ToolCallBackend {
  readonly id: string;
  readonly name: string;
  private model: string;
  private baseUrl: string;

  constructor(private cfg: BackendConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.model = cfg.model;
    this.baseUrl = cfg.baseUrl;
  }

  isAvailable(): boolean {
    return !!this.cfg.token;
  }

  async chat(req: BackendChatRequest): Promise<AssistantMessage> {
    const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> = [];
    const push = (role: "user" | "model", parts: GeminiPart[]) => {
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push(...parts);
      else contents.push({ role, parts });
    };

    // Gemini identifies tool responses by function *name*, not call id.
    for (const m of req.messages) {
      if (m.role === "user") {
        push("user", [{ text: textOf(m.content) }]);
      } else if (m.role === "assistant") {
        const parts: GeminiPart[] = [];
        for (const c of m.content) {
          if (c.type === "text" && c.text.trim()) parts.push({ text: c.text });
          if (c.type === "toolCall") parts.push({ functionCall: { name: c.name, args: c.arguments } });
        }
        if (parts.length > 0) push("model", parts);
      } else if (m.role === "toolResult") {
        push("user", [{
          functionResponse: {
            name: m.toolName,
            response: m.isError ? { error: textOf(m.content) } : { result: textOf(m.content) },
          },
        }]);
      }
    }

    const url = `${this.baseUrl}/models/${encodeURIComponent(
      this.model,
    )}:generateContent?key=${encodeURIComponent(this.cfg.token)}`;
    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents,
        tools: [{
          functionDeclarations: req.tools.map((t) => {
            const params = geminiSchema(t.parameters) as { properties?: Record<string, unknown> };
            // Gemini rejects OBJECT schemas with empty properties — no-arg
            // tools must omit the parameters field entirely.
            const hasParams = Object.keys(params?.properties ?? {}).length > 0;
            return {
              name: t.name,
              description: t.description,
              ...(hasParams ? { parameters: params } : {}),
            };
          }),
        }],
        generationConfig: {
          maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          temperature: req.temperature ?? DEFAULT_TEMPERATURE,
        },
      }),
      throw: false,
    });
    if (res.status !== 200) {
      throw new Error(`${this.name} HTTP ${res.status} — ${truncate(res.text, 200)}`);
    }

    const body = res.json as {
      candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    } | null;
    const candidate = body?.candidates?.[0];

    const content: AssistantMessage["content"] = [];
    let callSeq = 0;
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text) {
        content.push({ type: "text", text: part.text });
      } else if (part.functionCall?.name) {
        content.push({
          type: "toolCall",
          // Gemini has no call ids — synthesize unique ones for the transcript.
          id: `gemini_call_${Date.now()}_${callSeq++}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        });
      }
    }

    return {
      role: "assistant",
      content,
      api: "google-generative-ai",
      provider: this.id,
      model: this.model,
      usage: zeroUsage(
        Number(body?.usageMetadata?.promptTokenCount ?? 0),
        Number(body?.usageMetadata?.candidatesTokenCount ?? 0),
      ),
      stopReason: content.some((c) => c.type === "toolCall")
        ? "toolUse"
        : candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop",
      timestamp: Date.now(),
    };
  }
}
