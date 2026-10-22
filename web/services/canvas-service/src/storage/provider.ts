import type { CanvasRepository } from "./core/contracts.js";
import type { NodeHistoryRepository } from "./core/node-history-contracts.js";
import type { EditCompletionRepository } from "./core/edit-completion-contracts.js";
import type { SnippetRepository } from "./core/snippet-contracts.js";
import type { YjsDocumentRepository } from "../sync/yjs-repository.js";
import type { CanvasWriterLock } from "../sync/writer-lock.js";
import type { CanvasStorageConfig } from "./composition.js";

/**
 * 一组匹配的画布存储实现（change: 2026-10-13-add-enterprise-access-and-production-deployment）。
 *
 * 由 bootstrap `storage` 槽位（扩展目录的 storage provider）创建并持有连接；画布领域服务
 * **只借用**句柄，`close` 不释放槽位资源（宿主在进程退出时统一释放，见 backend 的 `borrow`）。
 */
export type CanvasStorageUnit = {
  repository: CanvasRepository;
  yjsRepository: YjsDocumentRepository;
  writerLock: CanvasWriterLock;
  nodeHistoryRepository?: NodeHistoryRepository;
  editCompletionRepository?: EditCompletionRepository;
  snippetRepository?: SnippetRepository;
  /**
   * 存储实现解析出的配置（部署侧扩展配置文件 + 环境变量的结果）。
   *
   * 宿主把它交给画布服务组合：核心服务不再自己读 `MONGODB_URI`/`MONGODB_DB`，
   * 避免「槽位连上了、API 却因缺环境变量而不可用」这类分叉。
   */
  storageConfig?: CanvasStorageConfig;
};
