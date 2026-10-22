import type { Woohaa3CanvasInputRole } from "./input-role-contract";
import { isCompositeAssetNodeType } from "./composite-asset-identity";
import { isShotPreviewNodeType } from "./shot-preview-node";
import { SHOT_REFERENCE_ROLE } from "./shot-reference";

type NodeLike = { id: string; type: string };

export type Woohaa3CanvasNodeDataLike = {
  taskKind?: unknown;
  resourceKind?: unknown;
  resultPreview?: unknown;
  parameters?: unknown;
};

export function resolveWoohaa3CanvasTaskKind(
  nodeType: string | undefined,
  nodeData: Woohaa3CanvasNodeDataLike | undefined,
): string | undefined {
  if (typeof nodeData?.taskKind === "string" && nodeData.taskKind.trim()) return nodeData.taskKind.trim();
  return nodeType === "text" || nodeType === "image" || nodeType === "video" || nodeType === "audio"
    ? `${nodeType}-generation`
    : undefined;
}

export function resolveWoohaa3CanvasNodeMediaKind(
  nodeType: string | undefined,
  nodeData: Woohaa3CanvasNodeDataLike | undefined,
): "image" | "video" | "audio" | "text" {
  const preview = nodeData?.resultPreview;
  if (preview && typeof preview === "object" && !Array.isArray(preview)) {
    const kind = (preview as Record<string, unknown>).kind;
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "text") return kind;
  }
  const taskKind = resolveWoohaa3CanvasTaskKind(nodeType, nodeData);
  if (taskKind?.includes("video")) return "video";
  if (taskKind?.includes("audio") || taskKind === "voice-generation" || taskKind === "music-generation") return "audio";
  if (taskKind?.includes("text")) return "text";
  if (nodeData?.resourceKind === "video") return "video";
  if (nodeData?.resourceKind === "audio") return "audio";
  if (nodeData?.resourceKind === "text" || nodeData?.resourceKind === "document") return "text";
  if (nodeType === "video") return "video";
  if (nodeType === "audio") return "audio";
  if (nodeType === "text") return "text";
  return "image";
}

export function inferWoohaa3CanvasInputRole(options: {
  sourceNode: NodeLike;
  targetNode: NodeLike;
  sourceData?: Woohaa3CanvasNodeDataLike;
  targetData?: Woohaa3CanvasNodeDataLike;
  existingRoles?: readonly string[];
}): Woohaa3CanvasInputRole {
  const sourceKind = resolveWoohaa3CanvasNodeMediaKind(options.sourceNode.type, options.sourceData);
  const targetKind = resolveWoohaa3CanvasTaskKind(options.targetNode.type, options.targetData) ?? options.targetNode.type;
  // 镜头参考（D9 / 任务 8.1）：动态镜头预览来源 → 视频生成节点使用**专用**角色，
  // 与普通媒体参考区分；预处理顺序在一切通用候选之前，避免被回落成 reference_video。
  if (isShotPreviewNodeType(options.sourceNode.type)) return SHOT_REFERENCE_ROLE;
  const parameters = options.targetData?.parameters && typeof options.targetData.parameters === "object" && !Array.isArray(options.targetData.parameters)
    ? options.targetData.parameters as Record<string, unknown>
    : {};
  const existingRoles = new Set(options.existingRoles ?? []);
  if (sourceKind === "text") return "text_prompt";
  if (parameters.generationMode === "first_last_frame" && sourceKind === "image") {
    if (!existingRoles.has("first_frame")) return "first_frame";
    if (!existingRoles.has("last_frame")) return "last_frame";
  }
  if (parameters.generationMode === "edit_video" && sourceKind === "video" && !existingRoles.has("edit_video")) {
    return "edit_video";
  }
  const candidate: Woohaa3CanvasInputRole = sourceKind === "video"
    ? "reference_video"
    : sourceKind === "audio" ? "voice_sample" : "reference_image";
  // 自包含 3D 节点（model3d/animation3d）按目标 canonical type 声明全部受支持
  // 媒体角色，避免把 3D 作者参考限制误套成图片生成 binding，使视频/音频候选回退成 text_prompt
  // （change: 2026-10-06-fix-model-media-references-and-animation-preview，D1）。
  if (isModelAuthoringNodeType(options.targetNode.type)) {
    const modelAcceptable: Woohaa3CanvasInputRole[] = [
      "text_prompt",
      "reference_image",
      "reference_video",
      "voice_sample"
    ];
    return modelAcceptable.includes(candidate) ? candidate : modelAcceptable[0]!;
  }
  const acceptable = targetKind.includes("video")
    ? ["text_prompt", "reference_image", "first_frame", "last_frame", "reference_video", "voice_sample", "edit_video"]
    : targetKind.includes("audio") || targetKind.includes("voice")
      ? ["text_prompt", "voice_sample"]
      : targetKind.includes("text")
        ? ["text_prompt", "reference_image", "reference_video", "voice_sample"]
        : ["text_prompt", "reference_image", "style_reference", "character_reference", "scene_reference", "prop_reference"];
  return acceptable.includes(candidate) ? candidate : acceptable[0] ?? "reference_image";
}

/** 3D 作者节点 canonical type：它们接受文本/图片/视频/音频参考。 */
export function isModelAuthoringNodeType(type: string | undefined): boolean {
  return type === "model3d" || isCompositeAssetNodeType(type);
}

/**
 * 片场节点类型判断
 * （change: 2026-10-11-extract-film-set-extension，D1/D11）。
 *
 * 片场已被共同复合资产类别取代；完整业务判别是 `composite-asset` + `extensionId="film-set"`，
 * 业务侧用 `isFilmSetNode(type, nodeData)`。此处仅按**类别**判断，供呈现/连接等无需区分业务的
 * 公共路径使用，避免误把片场与炉体拆成两种 canonical type。
 */
export function isFilmSetNodeType(type: string | undefined): boolean {
  return isCompositeAssetNodeType(type);
}

/**
 * 无卡片、无端口、不能作为持久化边端点的纯模型节点类型（复合资产类别）。
 *
 * 单一事实源：连接规则、规范化清理、渲染范围过滤与 MCP 提示共用它，避免同一规则在多处
 * 分叉。
 */
export function isPureModelNodeType(type: string | undefined): boolean {
  return isCompositeAssetNodeType(type);
}
