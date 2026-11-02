/**
 * World-camera history composition (T08).
 *
 * Mirrors the node-history backend selection: an explicitly configured SQLite
 * path persists across restarts; a missing backend may use the in-memory
 * repository for tests/embedded use. Mongo is rejected instead of silently
 * degrading to a non-durable store.
 */
import type { WorldCameraHistoryRepository } from "../world-authoring/camera-history.js";
import { InMemoryWorldCameraHistoryRepository } from "../world-authoring/camera-history.js";
import {
  CANVAS_STORAGE_BACKEND_ENV,
  resolveCanvasStorageConfig,
  type CanvasStorageConfig,
  type Env
} from "./composition.js";

export type WorldCameraHistoryComposition = {
  repository: WorldCameraHistoryRepository;
  close: () => Promise<void>;
};

export type ComposeWorldCameraHistoryOptions = {
  env: Env;
  storageConfig?: CanvasStorageConfig;
  /** Test/embedded injection; skips dynamic import. */
  repository?: WorldCameraHistoryRepository;
  now?: () => string;
};

export async function composeWorldCameraHistory(
  options: ComposeWorldCameraHistoryOptions
): Promise<WorldCameraHistoryComposition> {
  if (options.repository) {
    return {
      repository: options.repository,
      close: async () => undefined
    };
  }
  const repository = await createRepository(options);
  return {
    repository,
    close: async () => {
      await repository.close?.();
    }
  };
}

async function createRepository(options: ComposeWorldCameraHistoryOptions): Promise<WorldCameraHistoryRepository> {
  const config = options.storageConfig ?? resolvedConfig(options.env);
  if (!config) return new InMemoryWorldCameraHistoryRepository();
  if (config.backend === "sqlite") {
    const { SqliteWorldCameraHistoryRepository } = await import("./sqlite/world-camera-history.js");
    return new SqliteWorldCameraHistoryRepository({
      path: config.sqlitePath as string,
      ...(options.now ? { now: options.now } : {})
    });
  }
  throw new Error("Mongo 世界镜头历史 adapter 尚未实现（拒绝回退到内存）");
}

function resolvedConfig(env: Env): CanvasStorageConfig | null {
  if (env[CANVAS_STORAGE_BACKEND_ENV] === undefined) return null;
  const resolved = resolveCanvasStorageConfig(env);
  if (!resolved.ok) throw new Error(`世界镜头历史配置无效：${resolved.reason}`);
  return resolved.config;
}
