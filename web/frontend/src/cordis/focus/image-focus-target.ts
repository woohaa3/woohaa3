/**
 * 图片聚焦目标的宿主默认解析
 * （change: default-image-focus-viewer）。
 *
 * 图片聚焦的**目标合法性**不能只由图片编辑器扩展提供：编辑器未安装/未启用时，
 * `setImageFocusTargets` 从未被调用，导航层会把每一次图片双击都判成 `focus-target-invalid`
 * （「聚焦目标不可用」）。本模块给出与视频聚焦同构的 canonical 判定，供宿主兜底：
 *
 *   1. 节点存在且 `type === "image"`；
 *   2. `nodeData[nodeId].outputAssetId` 指向一个资产；
 *   3. 该资产 `status === "ready"` 且 `mediaKind === "image"`；
 *   4. 资产有受控的同源媒体地址（`/api/media/...`）。
 *
 * 纯函数、只读调用方传入的 canonical 画布；不 import 任何插件实现、不写状态。
 */
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { hasReadyMediaAsset } from "@woohaa3/contracts";
import { resolveCanonicalMediaUrl } from "../services/media-remote.js";

export type ImageFocusTarget = {
  canvas: ServerCanvas;
  nodeId: string;
  asset: StoredAsset;
  /** 受控同源媒体地址（已加挂载前缀）。 */
  url: string;
};

/**
 * 解析可聚焦的图片目标（canonical ready 图片自身输出）；不可用返回 null。
 *
 * 与图片编辑器扩展的判定等价，因此两者同时存在时不会对同一节点给出相反结论。
 */
export function resolveImageFocusTarget(canvas: ServerCanvas | null, nodeId: string): ImageFocusTarget | null {
  if (!canvas) return null;
  const node = canvas.document.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.type !== "image") return null;
  const data = canvas.nodeData[nodeId] as { outputAssetId?: unknown } | undefined;
  const outputId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return null;
  const asset = canvas.assets.find((candidate) => candidate.id === outputId);
  if (!asset || !hasReadyMediaAsset(asset) || asset.mediaKind !== "image") return null;
  // 路径回溯在编辑扩展侧被明确拒绝；宿主兜底不能比它更宽松，否则会放行一个编辑器打不开的目标。
  if (typeof asset.url === "string" && asset.url.includes("..")) return null;
  const url = resolveCanonicalMediaUrl(asset, canvas.id);
  if (!url) return null;
  return { canvas, nodeId, asset, url };
}

/** 当前画布上所有可聚焦图片节点 id（保持节点顺序）。 */
export function imageFocusTargetIds(canvas: ServerCanvas | null): string[] {
  if (!canvas) return [];
  return canvas.document.nodes
    .filter((node) => node.type === "image")
    .filter((node) => resolveImageFocusTarget(canvas, node.id) !== null)
    .map((node) => node.id);
}

/** 该节点是否可作为图片聚焦目标（导航 preflight 的宿主兜底判定）。 */
export function isImageFocusTarget(canvas: ServerCanvas | null, nodeId: string): boolean {
  return resolveImageFocusTarget(canvas, nodeId) !== null;
}

/**
 * 导航 preflight 的图片目标判定：**扩展注册的目标集合优先**，缺席时回落到 canonical 判定。
 *
 * 图片编辑器扩展在挂载期间把可聚焦节点推给 `canvasRuntime`（`setImageFocusTargets`）；
 * 它们未安装/未启用时集合恒为空。旧实现直接采信空集合，于是**任何**图片双击都被判成
 * `focus-target-invalid`（「聚焦目标不可用」）。编辑器从内置插件迁到市场扩展后，空集合成了
 * 常态，所以宿主必须自带兜底（change: default-image-focus-viewer）。
 *
 * 两个来源对同一节点要求同一组 canonical 条件（ready 图片自身输出 + 受控同源地址），
 * 因此「注册了」与「兜底判定通过」不会互相矛盾；注册集合只作为扩展侧的**正向**证据，
 * 不用它反证不可用。
 */
export function imageFocusTargetValid(input: {
  /** 扩展写入的目标集合是否包含该节点。 */
  registered: boolean;
  canvas: ServerCanvas | null;
  nodeId: string;
}): boolean {
  return input.registered || isImageFocusTarget(input.canvas, input.nodeId);
}
