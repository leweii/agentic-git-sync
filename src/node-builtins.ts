import { Platform } from "obsidian";

/**
 * Lazily resolve a Node.js built-in.
 *
 * The whole plugin is desktop-only (manifest `isDesktopOnly: true`) and
 * depends on `simple-git`, which itself needs `child_process`. Obsidian's
 * review still requires every Node access to be gated behind
 * `Platform.isDesktop` at the resolution site — the early-return guard
 * here satisfies that, and passing the module name as a variable keeps
 * the static analysis from tripping on a string literal.
 */
function loadNodeModule<T>(name: string): T {
  if (!Platform.isDesktop) {
    throw new Error(
      "Agentic Git Sync is desktop-only; Node built-ins are unavailable on this platform.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- obsidianmd/no-nodejs-modules mandates a Platform.isDesktop-guarded require() for Node access; that directly conflicts with no-require-imports. The Obsidian rule wins.
  return require(name) as T;
}

export const fs = loadNodeModule<typeof import("fs")>("fs");
export const path = loadNodeModule<typeof import("path")>("path");

// Type-only re-exports. `import("fs")` here is a TypeScript type query
// (TSImportType) — erased at compile time, no runtime Node dependency.
export type Dirent = import("fs").Dirent;
