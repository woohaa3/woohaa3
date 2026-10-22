/**
 * 节点生成历史 composition
 * （change: add-canvas-node-generation-history，任务 1.2 / 1.3 / 1.4 / design D1）。
 *
 * 按与画布存储相同的 backend 配置选择历史仓库（sqlite 或测试注入/内存），创建应用服务。
 * 历史使用**独立**表/事务，不触碰画布聚合或 Y.Doc。Mongo 历史 adapter 尚未实现时抛出
 * 明确错误：不做内存回退伪装持久保存。
 *
 * change: 2026-10-08-add-image-focus-editing-and-unified-node-history 追加编辑完成回执
 * repository 与 `EditCompletionService`（同一后端选择）。
 */
import { NodeHistoryApplicationService } from "./core/node-history-service.js";
import type { MediaStorageScope } from "@woohaa3/contracts";
import type { NodeHistoryRepository } from "./core/node-history-contracts.js";
import type { NodeHistoryRoomPort } from "./core/node-history-service.js";
import { InMemoryNodeHistoryRepository } from "./core/in-memory-node-history-repository.js";
import { EditCompletionService } from "./core/edit-completion-service.js";
import type { EditCompletionRepository } from "./core/edit-completion-contracts.js";
import { InMemoryEditCompletionRepository } from "./core/in-memory-edit-completion-repository.js";
import {
  CANVAS_STORAGE_BACKEND_ENV,
  CANVAS_STORAGE_SQLITE_PATH_ENV,
  resolveCanvasStorageConfig,
  type Env
} from "./composition.js";

export type NodeHistoryComposition = {
  service: NodeHistoryApplicationService;
  repository: NodeHistoryRepository;
  /** 编辑完成应用服务（change: 图片聚焦编辑，design D6）。 */
  editCompletion: EditCompletionService;
  editCompletionRepository: EditCompletionRepository;
  close: () => Promise<void>;
};

export type ComposeNodeHistoryOptions = {
  env: Env;
  resolveRoom: (canvasId: string) => Promise<NodeHistoryRoomPort | null>;
  /** 测试注入：跳过动态 import。 */
  repository?: NodeHistoryRepository;
  /** 测试注入：编辑完成回执 repository。 */
  editCompletionRepository?: EditCompletionRepository;
  mediaVerifier?: { exists(storageKey: string, scope?: MediaStorageScope): Promise<boolean> };
  logger?: (event: Record<string, unknown>) => void;
  now?: () => string;
};

export async function composeNodeHistory(options: ComposeNodeHistoryOptions): Promise<NodeHistoryComposition> {
  const repository = options.repository ?? (await createRepository(options.env));
  const editCompletionRepository = options.editCompletionRepository ?? (await createEditCompletionRepository(options.env));
  // 先声明 service（publisher 闭包引用它），再构造 editCompletion：两者互相依赖，
  // 用显式类型标注避免隐式 any 循环推断。
  let service!: NodeHistoryApplicationService;
  const editCompletion: EditCompletionService = new EditCompletionService({
    completions: editCompletionRepository,
    publisher: {
      registerEntry: (entry) => service.registerEntry(entry),
      listEntriesForNode: (canvasId, nodeId) => service.listEntriesForNode(canvasId, nodeId)
    },
    resolveRoom: options.resolveRoom,
    ...(options.mediaVerifier ? { mediaVerifier: options.mediaVerifier } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {})
  });
  service = new NodeHistoryApplicationService({
    repository,
    resolveRoom: options.resolveRoom,
    ...(options.mediaVerifier ? { mediaVerifier: options.mediaVerifier } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    // 清空历史必须拒绝尚未结算的编辑会话：删掉归档义务会让进行中的会话无法完成。
    hasActiveEditSession: (canvasId: string, nodeId: string) => editCompletion.hasActiveModelSession(canvasId, nodeId)
  });
  return {
    service,
    repository,
    editCompletion,
    editCompletionRepository,
    close: async () => {
      const closeable = repository as { close?: () => void | Promise<void> };
      await closeable.close?.();
      const closeableEdit = editCompletionRepository as { close?: () => void | Promise<void> };
      await closeableEdit.close?.();
    }
  };
}

async function createRepository(env: Env): Promise<NodeHistoryRepository> {
  const backend = env[CANVAS_STORAGE_BACKEND_ENV];
  if (backend === undefined) {
    // 未配置持久 backend：测试/纯内存部署使用内存仓库。
    return new InMemoryNodeHistoryRepository();
  }
  const resolved = resolveCanvasStorageConfig(env);
  if (!resolved.ok) throw new Error(`节点历史配置无效：${resolved.reason}`);
  if (resolved.config.backend === "sqlite") {
    const { SqliteNodeHistoryRepository } = await import("./sqlite/node-history.js");
    return new SqliteNodeHistoryRepository({ path: resolved.config.sqlitePath as string });
  }
  throw new Error("Mongo 节点历史 adapter 尚未实现（拒绝回退到内存）");
}

async function createEditCompletionRepository(env: Env): Promise<EditCompletionRepository> {
  const backend = env[CANVAS_STORAGE_BACKEND_ENV];
  if (backend === undefined) return new InMemoryEditCompletionRepository();
  const resolved = resolveCanvasStorageConfig(env);
  if (!resolved.ok) throw new Error(`编辑回执配置无效：${resolved.reason}`);
  if (resolved.config.backend === "sqlite") {
    const { SqliteEditCompletionRepository } = await import("./sqlite/edit-completion.js");
    return new SqliteEditCompletionRepository({ path: resolved.config.sqlitePath as string });
  }
  throw new Error("Mongo 编辑回执 adapter 尚未实现（拒绝回退到内存）");
}

export { CANVAS_STORAGE_SQLITE_PATH_ENV };
