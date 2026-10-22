/**
 * 提示词片段目录 composition
 * （change: add-prompt-snippet-library，任务 1.2/1.5 / design D1）。
 *
 * 按与画布存储相同的 backend 配置选择片段仓库（sqlite 或测试注入的内存仓库），
 * 创建应用服务并幂等 seed 内置片段。目录使用**独立**表/事务，不触碰画布聚合或 Y.Doc。
 *
 * Mongo 片段 adapter 尚未实现时抛出明确错误：不做内存回退伪装持久保存（spec「目录存储
 * 不可用」），调用方据此把片段面标为 NOT_READY，而画布核心继续工作。
 */
import type { PromptSnippetApplicationService } from "./core/snippet-service.js";
import { PromptSnippetApplicationService as Service } from "./core/snippet-service.js";
import type { SnippetRepository } from "./core/snippet-contracts.js";
import { InMemorySnippetRepository } from "./core/in-memory-snippet-repository.js";
import {
  CANVAS_STORAGE_BACKEND_ENV,
  CANVAS_STORAGE_SQLITE_PATH_ENV,
  resolveCanvasStorageConfig,
  type Env
} from "./composition.js";

export type SnippetComposition = {
  service: PromptSnippetApplicationService;
  repository: SnippetRepository;
  close: () => Promise<void>;
};

export type ComposeSnippetOptions = {
  env: Env;
  /** 测试注入：跳过动态 import。 */
  repository?: SnippetRepository;
  now?: () => string;
  generateId?: (prefix: string) => string;
};

export async function composeSnippets(options: ComposeSnippetOptions = { env: process.env }): Promise<SnippetComposition> {
  const repository = options.repository ?? (await createRepository(options.env));
  const service = new Service({
    repository,
    ...(options.now ? { now: options.now } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {})
  });
  await service.seedBuiltIns();
  return {
    service,
    repository,
    close: async () => {
      const closeable = repository as { close?: () => void | Promise<void> };
      await closeable.close?.();
    }
  };
}

async function createRepository(env: Env): Promise<SnippetRepository> {
  const backend = env[CANVAS_STORAGE_BACKEND_ENV];
  if (backend === undefined) {
    // 未配置持久 backend：测试/纯内存部署使用内存仓库（不伪装为持久目录）。
    return new InMemorySnippetRepository();
  }
  const resolved = resolveCanvasStorageConfig(env);
  if (!resolved.ok) throw new Error(`片段目录配置无效：${resolved.reason}`);
  if (resolved.config.backend === "sqlite") {
    const { SqliteSnippetRepository } = await import("./sqlite/snippets.js");
    return new SqliteSnippetRepository({ path: resolved.config.sqlitePath as string });
  }
  throw new Error("Mongo 片段目录 adapter 尚未实现（拒绝回退到内存）");
}

export { CANVAS_STORAGE_SQLITE_PATH_ENV };
