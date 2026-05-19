// Parses git conflict markers in a working-tree file into per-hunk segments
// so each hunk can be resolved independently (Take Local / Remote / Edit / Skip).

export interface ConflictHunk {
  id: string;
  startLine: number;     // 1-based, points at the <<<<<<< line
  endLine: number;       // 1-based, points just past the >>>>>>> line
  local: string[];
  remote: string[];
}

export type ConflictSegment =
  | { kind: "common"; lines: string[] }
  | { kind: "conflict"; hunk: ConflictHunk };

export type HunkResolution =
  | { kind: "local" }
  | { kind: "remote" }
  | { kind: "both" }
  | { kind: "edit"; text: string }
  | { kind: "skip" };

const MARK_START = "<<<<<<<";
const MARK_SEP = "=======";
const MARK_BASE = "|||||||";
const MARK_END = ">>>>>>>";

export function parseConflict(content: string): ConflictSegment[] {
  const lines = content.split("\n");
  const segments: ConflictSegment[] = [];
  let i = 0;
  let hunkCounter = 0;
  let commonBuffer: string[] = [];

  const flushCommon = () => {
    if (commonBuffer.length > 0) {
      segments.push({ kind: "common", lines: commonBuffer });
      commonBuffer = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith(MARK_START)) {
      flushCommon();
      const startLine = i + 1;
      const local: string[] = [];
      const remote: string[] = [];
      let phase: "local" | "base" | "remote" = "local";
      i++;
      while (i < lines.length && !lines[i].startsWith(MARK_END)) {
        if (lines[i].startsWith(MARK_BASE)) {
          phase = "base";
        } else if (lines[i].startsWith(MARK_SEP)) {
          phase = "remote";
        } else {
          if (phase === "local") local.push(lines[i]);
          else if (phase === "remote") remote.push(lines[i]);
          // base lines (diff3) are discarded
        }
        i++;
      }
      i++; // skip >>>>>>> marker
      segments.push({
        kind: "conflict",
        hunk: { id: `h${hunkCounter++}`, startLine, endLine: i, local, remote },
      });
    } else {
      commonBuffer.push(line);
      i++;
    }
  }
  flushCommon();
  return segments;
}

export function extractHunks(segments: ConflictSegment[]): ConflictHunk[] {
  const hunks: ConflictHunk[] = [];
  for (const seg of segments) {
    if (seg.kind === "conflict") hunks.push(seg.hunk);
  }
  return hunks;
}

export function applyResolutions(
  segments: ConflictSegment[],
  resolutions: Map<string, HunkResolution>
): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "common") {
      out.push(...seg.lines);
      continue;
    }
    const r = resolutions.get(seg.hunk.id);
    if (!r || r.kind === "skip") {
      out.push("<<<<<<< HEAD");
      out.push(...seg.hunk.local);
      out.push("=======");
      out.push(...seg.hunk.remote);
      out.push(">>>>>>> incoming");
    } else if (r.kind === "local") {
      out.push(...seg.hunk.local);
    } else if (r.kind === "remote") {
      out.push(...seg.hunk.remote);
    } else if (r.kind === "both") {
      out.push(...seg.hunk.local, ...seg.hunk.remote);
    } else if (r.kind === "edit") {
      out.push(...r.text.split("\n"));
    }
  }
  return out.join("\n");
}

export function isFullyResolved(
  segments: ConflictSegment[],
  resolutions: Map<string, HunkResolution>
): boolean {
  for (const seg of segments) {
    if (seg.kind !== "conflict") continue;
    const r = resolutions.get(seg.hunk.id);
    if (!r || r.kind === "skip") return false;
  }
  return true;
}

export function getContextLines(
  segments: ConflictSegment[],
  hunkId: string,
  n = 10
): { before: string[]; after: string[] } {
  const idx = segments.findIndex(
    (s) => s.kind === "conflict" && s.hunk.id === hunkId
  );
  if (idx < 0) return { before: [], after: [] };

  const before: string[] = [];
  for (let i = idx - 1; i >= 0 && before.length < n; i--) {
    const seg = segments[i];
    if (seg.kind === "common") {
      const remaining = n - before.length;
      const take = seg.lines.slice(-remaining);
      before.unshift(...take);
    }
  }

  const after: string[] = [];
  for (let j = idx + 1; j < segments.length && after.length < n; j++) {
    const seg = segments[j];
    if (seg.kind === "common") {
      const remaining = n - after.length;
      after.push(...seg.lines.slice(0, remaining));
    }
  }

  return { before, after };
}
