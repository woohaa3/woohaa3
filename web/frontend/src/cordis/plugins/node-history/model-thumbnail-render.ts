/**
 * 页面内模型历史缩略图渲染器
 * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
 *
 * 流程：受保护的条目详情 → 版本化脚本执行（与聚焦预览同一执行器）→ 规范化 Scene IR →
 * 同一 Bevy App 内一次性离屏渲染 → RGBA 回读 → PNG。渲染不出就返回失败码，卡片显示可重试
 * 失败态；不请求服务端 PNG，也没有备用渲染路径。
 *
 * 缓存键与既有服务端规则一致（sourceHash + sceneVersion + renderVersion + capture options），
 * 只是改由页面内存持有；一次成功渲染的 Blob 在同一页面生命周期内复用。
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  executeModelScriptVersioned,
  isSupportedModelScriptVersion,
  sceneIrVersionFor,
  type NodeHistoryPreviewEntry
} from "@woohaa3/contracts";
import { createRemoteClient } from "./history-adapters.js";
import { acquireCaptureLock, rgbaToPngBlob } from "../canvas-runtime/model-capture-shared.js";

export type ModelThumbnailRender =
  | { ok: true; blob: Blob }
  | { ok: false; code: string };

export type ModelThumbnailRenderer = (entry: NodeHistoryPreviewEntry) => Promise<ModelThumbnailRender>;

/** 页面内缩略图缓存上限（条目数）；历史卡片一屏远小于它。 */
const MAX_CACHE_ENTRIES = 48;

/** 进程内单调的缩略图作用域代数：切画布/关闭后旧结果按它丢弃。 */
let thumbnailGeneration = 0;

export function createModelThumbnailRenderer(ctx: Context): ModelThumbnailRenderer {
  const client = createRemoteClient(ctx);
  const cache = new Map<string, Blob>();
  const inflight = new Map<string, Promise<ModelThumbnailRender>>();

  const remember = (key: string, blob: Blob): void => {
    cache.delete(key);
    cache.set(key, blob);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return async (entry) => {
    const identity = `${entry.canvasId}\u0000${entry.nodeId}\u0000${entry.entryId}`;
    const cached = cache.get(identity);
    if (cached) {
      // 命中：刷新 LRU 顺序后直接复用。
      remember(identity, cached);
      return { ok: true, blob: cached };
    }
    const running = inflight.get(identity);
    if (running) return running;
    const task = render(ctx, client, identity, entry, remember);
    inflight.set(identity, task);
    try {
      return await task;
    } finally {
      inflight.delete(identity);
    }
  };
}

async function render(
  ctx: Context,
  client: ReturnType<typeof createRemoteClient>,
  identity: string,
  entry: NodeHistoryPreviewEntry,
  remember: (key: string, blob: Blob) => void
): Promise<ModelThumbnailRender> {
  const detail = await client.detail(entry);
  if (!detail.ok) return { ok: false, code: detail.code || "detail-unavailable" };
  const model = detail.detail;
  if (model.kind !== "model") return { ok: false, code: "not-a-model-entry" };
  if (!isSupportedModelScriptVersion(model.version)) return { ok: false, code: "unsupported-model-version" };
  if (!model.modelScript.trim()) return { ok: false, code: "no-source" };
  // 与聚焦预览同一执行器：脚本来自服务端权威版本记录，本地只派生渲染输入。
  const execution = executeModelScriptVersioned(model.modelScript, model.version);
  if (!execution.ok) return { ok: false, code: `model-script-${execution.code}` };
  const ops = execution.scene.ops as readonly unknown[];
  if (ops.length === 0) return { ok: false, code: "no-source" };

  const runtime = ctx.canvasRuntime.runtime();
  if (!runtime?.requestHistoryThumbnail) return { ok: false, code: "renderer-unavailable" };

  // 与镜头截图共用 latest-wins 回读通道：必须串行。
  const release = await acquireCaptureLock();
  try {
    thumbnailGeneration += 1;
    const frame = await runtime.requestHistoryThumbnail({
      generation: thumbnailGeneration,
      sceneVersion: sceneIrVersionFor(model.version),
      ops
    });
    if (!frame) return { ok: false, code: "renderer-unavailable" };
    if (!frame.ok) return { ok: false, code: frame.code };
    const blob = await rgbaToPngBlob(frame.rgba, frame.width, frame.height);
    if (!blob) return { ok: false, code: "thumbnail-encode-failed" };
    remember(identity, blob);
    return { ok: true, blob };
  } catch {
    return { ok: false, code: "thumbnail-render-failed" };
  } finally {
    release();
  }
}
