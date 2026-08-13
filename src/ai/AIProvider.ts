// AI provider abstraction for conflict-resolution suggestions.

export interface AISuggestionRequest {
  filePath: string;
  hunk: { local: string[]; remote: string[] };
  context?: { before: string[]; after: string[] };
  /** Extra user/team merge rules, appended to the prompt verbatim. */
  instructions?: string;
  gitMeta?: {
    localCommit?: string;
    remoteCommit?: string;
    localAuthor?: string;
    remoteAuthor?: string;
  };
}

export interface AISuggestion {
  merged: string[];
  reasoning: string[];
  confidence: number; // 0-5
  picks: number[];    // line indices in `merged` that came from one side (used for ★ marks)
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AIProvider {
  id: string;
  name: string;
  isAvailable(): boolean;
  suggest(req: AISuggestionRequest): Promise<AISuggestion>;
  /** Generic single-turn text completion — returns the raw response string. */
  complete(system: string, user: string): Promise<string>;
}

/**
 * Smoke-test a provider by sending a minimal probe through `complete()`.
 * Exercises the real auth path, the configured model name, and JSON mode
 * (which is what `suggest()` actually relies on) in one HTTP call. Costs
 * a handful of tokens per click, never throws — failures are reported in
 * the returned `message`.
 */
export async function testAIProvider(
  provider: AIProvider,
): Promise<{ ok: boolean; message: string }> {
  if (!provider.isAvailable()) {
    return { ok: false, message: "No API key configured" };
  }
  try {
    const reply = await provider.complete(
      'Respond with the JSON object {"ok":true} and nothing else.',
      "ping",
    );
    if (!reply || !reply.trim()) {
      return { ok: false, message: "Empty response" };
    }
    return { ok: true, message: "OK" };
  } catch (e) {
    const raw = (e as Error).message ?? String(e);
    return { ok: false, message: raw.replace(/\s+/g, " ").trim().slice(0, 200) };
  }
}
