/**
 * Durable world-camera assistant-completion history (T08).
 *
 * The history is a separate product read model: it never touches the canvas
 * aggregate, Y.Doc, command receipts or node generation history. One assistant
 * completion (stable OC05a key) produces at most one row.
 *
 * The repository is intentionally synchronous-free (promises) so the SQLite and
 * in-memory implementations stay interchangeable and tests can restart the
 * service against the same database.
 */
import { stableStringify, type WorldCameraHistoryEntry } from "@woohaa3/contracts";

export type WorldCameraHistoryInsertResult =
  | { status: "inserted"; entry: WorldCameraHistoryEntry }
  | { status: "duplicate"; entry: WorldCameraHistoryEntry }
  | { status: "conflict"; entry: WorldCameraHistoryEntry };

export interface WorldCameraHistoryRepository {
  /** Insert once per completion key; a different snapshot for the same key conflicts. */
  insert(entry: WorldCameraHistoryEntry): Promise<WorldCameraHistoryInsertResult>;
  get(canvasId: string, completionKey: string): Promise<WorldCameraHistoryEntry | null>;
  list(canvasId: string, cameraId: string, limit?: number): Promise<WorldCameraHistoryEntry[]>;
  close?(): void | Promise<void>;
}

/** Compare only the frozen snapshot; host evidence and timestamps are not part of identity. */
export function sameCameraHistory(entry: WorldCameraHistoryEntry, candidate: WorldCameraHistoryEntry): boolean {
  return stableStringify(entry.snapshot) === stableStringify(candidate.snapshot);
}

export class InMemoryWorldCameraHistoryRepository implements WorldCameraHistoryRepository {
  private readonly entries = new Map<string, WorldCameraHistoryEntry>();

  async insert(entry: WorldCameraHistoryEntry): Promise<WorldCameraHistoryInsertResult> {
    const existing = this.entries.get(entry.completionKey);
    if (existing) {
      return { status: sameCameraHistory(existing, entry) ? "duplicate" : "conflict", entry: existing };
    }
    this.entries.set(entry.completionKey, structuredClone(entry));
    return { status: "inserted", entry };
  }

  async get(canvasId: string, completionKey: string): Promise<WorldCameraHistoryEntry | null> {
    const entry = this.entries.get(completionKey);
    return entry && entry.canvasId === canvasId ? structuredClone(entry) : null;
  }

  async list(canvasId: string, cameraId: string, limit = 50): Promise<WorldCameraHistoryEntry[]> {
    return [...this.entries.values()]
      .filter(entry => entry.canvasId === canvasId && entry.cameraId === cameraId)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.completionKey.localeCompare(left.completionKey))
      .slice(0, Math.max(0, limit))
      .map(entry => structuredClone(entry));
  }
}
