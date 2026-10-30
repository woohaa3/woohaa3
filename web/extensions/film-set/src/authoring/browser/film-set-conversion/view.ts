/**
 * 「转为片场」动作的可用性判定（纯函数）
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.4/3.9 / design D6/D7）。
 *
 * 与 React/DOM 解耦，供组件与非渲染回归共用：只做「来源节点是否可发起转换」的纯数据判定，
 * 不测量 DOM、不写画布。下载按**可读取内容**门禁；转换按**实际写权限**门禁，两者独立。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import { readFilmSetConversionSourceKind, scriptModel3DNodeData } from "@woohaa3/contracts";
import { ownsShotMedia } from "../../../state/shared/managed-shot-media.js";

/** 转换动作可用性：`available: false` 时给出可读原因（按钮禁用并说明）。 */
export type FilmSetConversionAvailability = { available: true } | { available: false; reason: string };

/**
 * 节点是否已经有 group 归属。
 *
 * 片场本身是 group，而规范文档不支持嵌套 group；因此已在任意组内的节点没有转换入口——
 * 三个入口都用它隐藏，而不是只禁用（选中组内卡片时不该出现「创建片场」）。
 */
export function filmSetConversionSourceInGroup(canvas: ServerCanvas | null, nodeId: string): boolean {
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  return typeof node?.parentId === "string" && node.parentId !== "";
}

/**
 * 依来源节点、**当前画布**与写权限判定「转为片场」是否可用。
 *
 * - 只支持图片/视频/model3d（`readFilmSetConversionSourceKind` 权威判定）；
 * - 已在任意组内的节点不可转换（片场是 group，不支持嵌套 group）；
 * - 图片/视频必须有 ready 且类型匹配的原资产（平面导入用同一 `outputAssetId` 语义）；
 * - model3d 必须有完整模型定义（解码成功）；
 * - 只读会话禁用转换（写门禁独立于下载的可读取门禁）。
 */
export function resolveFilmSetConversionAvailability(input: {
  canvas: ServerCanvas | null;
  nodeId: string;
  nodeType: string;
  writable: boolean;
}): FilmSetConversionAvailability {
  const { canvas, nodeId, nodeType, writable } = input;
  if (!canvas) return { available: false, reason: "作品尚未加载，暂时无法转换" };
  const kind = readFilmSetConversionSourceKind(nodeType);
  if (!kind) return { available: false, reason: "此类节点暂不支持转为片场" };
  if (!writable) return { available: false, reason: "当前会话不可写，无法创建片场" };
  if (filmSetConversionSourceInGroup(canvas, nodeId)) return { available: false, reason: "已在组内的节点不能创建片场" };
  const data = canvas.nodeData[nodeId];
  if (ownsShotMedia(canvas, nodeId)) return { available: false, reason: "片场镜头媒体不能再次创建片场" };
  if (kind === "model3d") {
    return scriptModel3DNodeData(data) ? { available: true } : { available: false, reason: "文件模型无法转为片场，请使用脚本模型" };
  }
  const assetId = (data as { outputAssetId?: unknown } | undefined)?.outputAssetId;
  const asset = typeof assetId === "string" ? canvas.assets.find((entry) => entry.id === assetId) : undefined;
  if (!asset || asset.status !== "ready" || asset.mediaKind !== kind) {
    return { available: false, reason: "来源素材尚未就绪，暂时无法转换" };
  }
  return { available: true };
}

/**
 * 是否需要独立的设置箭头：图片、视频有（模型/可选要求，视频另有范围）；3D 直接包组无需箭头
 * （design D1：3D 不是 LLM 路径，只有一个动作）。
 */
export function filmSetConversionNeedsSettings(kind: string): boolean {
  return kind === "image" || kind === "video";
}

/** 视频是否需要「视频范围」设置（图片/3D 不需要）。 */
export function filmSetConversionNeedsRange(kind: string): boolean {
  return kind === "video";
}
