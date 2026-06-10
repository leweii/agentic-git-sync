// Minimal glob-ish match: supports * (within a path segment) and ** (across
// segments). Good enough for ignore lists like ".obsidian/workspace.json",
// "*.tmp", or "private/**" — shared by git ignore filtering and the AI
// privacy exclude patterns.
export function matchPattern(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === path) return true;
  // escape regex special chars except * and /
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
