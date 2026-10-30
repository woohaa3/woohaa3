/**
 * 节点正文/纹理/placement 读取（自 `render-scene.ts` 拆出）
 * （change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R01）。
 *
 * 从 renderer-neutral `nodeData` 读取卡片正文、纹理键与模型 placement 的纯函数；
 * 不含领域写入，也不缓存任何状态。
 */
import type { CanvasNodeData, StoredAsset } from "../domain/index.js";
import type { BevyModelPlacement } from "./wire-model.js";

const FAILURE_BODY_LABELS = {
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  partial: "部分成功"
} as const;

/**
 * 正文摘要（不含作品名称，名称由 `title` 单独承载）。文本结果只读就绪文本资产；缺失/未就绪的
 * `outputAssetId` **不回落** prompt。
 */
export function readBody(type: string, data: CanvasNodeData | undefined, assets: Map<string, StoredAsset>): string {
  if (!data) return "";
  // 浏览器本地历史预览选中失败/取消归档时，卡片正文显示安全原因，而不是上一个成功输出。
  const failure = data.historyPreviewFailure;
  if (failure && typeof failure.message === "string" && failure.message.trim() !== "") {
    const label = FAILURE_BODY_LABELS[failure.outcome] ?? FAILURE_BODY_LABELS.failed;
    return truncate(`${label}：${failure.message}`, 240);
  }
  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  if (outputId !== "") {
    const asset = assets.get(outputId);
    if (asset && asset.status === "ready" && asset.mediaKind === "text" && typeof asset.text === "string") {
      return truncate(asset.text, 240);
    }
    return "";
  }
  if (type === "text") {
    const prompt = typeof data.prompt === "string" ? data.prompt : "";
    const result = typeof data.result?.text === "string" ? data.result.text : "";
    return truncate(result || prompt, 240);
  }
  // 便签没有生成产物：正文就是用户写的字，直接读 `note`。
  if (type === "sticky-note") {
    return truncate(typeof data.note === "string" ? data.note : "", 240);
  }
  return "";
}

export function resolveTextureKey(
  type: string,
  data: CanvasNodeData | undefined,
  assets: Map<string, StoredAsset>
): string | null {
  if (!data) return null;
  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  if (outputId === "") return null;
  const asset = assets.get(outputId);
  if (!asset || asset.status !== "ready") return null;
  if (type === "image" && asset.mediaKind === "image") return asset.id;
  if (type === "video" && asset.mediaKind === "video") return asset.id;
  return null;
}

/** 读取参考格式的 modelPlacement（renderer-neutral nodeData）。 */
export function readPlacement(data: CanvasNodeData | undefined): BevyModelPlacement | null {
  const placement = data?.modelPlacement as Record<string, unknown> | undefined;
  if (!placement || typeof placement !== "object") return null;
  const offset = (placement.offset as Record<string, unknown> | undefined) ?? {};
  return {
    offset: {
      x: finite(offset.x) ?? 0,
      y: finite(offset.y) ?? 0,
      z: finite(offset.z) ?? 0
    },
    scale: finite(placement.scale) ?? 1,
    yaw: finite(placement.yaw) ?? 0
  };
}

export function finite(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

export function clampProgress(progress: number | undefined): number {
  if (typeof progress !== "number" || !Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, progress));
}

export function isBusy(data: CanvasNodeData | undefined): boolean {
  const status = data?.taskStatus ?? data?.status;
  return status === "pending" || status === "queued" || status === "processing" || status === "running";
}

export function truncate(text: string, max: number): string {
  const value = text.trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
