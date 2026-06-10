/**
 * Unit tests for conflict-marker parsing and resolution application.
 * This code rewrites user notes — a parsing bug here is data corruption,
 * so the round-trip guarantees matter more than anywhere else.
 */

import { describe, it, expect } from "vitest";

import {
  parseConflict,
  extractHunks,
  applyResolutions,
  isFullyResolved,
  getContextLines,
  type HunkResolution,
} from "./ConflictParser";

const CONFLICTED = [
  "# Title",
  "intro line",
  "<<<<<<< HEAD",
  "local A",
  "local B",
  "=======",
  "remote A",
  ">>>>>>> origin/main",
  "middle line",
  "<<<<<<< HEAD",
  "local second",
  "=======",
  "remote second",
  ">>>>>>> origin/main",
  "outro line",
].join("\n");

function res(entries: Array<[string, HunkResolution]>): Map<string, HunkResolution> {
  return new Map(entries);
}

describe("parseConflict", () => {
  it("splits content into common and conflict segments", () => {
    const segments = parseConflict(CONFLICTED);
    expect(segments.map((s) => s.kind)).toEqual([
      "common", "conflict", "common", "conflict", "common",
    ]);
    const hunks = extractHunks(segments);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].local).toEqual(["local A", "local B"]);
    expect(hunks[0].remote).toEqual(["remote A"]);
    expect(hunks[1].local).toEqual(["local second"]);
  });

  it("discards diff3 base sections (||||||| marker)", () => {
    const content = [
      "<<<<<<< HEAD",
      "local",
      "||||||| merged common ancestor",
      "base line — must not leak into either side",
      "=======",
      "remote",
      ">>>>>>> theirs",
    ].join("\n");
    const [hunk] = extractHunks(parseConflict(content));
    expect(hunk.local).toEqual(["local"]);
    expect(hunk.remote).toEqual(["remote"]);
  });

  it("content without markers is a single common segment", () => {
    const segments = parseConflict("just\nplain\ntext");
    expect(segments).toEqual([{ kind: "common", lines: ["just", "plain", "text"] }]);
    expect(extractHunks(segments)).toHaveLength(0);
  });
});

describe("applyResolutions", () => {
  it("take-local / take-remote / both / edit produce the expected merge", () => {
    const segments = parseConflict(CONFLICTED);
    const merged = applyResolutions(segments, res([
      ["h0", { kind: "local" }],
      ["h1", { kind: "edit", text: "hand-merged" }],
    ]));
    expect(merged.split("\n")).toEqual([
      "# Title",
      "intro line",
      "local A",
      "local B",
      "middle line",
      "hand-merged",
      "outro line",
    ]);

    const both = applyResolutions(segments, res([
      ["h0", { kind: "both" }],
      ["h1", { kind: "remote" }],
    ]));
    expect(both).toContain("local A\nlocal B\nremote A");
    expect(both).toContain("remote second");
    expect(both).not.toContain("<<<<<<<");
  });

  it("skipped/unresolved hunks keep conflict markers so nothing is silently dropped", () => {
    const segments = parseConflict(CONFLICTED);
    const merged = applyResolutions(segments, res([
      ["h0", { kind: "local" }],
      // h1 left unresolved
    ]));
    expect(merged).toContain("<<<<<<< HEAD");
    expect(merged).toContain("local second");
    expect(merged).toContain("remote second");
    expect(isFullyResolved(segments, res([["h0", { kind: "local" }]]))).toBe(false);
    expect(isFullyResolved(segments, res([
      ["h0", { kind: "local" }],
      ["h1", { kind: "remote" }],
    ]))).toBe(true);
  });

  it("round-trips common content byte-for-byte", () => {
    const segments = parseConflict(CONFLICTED);
    const merged = applyResolutions(segments, res([
      ["h0", { kind: "remote" }],
      ["h1", { kind: "local" }],
    ]));
    // Everything outside the hunks must be untouched, in order.
    expect(merged.startsWith("# Title\nintro line\n")).toBe(true);
    expect(merged.endsWith("\noutro line")).toBe(true);
    expect(merged).toContain("\nmiddle line\n");
  });
});

describe("getContextLines", () => {
  it("returns the nearest common lines around a hunk, capped at n", () => {
    const segments = parseConflict(CONFLICTED);
    const ctx = getContextLines(segments, "h1", 10);
    expect(ctx.before).toEqual(expect.arrayContaining(["middle line"]));
    expect(ctx.after).toEqual(["outro line"]);
    const tight = getContextLines(segments, "h0", 1);
    expect(tight.before).toEqual(["intro line"]);
    expect(tight.after).toEqual(["middle line"]);
  });

  it("unknown hunk id returns empty context", () => {
    const segments = parseConflict(CONFLICTED);
    expect(getContextLines(segments, "nope")).toEqual({ before: [], after: [] });
  });
});
