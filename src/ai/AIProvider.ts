// AI provider abstraction for conflict-resolution suggestions.

export interface AISuggestionRequest {
  filePath: string;
  hunk: { local: string[]; remote: string[] };
  context?: { before: string[]; after: string[] };
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
