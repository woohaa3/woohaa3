/**
 * Trusted host-completion fact composition (T11a).
 *
 * Mirrors the world-camera history backend selection so both sides resolve to
 * the same durable deployment store. A missing storage backend may use the
 * in-memory repository for tests/embedded use; Mongo is rejected rather than
 * silently degrading.
 */
import {
  InMemoryAssistantHostCompletionRepository,
  type AssistantHostCompletionRepository
} from "../world-authoring/host-completions.js";
import {
  CANVAS_STORAGE_BACKEND_ENV,
  resolveCanvasStorageConfig,
  type CanvasStorageConfig,
  type Env
} from "./composition.js";

export type AssistantHostCompletionComposition = {
  repository: AssistantHostCompletionRepository;
  close: () => Promise<void>;
};

export type ComposeAssistantHostCompletionOptions = {
  env: Env;
  storageConfig?: CanvasStorageConfig;
  /** Test/embedded injection; skips dynamic import. */
  repository?: AssistantHostCompletionRepository;
  now?: () => string;
};

export async function composeAssistantHostCompletions(
  options: ComposeAssistantHostCompletionOptions
): Promise<AssistantHostCompletionComposition> {
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

async function createRepository(options: ComposeAssistantHostCompletionOptions): Promise<AssistantHostCompletionRepository> {
  const config = options.storageConfig ?? resolvedConfig(options.env);
  if (!config) return new InMemoryAssistantHostCompletionRepository();
  if (config.backend === "sqlite") {
    const { SqliteAssistantHostCompletionRepository } = await import("./sqlite/host-completions.js");
    return new SqliteAssistantHostCompletionRepository({
      path: config.sqlitePath as string,
      ...(options.now ? { now: options.now } : {})
    });
  }
  throw new Error("Mongo 助手完成事实 adapter 尚未实现（拒绝回退到内存）");
}

function resolvedConfig(env: Env): CanvasStorageConfig | null {
  if (env[CANVAS_STORAGE_BACKEND_ENV] === undefined) return null;
  const resolved = resolveCanvasStorageConfig(env);
  if (!resolved.ok) throw new Error(`助手完成事实配置无效：${resolved.reason}`);
  return resolved.config;
}
