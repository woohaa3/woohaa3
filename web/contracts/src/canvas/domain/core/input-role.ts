import type { Woohaa3CanvasInputRole } from "./input-role-contract";
import { isCompositeAssetNodeType } from "./composite-asset-identity";

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
  return nodeType === "text" || nodeType === "image" || nodeType === "video" || nodeType === "audio" || nodeType === "motion"
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
  readNodeData?: (nodeId: string) => Record<string, unknown> | undefined;
}): Woohaa3CanvasInputRole {
  const sourceKind = resolveWoohaa3CanvasNodeMediaKind(options.sourceNode.type, options.sourceData);
  const targetKind = resolveWoohaa3CanvasTaskKind(options.targetNode.type, options.targetData) ?? options.targetNode.type;
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
  // 自包含 3D 节点（model3d）按目标 canonical type 声明全部受支持
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
