import type { DataAdapter } from "obsidian";
import {
  REPO_CONFIG_FILENAME,
  parseRepoConfig,
  serializeRepoConfig,
  type RepoConfigV1,
} from "./RepoConfig";

function pathFor(rootPath: string): string {
  const trimmed = rootPath.replace(/\/+$/, "");
  return trimmed ? `${trimmed}/${REPO_CONFIG_FILENAME}` : REPO_CONFIG_FILENAME;
}

/**
 * Read `.github-sync.json` from a repo root. Returns null if missing or
 * unreadable — caller falls back to data.json defaults.
 */
export async function readRepoConfig(
  adapter: DataAdapter,
  rootPath: string
): Promise<RepoConfigV1 | null> {
  const filePath = pathFor(rootPath);
  try {
    const exists = await adapter.exists(filePath);
    if (!exists) return null;
    const text = await adapter.read(filePath);
    const raw: unknown = JSON.parse(text);
    return parseRepoConfig(raw);
  } catch (e) {
    console.warn(`[github-sync] couldn't read ${filePath}:`, e);
    return null;
  }
}

export async function writeRepoConfig(
  adapter: DataAdapter,
  rootPath: string,
  cfg: RepoConfigV1
): Promise<void> {
  const filePath = pathFor(rootPath);
  await adapter.write(filePath, serializeRepoConfig(cfg));
}

export async function repoConfigExists(
  adapter: DataAdapter,
  rootPath: string
): Promise<boolean> {
  return adapter.exists(pathFor(rootPath));
}
