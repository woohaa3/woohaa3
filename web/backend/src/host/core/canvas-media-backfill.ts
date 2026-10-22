/**
 * 画布媒体补传：把属于远端的画布**存量**媒体字节对齐到服务端托管存储，并维护同步状态。
 *
 * 为什么需要它：画布文档只带稳定 storageKey，字节在新写入时会直接按画布路由写到远端存储；
 * 但在「先本地生成、后启用远端同步」的顺序下，旧对象还在主存储里，第二台设备/协作者按画布
 * 路由去远端读会 404。这里在链路建立或用户显式「同步远端」时按画布枚举文档里引用的存储键，
 * 幂等地补一份到远端。
 *
 * 状态也是产物：文档链路 `synced` 只代表文档到位，媒体可能还在补传。目录徽标通过
 * `stateOf` 把这段时间表达成 `syncing`，补传失败表达成 `failed`，而不是提前说「已同步」。
 *
 * 边界：
 * - 覆盖画布文档里**所有**稳定键：
 *   `assets` 只是其中一处，图片编辑的工程对象（`nodeData` 里的 `imageEdit.project`）等引用
 *   根本不出现在 `assets` 里，按字段位置枚举必然漏；这里统一按「字符串是不是合法稳定键」
 *   判定（身份由键本身决定）。节点历史是本地 SQLite 的独立资产，不在此处补传
 *   （历史面板打开时走读时回填）。
 * - 每轮按画布去重（同一画布同时只跑一轮），显式调用可 `force` 重跑一次对账。
 * - 失败只记日志与状态，绝不阻断同步：丢的对象仍可由读时回填补齐。
 */
import type { CanvasMediaAssetSyncPort, CanvasMediaAssetSyncState } from "@woohaa3/canvas-service";
import { isValidStorageKey, type ServerCanvas } from "@woohaa3/contracts";
import type { HostContext } from "../context.js";

/** 遍历上限：画布文档本身有大小上限，这里只防病态数据把一轮补传拖死。 */
const MAX_NODES = 200_000;

/**
 * 画布文档里所有稳定媒体键（当前产物 + 海报 + 复合内容资产 + nodeData 里引用的工程对象）。
 *
 * 为什么按「值」而不是按「字段」扫：稳定键的身份由键本身决定（`isValidStorageKey`），
 * 而引用它的位置会随功能增加而变（`assets[].metadata.storageKey`、`nodeData.imageEdit.project`、
 * 录制产物……）。按字段枚举每加一个功能就要补一次，漏一次就是协作者打开时 404；
 * 按值扫一遍则与功能解耦，新增引用自动被覆盖。
 */
export function collectCanvasMediaKeys(canvas: ServerCanvas): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<unknown>();
  const stack: unknown[] = [canvas];
  while (stack.length > 0 && seen.size <= MAX_NODES) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (isValidStorageKey(value)) keys.add(value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    for (const item of Object.values(value as Record<string, unknown>)) stack.push(item);
  }
  return keys;
}

/**
 * 构造补传端口。`loadCanvas` 由调用方提供（画布服务在构造期尚不可用，必须延迟取）。
 *
 * 返回的 `run` 是 fire-and-forget：目录徽标通过 `stateOf` 观察进度，调用方不需要 await。
 */
export function createCanvasMediaBackfill(
  ctx: HostContext,
  loadCanvas: (canvasId: string) => Promise<ServerCanvas>
): CanvasMediaAssetSyncPort {
  const log = ctx.log.scope("canvas-media");
  const states = new Map<string, CanvasMediaAssetSyncState>();
  const running = new Set<string>();
  /** 显式 force 撞上正在跑的一轮时排队重跑：用户点「同步远端」必须真的对账一次。 */
  const rerun = new Set<string>();

  const setState = (canvasId: string, next: Omit<CanvasMediaAssetSyncState, "updatedAt">) => {
    states.set(canvasId, { ...next, updatedAt: Date.now() });
  };

  const run: CanvasMediaAssetSyncPort["run"] = (canvasId, options = {}) => {
    if (running.has(canvasId)) {
      if (options.force) rerun.add(canvasId);
      return;
    }
    const storage = ctx.get("storage");
    const target = storage?.resolve("server");
    // 没接远端托管存储时什么都不做：媒体继续留在主存储，与旧行为一致。
    if (!storage || !target) return;
    const sourceId = storage.primaryId();
    if (sourceId === target.backendId) return;
    running.add(canvasId);
    setState(canvasId, { state: "syncing", total: 0, copied: 0, missing: 0, failed: 0 });
    void (async () => {
      try {
        const canvas = await loadCanvas(canvasId).catch(() => null);
        if (!canvas) {
          // 画布还没装载：撤掉「同步中」，目录回落文档状态；下次链路/打开画布再跑。
          states.delete(canvasId);
          return;
        }
        const keys = collectCanvasMediaKeys(canvas);
        setState(canvasId, { state: "syncing", total: keys.size, copied: 0, missing: 0, failed: 0 });
        let copied = 0;
        let missing = 0;
        let failed = 0;
        for (const key of keys) {
          try {
            const written = await storage.replicate("media", key, {
              targetBackendId: target.backendId,
              scope: { canvasId },
              sourceBackendId: sourceId
            });
            if (written) copied += 1;
          } catch (error) {
            const code = typeof (error as { code?: unknown })?.code === "string"
              ? (error as { code: string }).code
              : error instanceof Error ? error.name : "unknown";
            if (code === "MediaObjectNotFoundError" || code === "StorageObjectNotFoundError") missing += 1;
            else {
              failed += 1;
              log({ event: "canvas-media-backfill-failed", canvasId, code });
            }
          }
        }
        setState(canvasId, {
          state: failed > 0 ? "failed" : "synced",
          total: keys.size,
          copied,
          missing,
          failed
        });
        log({ event: "canvas-media-backfill", canvasId, total: keys.size, copied, missing, failed, forced: options.force === true });
      } finally {
        running.delete(canvasId);
        if (rerun.delete(canvasId)) run(canvasId, { force: true });
      }
    })().catch(() => undefined);
  };

  return { run, stateOf: (canvasId) => states.get(canvasId) };
}
