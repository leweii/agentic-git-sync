/**
 * AutoResolver behaviour tests with a scripted AI client and in-memory repo
 * ops. The all-or-nothing contract is the safety property: any low-confidence
 * hunk, AI failure, or marker-bearing output must abort instead of writing a
 * half-merged note.
 */

import { describe, it, expect } from "vitest";

import { AutoResolver } from "./AutoResolver";
import type { ConflictRepoOps } from "./ConflictRepoOps";
import type { AIClient } from "../ai/AIClient";
import type { AISuggestion } from "../ai/AIProvider";

const CONFLICTED = [
  "intro",
  "<<<<<<< HEAD",
  "local",
  "=======",
  "remote",
  ">>>>>>> origin/main",
  "outro",
].join("\n");

function suggestion(overrides: Partial<AISuggestion> = {}): AISuggestion {
  return {
    merged: ["merged line"],
    reasoning: [],
    confidence: 5,
    picks: [],
    model: "test",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0.01,
    ...overrides,
  };
}

class FakeOps implements ConflictRepoOps {
  files = new Map<string, string>();
  staged: string[] = [];

  async readFile(path: string): Promise<string> {
    const c = this.files.get(path);
    if (c === undefined) throw new Error(`no such file: ${path}`);
    return c;
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async stage(path: string): Promise<void> {
    this.staged.push(path);
  }
  async abortMerge(): Promise<void> {}
  async commitMergedAndPush(): Promise<number> { return 0; }
}

function fakeClient(
  suggestions: Array<AISuggestion | Error>,
  allowed: (path: string) => boolean = () => true,
): AIClient {
  const queue = [...suggestions];
  return {
    isPathAllowed: allowed,
    suggest: async () => {
      const next = queue.shift();
      if (!next) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return { suggestion: next, providerId: "test", providerName: "Test" };
    },
  } as unknown as AIClient;
}

describe("AutoResolver", () => {
  it("resolves all hunks, writes + stages files, sums cost", async () => {
    const ops = new FakeOps();
    ops.files.set("a.md", CONFLICTED);
    ops.files.set("b.md", CONFLICTED);
    const resolver = new AutoResolver(ops, fakeClient([suggestion(), suggestion()]), 4);

    const r = await resolver.resolveAll(["a.md", "b.md"]);

    expect(r).toEqual({ ok: true, fileCount: 2, hunkCount: 2, totalCostUsd: 0.02 });
    expect(ops.files.get("a.md")).toBe("intro\nmerged line\noutro");
    expect(ops.staged).toEqual(["a.md", "b.md"]);
  });

  it("aborts on a hunk below the confidence threshold — nothing written for that file", async () => {
    const ops = new FakeOps();
    ops.files.set("a.md", CONFLICTED);
    const resolver = new AutoResolver(ops, fakeClient([suggestion({ confidence: 2 })]), 4);

    const r = await resolver.resolveAll(["a.md"]);

    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/low AI confidence \(2\/5/);
      expect(r.resolvedFiles).toEqual([]);
    }
    expect(ops.files.get("a.md")).toBe(CONFLICTED);
    expect(ops.staged).toEqual([]);
  });

  it("refuses AI output that still contains conflict markers", async () => {
    const ops = new FakeOps();
    ops.files.set("a.md", CONFLICTED);
    const bad = suggestion({ merged: ["<<<<<<< HEAD", "oops"] });
    const resolver = new AutoResolver(ops, fakeClient([bad]), 4);

    const r = await resolver.resolveAll(["a.md"]);

    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/conflict markers/);
    expect(ops.files.get("a.md")).toBe(CONFLICTED);
  });

  it("aborts when a path is excluded by privacy settings", async () => {
    const ops = new FakeOps();
    ops.files.set("private/secret.md", CONFLICTED);
    const resolver = new AutoResolver(ops, fakeClient([suggestion()], () => false), 4);

    const r = await resolver.resolveAll(["private/secret.md"]);

    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/privacy/);
  });

  it("aborts on AI error but already-resolved files stay written and staged", async () => {
    const ops = new FakeOps();
    ops.files.set("a.md", CONFLICTED);
    ops.files.set("b.md", CONFLICTED);
    const resolver = new AutoResolver(
      ops,
      fakeClient([suggestion(), new Error("rate limited")]),
      4,
    );

    const r = await resolver.resolveAll(["a.md", "b.md"]);

    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/rate limited/);
      // a.md was fully resolved before the failure — the modal picks up b.md.
      expect(r.resolvedFiles).toEqual(["a.md"]);
    }
    expect(ops.files.get("a.md")).toBe("intro\nmerged line\noutro");
    expect(ops.files.get("b.md")).toBe(CONFLICTED);
    expect(ops.staged).toEqual(["a.md"]);
  });

  it("files without conflict markers are skipped, not counted", async () => {
    const ops = new FakeOps();
    ops.files.set("clean.md", "no markers here");
    const resolver = new AutoResolver(ops, fakeClient([]), 4);

    const r = await resolver.resolveAll(["clean.md"]);

    expect(r).toEqual({ ok: true, fileCount: 0, hunkCount: 0, totalCostUsd: 0 });
    expect(ops.staged).toEqual([]);
  });
});
