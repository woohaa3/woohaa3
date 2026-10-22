/**
 * Canvas Service composition：在线迁移装配
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.7、5.1 / design D6、D11）。
 *
 * 从 `composition.ts` 抽出，保持组合根文件聚焦生命周期编排。只在**注入受控来源端口**且目标
 * 后端为 SQLite 时挂载：导入 store 复用目标 SQLite 文件，用独立连接做单事务原子导入；提交后
 * 销毁旧 room，让下次连接从已提交权威重新加载。
 *
 * 主体只来自宿主认证适配器（`resolveSubject`）；缺省拒绝，绝不信任客户端自报 staffId/ownerId。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasStorageComposition } from "../storage/composition.js";
import type { SyncUpgradeHandler } from "../sync/upgrade.js";
import type { CanvasMediaClient } from "../clients/media-client.js";
import { createMediaVerifierStorage } from "../clients/media-verifier.js";
import { resolveCanvasStorageConfig } from "../storage/composition.js";
import type { CanvasSourcePort } from "../import/contracts.js";
import { CanvasImportService } from "../import/service.js";
import { SqliteCanvasImportStore } from "../storage/sqlite/canvas-import.js";
import { createCanvasPreparationRoutes } from "../api/canvas-preparation-api.js";
import type { CanvasImportGuard } from "../api/canvas-api/types.js";

export type ComposeOnlineMigrationInput = {
  env: Record<string, string | undefined>;
  canvasSources: CanvasSourcePort | undefined;
  canvasImportStore: SqliteCanvasImportStore | undefined;
  canvasSubjectResolver: ((req: IncomingMessage) => Promise<string | null>) | undefined;
  composition: CanvasStorageComposition | null;
  mediaClient: CanvasMediaClient | undefined;
  sync: SyncUpgradeHandler | null;
  now: (() => string) | undefined;
  log: (event: Record<string, unknown>) => void;
};

export type OnlineMigrationComposition = {
  preparationHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) | null;
  importService: CanvasImportService | null;
  importStore: SqliteCanvasImportStore | null;
  importGuard: CanvasImportGuard | undefined;
};

export function composeOnlineMigration(input: ComposeOnlineMigrationInput): OnlineMigrationComposition {
  const empty: OnlineMigrationComposition = { preparationHandler: null, importService: null, importStore: null, importGuard: undefined };
  if (!input.canvasSources || !input.composition || !input.mediaClient) return empty;
  const resolved = resolveCanvasStorageConfig(input.env);
  if (!resolved.ok || resolved.config.backend !== "sqlite") return empty;
  try {
    const importStore = input.canvasImportStore ?? new SqliteCanvasImportStore({
      path: resolved.config.sqlitePath as string,
      ...(input.now ? { now: input.now } : {})
    });
    importStore.recoverInterruptedJobs();
    const importService = new CanvasImportService({
      sources: input.canvasSources,
      store: importStore,
      mediaStorage: createMediaVerifierStorage({ client: input.mediaClient }),
      ...(input.now ? { now: input.now } : {}),
      onCommitted: async ({ canvasId }) => {
        // 提交后发布：销毁旧 room，让下次连接从已提交权威重新加载。
        await input.sync?.registry.destroy(canvasId);
      },
      onDeleted: async ({ canvasId }) => {
        // 删除后失效 room（内存态不残留已删作品）。
        await input.sync?.registry.destroy(canvasId);
      },
      logger: input.log
    });
    const preparationHandler = createCanvasPreparationRoutes({
      importService,
      // 主体来自宿主认证；缺省拒绝（绝不信任客户端自报 staffId/ownerId）。
      resolveSubject: input.canvasSubjectResolver ?? (async () => null),
      maxBodyBytes: 12 * 1024 * 1024,
      log: (event) =>
        input.log({ event: event.event, status: event.status, ...(event.code ? { code: event.code } : {}) })
    });
    const importGuard: CanvasImportGuard = {
      state: (canvasId) => importService.guardState(canvasId),
      deleteImported: async (canvasId) => { importService.deleteImported(canvasId); },
      // 主体来自宿主认证适配器；未认证返回 null，导入画布因此 fail-closed（native 不受影响）。
      subject: (req) => (input.canvasSubjectResolver ? input.canvasSubjectResolver(req) : Promise.resolve(null)),
      authorize: (query) => importService.authorize(query)
    };
    return { preparationHandler, importService, importStore, importGuard };
  } catch (error) {
    input.log({ event: "canvas-import-compose-failed", message: error instanceof Error ? error.message : "unknown" });
    return empty;
  }
}
