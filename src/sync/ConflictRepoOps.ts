// Repo-agnostic operations needed by ConflictModal + AutoResolver.
// Lets us treat the main vault and submodules through the same API —
// each just supplies a different read/write/stage path-prefix and git
// instance.

export interface ConflictRepoOps {
  /** Read a conflicted file. Path is repo-relative (no leading prefix). */
  readFile(path: string): Promise<string>;
  /** Write resolved content. Path is repo-relative. */
  writeFile(path: string, content: string): Promise<void>;
  /** Stage the resolved file in git (i.e., `git add <path>`). */
  stage(path: string): Promise<void>;
  /** Abort the in-progress merge in this repo. */
  abortMerge(): Promise<void>;
  /** After all files are staged, finalize the merge commit + push. */
  commitMergedAndPush(message: string, onProgress?: (msg: string) => void): Promise<number>;
}
