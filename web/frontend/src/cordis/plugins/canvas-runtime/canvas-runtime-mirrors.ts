/**
 * Canvas Runtime E2E/排障镜像（生产无副作用）
 * （从 `host.ts` 抽出以保持文件体积守卫；change: 2026-10-08-integrate-render-performance-and-model-preview）。
 *
 * 只把运行时观测投影挂到 `globalThis.__canvas*`，供 Playwright/诊断读取；不写规范状态。
 */
import { parameterPreviewStore } from "../../services/parameter-preview.js";

/** 挂载视频会话/模型聚焦/图片聚焦/放置预览的只读镜像。 */
export function installCanvasRuntimeMirrors(input: {
  compositeAssetMediaSessions?: { diagnostics?: () => unknown };
  videoSessions: { activeNodeIds: () => readonly string[]; playingNodeId: () => string | null; hasRealFrame: (nodeId: string) => boolean };
  modelFocus: () => unknown;
  imageFocus: () => { nodeId: string } | null;
  videoFocus: () => { nodeId: string } | null;
  videoFocusTargetId: () => string | null;
  /**
   * 页面级资源协调器诊断（change: 2026-10-23-scale-canvas-media-residency，任务 1.3）。
   *
   * 只暴露计数与估算（队列等待/执行、reservation、CPU/GPU 估算），不暴露内容；GPU 字节是
   * 保守估算，不是驱动实测显存。
   */
  residency?: { diagnostics?: () => unknown } | null;
  overviewCache?: { diagnostics: () => unknown; setBenchmarkDisabled: (disabled: boolean) => void } | null;
}): void {
  const target = globalThis as unknown as {
    __canvasVideoSessions?: unknown;
    __compositeAssetMedia?: unknown;
    __canvasModelFocus?: unknown;
    __canvasModelPlacement?: unknown;
    __canvasImageFocus?: unknown;
    __canvasVideoFocus?: unknown;
    __canvasResidency?: unknown;
    __canvasOverviewCache?: unknown;
  };
  target.__canvasResidency = { snapshot: () => input.residency?.diagnostics?.() ?? null };
  target.__canvasOverviewCache = {
    snapshot: () => input.overviewCache?.diagnostics() ?? null,
    setBenchmarkDisabled: (disabled: boolean) => input.overviewCache?.setBenchmarkDisabled(disabled === true)
  };
  target.__compositeAssetMedia = { snapshot: () => input.compositeAssetMediaSessions?.diagnostics?.() ?? [] };
  target.__canvasVideoSessions = {
    active: () => input.videoSessions.activeNodeIds(),
    playing: () => input.videoSessions.playingNodeId(),
    hasRealFrame: (nodeId: string) => input.videoSessions.hasRealFrame(nodeId)
  };
  // E2E/排障镜像：观察模型聚焦投影（生产无副作用）。
  target.__canvasModelFocus = {
    projection: () => input.modelFocus(),
    nodeId: () => (input.modelFocus() as { nodeId?: string } | null)?.nodeId ?? null,
    focused: () => input.modelFocus() !== null
  };
  // E2E/排障镜像：观察图片聚焦投影（生产无副作用）。
  target.__canvasImageFocus = {
    projection: () => input.imageFocus(),
    nodeId: () => input.imageFocus()?.nodeId ?? null,
    focused: () => input.imageFocus() !== null
  };
  // E2E/排障镜像：观察视频聚焦投影（生产无副作用；change: 2026-10-10-add-video-node-focus-workspace）。
  target.__canvasVideoFocus = {
    projection: () => input.videoFocus(),
    nodeId: () => input.videoFocusTargetId() ?? input.videoFocus()?.nodeId ?? null,
    focused: () => input.videoFocusTargetId() !== null
  };
  // E2E/排障镜像：观察放置预览（生产无副作用；change: add-model-focus-editing）。
  target.__canvasModelPlacement = {
    preview: (nodeId: string) => parameterPreviewStore.get(nodeId)?.modelPlacement ?? null
  };
}
