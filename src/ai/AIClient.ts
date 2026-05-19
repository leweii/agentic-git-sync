import type { AIProvider, AISuggestion, AISuggestionRequest } from "./AIProvider";

export interface AIPrivacySettings {
  enabled: boolean;
  sendFilePaths: boolean;
  sendGitMetadata: boolean;
  sendSurroundingContext: boolean;
  excludePatterns: string[];
}

export interface AISuggestResult {
  suggestion: AISuggestion;
  providerId: string;
  providerName: string;
}

export interface AISuggestError {
  message: string;
  providerErrors: { providerId: string; providerName: string; error: string }[];
}

export class AIClient {
  constructor(private providers: AIProvider[], private privacy: AIPrivacySettings) {}

  hasAnyProvider(): boolean {
    return this.providers.some((p) => p.isAvailable());
  }

  isEnabled(): boolean {
    return this.privacy.enabled && this.hasAnyProvider();
  }

  isPathAllowed(filePath: string): boolean {
    if (!this.privacy.enabled) return false;
    for (const pat of this.privacy.excludePatterns) {
      if (matchPattern(filePath, pat)) return false;
    }
    return true;
  }

  async suggest(req: AISuggestionRequest): Promise<AISuggestResult> {
    if (!this.privacy.enabled) {
      throw new Error("AI is disabled in privacy settings");
    }
    if (!this.isPathAllowed(req.filePath)) {
      throw new Error("File path is excluded from AI by privacy settings");
    }
    if (this.providers.length === 0) {
      throw new Error("No AI providers configured");
    }

    const sanitized: AISuggestionRequest = {
      ...req,
      filePath: this.privacy.sendFilePaths ? req.filePath : "",
      context: this.privacy.sendSurroundingContext ? req.context : undefined,
      gitMeta: this.privacy.sendGitMetadata ? req.gitMeta : undefined,
    };

    const errors: { providerId: string; providerName: string; error: string }[] = [];

    for (const p of this.providers) {
      if (!p.isAvailable()) {
        errors.push({ providerId: p.id, providerName: p.name, error: "not configured" });
        continue;
      }
      try {
        const suggestion = await p.suggest(sanitized);
        return { suggestion, providerId: p.id, providerName: p.name };
      } catch (e) {
        errors.push({
          providerId: p.id,
          providerName: p.name,
          error: (e as Error).message,
        });
      }
    }

    const err = new Error(
      `All ${this.providers.length} AI provider(s) failed: ${errors
        .map((e) => `${e.providerName} (${e.error})`)
        .join("; ")}`
    ) as Error & { providerErrors: typeof errors };
    err.providerErrors = errors;
    throw err;
  }
}

// Reused from GitManager — minimal glob match with * and **.
function matchPattern(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === path) return true;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLESTAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DOUBLESTAR::/g, ".*") +
      "$"
  );
  return re.test(path);
}
