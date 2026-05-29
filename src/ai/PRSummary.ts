import type { AIProvider } from "./AIProvider";

export interface PRSummary {
  title: string;
  body: string;
}

export interface PRSummaryInputs {
  head: string;
  base: string;
  commits: string[];
  diffStat: string;
}

const SYSTEM_PROMPT = [
  "You write concise GitHub pull request summaries.",
  "Output a single JSON object with EXACTLY these two keys and no others:",
  "  - title: a short imperative sentence under 72 characters describing the change. No trailing period. No prefixes like 'feat:' or 'fix:'.",
  "  - body: GitHub-flavored markdown, 2-5 sentences. Explain what changed and why. If multiple commits or files are involved, group them logically. Don't repeat the title verbatim.",
  "Return raw JSON only — no surrounding text, no code fences. Use the user's primary language inferred from the commit messages.",
].join("\n");

function buildUserPrompt(inp: PRSummaryInputs): string {
  const lines: string[] = [];
  lines.push(`Pull request: ${inp.head} → ${inp.base}`);
  lines.push("");
  if (inp.commits.length > 0) {
    lines.push("Commits in this PR (oldest first):");
    for (const c of inp.commits) lines.push(`- ${c}`);
  } else {
    lines.push("Commits in this PR: (none collected — diff may be the only signal)");
  }
  lines.push("");
  if (inp.diffStat.trim()) {
    lines.push("Diff stat:");
    lines.push("```");
    lines.push(inp.diffStat.trim());
    lines.push("```");
  }
  return lines.join("\n");
}

/**
 * Tolerant JSON extractor — providers occasionally wrap their output in
 * markdown fences or add a stray prefix despite the system prompt.
 * Strip any ```json fence and find the first balanced object.
 */
function parseJsonObject(raw: string): unknown {
  const stripped = raw
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch { /* try harder */ }

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(stripped.slice(start, end + 1));
    } catch { /* give up */ }
  }
  return null;
}

function asSummary(parsed: unknown): PRSummary | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  if (!title) return null;
  return { title, body };
}

/**
 * Ask the first available AI provider to draft a PR title + body. Returns
 * null if no provider is configured or every configured provider failed
 * (network, auth, bad JSON, etc.) — the caller is expected to fall back
 * to a plain default and let the user edit.
 *
 * Never throws.
 */
export async function generatePRSummary(
  providers: AIProvider[],
  inputs: PRSummaryInputs,
): Promise<PRSummary | null> {
  const available = providers.filter((p) => p.isAvailable());
  if (available.length === 0) return null;

  const user = buildUserPrompt(inputs);

  for (const p of available) {
    try {
      const raw = await p.complete(SYSTEM_PROMPT, user);
      const summary = asSummary(parseJsonObject(raw));
      if (summary) return summary;
      console.warn(
        `[agentic-git-sync] PR draft: ${p.name} returned unparseable response:`,
        raw.slice(0, 300),
      );
    } catch (e) {
      console.warn(
        `[agentic-git-sync] PR draft: ${p.name} failed:`,
        (e as Error).message ?? e,
      );
    }
  }
  return null;
}
