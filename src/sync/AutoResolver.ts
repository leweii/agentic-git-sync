import type { AIClient } from "../ai/AIClient";
import type { ConflictRepoOps } from "./ConflictRepoOps";
import {
  parseConflict,
  extractHunks,
  getContextLines,
  applyResolutions,
  type HunkResolution,
} from "./ConflictParser";

export type AutoResolveResult =
  | { ok: true; fileCount: number; hunkCount: number; totalCostUsd: number }
  | { ok: false; reason: string; resolvedFiles: string[] };

const CONFLICT_MARKER_RE = /^(<<<<<<<|=======$|>>>>>>>)/;

/**
 * Resolves all conflicts in `paths` via AI without opening any UI.
 * Repo-agnostic — driven by ConflictRepoOps (vault or submodule).
 *
 * All-or-nothing: if any hunk fails (low confidence, AI error, excluded
 * path, markers in the model output), aborts and returns ok:false.
 * Already-written files stay written and staged — the modal can pick up
 * the remainder.
 */
export class AutoResolver {
  constructor(
    private ops: ConflictRepoOps,
    private aiClient: AIClient,
    private minConfidence: number
  ) {}

  async resolveAll(paths: string[]): Promise<AutoResolveResult> {
    let totalHunks = 0;
    let totalCostUsd = 0;
    const resolvedFiles: string[] = [];

    for (const path of paths) {
      if (!this.aiClient.isPathAllowed(path)) {
        return { ok: false, reason: `${path} is excluded from AI by privacy settings`, resolvedFiles };
      }

      let content: string;
      try {
        content = await this.ops.readFile(path);
      } catch (e) {
        return { ok: false, reason: `couldn't read ${path}: ${(e as Error).message}`, resolvedFiles };
      }

      const segments = parseConflict(content);
      const hunks = extractHunks(segments);
      if (hunks.length === 0) continue;

      const resolutions = new Map<string, HunkResolution>();
      for (const hunk of hunks) {
        const ctx = getContextLines(segments, hunk.id, 10);
        try {
          const r = await this.aiClient.suggest({
            filePath: path,
            hunk: { local: hunk.local, remote: hunk.remote },
            context: ctx,
          });
          const sug = r.suggestion;
          if (sug.confidence < this.minConfidence) {
            return {
              ok: false,
              reason: `low AI confidence (${sug.confidence}/5, threshold ${this.minConfidence}) on a hunk in ${path}`,
              resolvedFiles,
            };
          }
          if (sug.merged.some((line) => CONFLICT_MARKER_RE.test(line))) {
            return {
              ok: false,
              reason: `AI returned conflict markers in ${path} — refusing to apply`,
              resolvedFiles,
            };
          }
          resolutions.set(hunk.id, { kind: "edit", text: sug.merged.join("\n") });
          totalHunks++;
          totalCostUsd += sug.costUsd;
        } catch (e) {
          return { ok: false, reason: `AI failed on ${path}: ${(e as Error).message}`, resolvedFiles };
        }
      }

      const merged = applyResolutions(segments, resolutions);
      try {
        await this.ops.writeFile(path, merged);
        await this.ops.stage(path);
        resolvedFiles.push(path);
      } catch (e) {
        return { ok: false, reason: `couldn't write ${path}: ${(e as Error).message}`, resolvedFiles };
      }
    }

    return { ok: true, fileCount: resolvedFiles.length, hunkCount: totalHunks, totalCostUsd };
  }
}
