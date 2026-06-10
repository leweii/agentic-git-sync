/**
 * Unit tests for credential sanitization. The regexes are the single line of
 * defence keeping insteadOf tokens out of logs, agent prompts, and bug
 * reports — keep them honest.
 */

import { describe, it, expect } from "vitest";

import { sanitizeSecrets, sanitizeArgs } from "./EventLog";

describe("sanitizeSecrets", () => {
  it("strips userinfo from the insteadOf-rewritten transport URL", () => {
    const msg =
      "fatal: unable to access 'https://oauth2:ghp_abc123DEF@github.com/leweii/notes.git/': The requested URL returned error: 403";
    const out = sanitizeSecrets(msg);
    expect(out).not.toContain("ghp_abc123DEF");
    expect(out).toContain("https://<creds>@github.com/leweii/notes.git");
  });

  it("strips x-access-token App-token URLs", () => {
    const out = sanitizeSecrets("push to https://x-access-token:ghs_shortLived99@github.com/org/repo failed");
    expect(out).not.toContain("ghs_shortLived99");
  });

  it("strips bare GitHub tokens outside URLs (e.g. git config --list output)", () => {
    const out = sanitizeSecrets(
      "url.https://oauth2:github_pat_11AAA_tail@github.com/leweii/.insteadof=https://github.com/leweii/",
    );
    expect(out).not.toContain("github_pat_11AAA_tail");
  });

  it("leaves credential-free text untouched", () => {
    const msg = "CONFLICT (content): Merge conflict in notes/daily.md";
    expect(sanitizeSecrets(msg)).toBe(msg);
  });
});

describe("sanitizeArgs", () => {
  it("scrubs tokens inside nested arg structures", () => {
    const out = sanitizeArgs([
      ["remote", "add", "origin", "https://oauth2:ghp_zzz@github.com/a/b.git"],
    ]) as string[][];
    expect(JSON.stringify(out)).not.toContain("ghp_zzz");
  });
});
