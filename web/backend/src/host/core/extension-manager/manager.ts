/**
 * Extension Manager：与来源无关的安装流水线（change: 2026-10-21-add-extension-marketplace-point，D6–D9）。
 *
 * resolve → download → verify → stage → preflight → commit → reload → observe
 *
 * **唯一提交点**是 `installations.json` 的原子替换（`toolkit.openInstallations().commit`）。之前任何失败
 * 只删除 `staging/<jobId>`，不触碰当前版本；版本目录按 `installed/<id>/<version>` 并存，回滚只切指针。
 *
 * 失败码见 `MARKETPLACE_FAILURE_CODES`；宿主不按扩展 ID 分支（extension-purity）。
 */
import type { MarketplaceListing, MarketplaceSource } from "@woohaa3/contracts";
import { MARKETPLACE_LOCAL_FILE_SOURCE_ID } from "@woohaa3/contracts";
import { ExtensionManagerError } from "./errors.js";
import { installFromFile, installFromSource } from "./install-pipeline.js";
import { handleObservationCrash, observe, recoverOnStartup, rollback, sweep, uninstall } from "./lifecycle.js";
import { createManagerContext } from "./manager-context.js";
import type { ExtensionManager, ExtensionManagerDeps } from "./manager-types.js";
import type { InstallationsHandle, InstallationsState } from "./types.js";

export type {
  ExtensionManager,
  ExtensionManagerDeps,
  FileInstallRequest,
  InstallRequest,
  ManagedInstallView,
  ObservedHealth
} from "./manager-types.js";

/** 核心自带的本地文件来源：只用于登记与列出；字节来自上传，由 `installFromFile` 接收。 */
export function createLocalFileSource(): MarketplaceSource {
  return {
    sourceId: MARKETPLACE_LOCAL_FILE_SOURCE_ID,
    label: "本地文件",
    available: () => ({ ok: true }),
    search: async () => ({ items: [] }),
    resolve: async () => null,
    download: async () => {
      throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", "本地文件来源只接受上传，不能按版本下载");
    }
  };
}

export function createExtensionManager(deps: ExtensionManagerDeps, handle: InstallationsHandle | null): ExtensionManager {
  const ctx = createManagerContext(deps, handle);
  const { board, restartPendingRemoved } = ctx;

  const unregisterLocal = deps.marketplace.resolve(MARKETPLACE_LOCAL_FILE_SOURCE_ID)
    ? () => undefined
    : deps.marketplace.register(createLocalFileSource());

  // ---- 启动恢复 ----
  recoverOnStartup(ctx);

  const manager: ExtensionManager = {
    installFromFile: (request) => installFromFile(ctx, request),
    installFromSource: (request) => installFromSource(ctx, request),
    uninstall: (extensionId, options) => uninstall(ctx, extensionId, options),
    rollback: (extensionId, options) => rollback(ctx, extensionId, options),

    job: (jobId) => board.get(jobId)?.view,
    wait: async (jobId) => board.get(jobId)?.done,
    cancel: (jobId) => {
      const view = board.cancel(jobId);
      return view;
    },

    async search(query, signal) {
      const items: MarketplaceListing[] = [];
      const unavailable: Array<{ sourceId: string; reason: string }> = [];
      let nextCursor: string | undefined;
      const sources = deps.marketplace.list().filter((source) => !query.sourceId || source.sourceId === query.sourceId);
      const controller = new AbortController();
      if (signal) signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
      await Promise.all(
        sources.map(async (source) => {
          const availability = source.available();
          if (!availability.ok) {
            unavailable.push({ sourceId: source.sourceId, reason: availability.reason });
            return;
          }
          try {
            const page = await source.search({ ...(query.text ? { text: query.text } : {}), ...(query.cursor ? { cursor: query.cursor } : {}), ...(query.limit ? { limit: query.limit } : {}) }, controller.signal);
            items.push(...page.items);
            if (query.sourceId && page.nextCursor) nextCursor = page.nextCursor;
          } catch (error) {
            unavailable.push({ sourceId: source.sourceId, reason: error instanceof Error ? error.message : String(error) });
          }
        })
      );
      // 来源列表（不含 local-file）供设置面选择来源；与可用性同一份判定。
      const sourcesView = deps.marketplace
        .list()
        .filter((source) => source.sourceId !== MARKETPLACE_LOCAL_FILE_SOURCE_ID)
        .map((source) => {
          const availability = source.available();
          return { sourceId: source.sourceId, label: source.label, ok: availability.ok, ...(availability.ok ? {} : { reason: availability.reason }) };
        });
      return { items, ...(nextCursor ? { nextCursor } : {}), unavailable, sources: sourcesView };
    },

    requestRestart(actor) {
      if (!deps.restart || !deps.restart.supported()) {
        throw new ExtensionManagerError("MARKETPLACE_RESTART_UNSUPPORTED", "当前宿主进程不支持受控重启；请手动重启本机服务");
      }
      deps.restart.request({ reason: "extension-install", actor });
    },

    installed() {
      if (!handle) return [];
      let state: InstallationsState;
      try {
        state = handle.read();
      } catch {
        return [];
      }
      return Object.entries(state.extensions).map(([extensionId, record]) => ({
        extensionId,
        version: record.current,
        ...(record.previous ? { previousVersion: record.previous } : {}),
        sourceId: record.sourceId,
        ...(record.trust ? { trust: record.trust } : {}),
        ...(record.quarantine ? { quarantine: record.quarantine } : {}),
        restartRequired: record.restartPending === true,
        ...(record.observeUntil ? { observeUntil: record.observeUntil } : {}),
        directory: handle.layout.versionDir(extensionId, record.current)
      }));
    },

    view() {
      let revision = 0;
      try {
        revision = handle ? handle.read().revision : 0;
      } catch {
        revision = 0;
      }
      return {
        revision,
        jobs: board.list(),
        restartSupported: deps.restart?.supported() === true
      };
    },

    observe: () => observe(ctx),
    handleObservationCrash: (extensionId) => handleObservationCrash(ctx, extensionId),
    sweep: () => sweep(ctx),

    close() {
      if (ctx.status.closed) return;
      ctx.status.closed = true;
      for (const view of board.list()) if (view.status === "running") board.cancel(view.jobId);
      unregisterLocal();
      handle?.release();
    }
  };
  // 卸载含后端扩展后的「需要重启」提示：installed() 不含已删除记录，交给设置投影单独读取。
  return Object.assign(manager, { restartPendingRemoved: () => [...restartPendingRemoved] });
}
