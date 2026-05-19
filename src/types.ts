export type SyncPhase =
  | "idle"
  | "checking"
  | "pulling"
  | "committing"
  | "pushing"
  | "synced"
  | "error"
  | "conflict";

export interface SyncProgress {
  phase: SyncPhase;
  message?: string;
  conflicts?: string[];
}

export interface PendingChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  conflicted: string[];
  total: number;
}

export interface SyncHistoryEntry {
  repoId: string;
  repoLabel: string;
  time: number;
  status: "success" | "error";
  filesCount: number;
  message: string;
}

export const VAULT_REPO_ID = "__vault__";
