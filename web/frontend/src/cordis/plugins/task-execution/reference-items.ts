/**
 * 参考素材 items 投影（change: add-reference-inputs-and-mentions，任务 3.1 / design D6）。
 *
 * 纯函数：按目标节点的直接 mappings 投影出可展示的参考 chips 数据：source、显式资产子集、
 * 媒体类型、角色、稳定预览资格、ready/等待/失效状态与 blocking reason。
 *
 * chips 是权威拓扑的 UI 投影；mention 候选只从**可确定类型**的 slot 构造。两者共用本投影。
 */
import {
  decodeWorldCamera,
  worldCameraShotContext,
  ensureWoohaa3CanvasInputMappingSlotId,
  inferWoohaa3CanvasInputRole,
  sortWoohaa3CanvasInputMappings,
  type CanvasNodeData,
  type CanvasNodeInputMapping,
  type CanvasReferenceMediaKind,
  type CanvasTaskInputBinding,
  type ServerCanvas,
  type StoredAsset,
  type Woohaa3CanvasMentionType
} from "@woohaa3/contracts";
import { resolveCanonicalMediaUrl } from "../../services/media-remote.js";

export type ReferenceItemStatus = "ready" | "waiting" | "invalid";

export type ReferenceItem = {
  slotId: string;
  sourceNodeId: string;
  role: string;
  /** mention token 类型（可确定时）；文字角色为 input_text。 */
  mentionType: Woohaa3CanvasMentionType;
  label: string;
  mediaKind: CanvasReferenceMediaKind | "text" | null;
  /** 稳定同源预览地址（仅展示用，不参与权威解析）。 */
  previewUrl: string | null;
  assetId: string | null;
  status: ReferenceItemStatus;
  /** 阻止执行的原因（无则为 null）。 */
  blockingReason: string | null;
};

export type ReferenceProjection = {
  items: ReferenceItem[];
  /** 与 bindings 相关的阻止原因（如模型不接受某类型）。 */
  blockingReasons: string[];
};

/** 由 mapping 投影参考 items（保持稳定顺序）。 */
export function resolveReferenceItems(options: {
  canvas: ServerCanvas;
  nodeId: string;
  /** 无目录绑定的 authoring 入口可省略；普通任务仍传绑定并验证模型能力。 */
  bindings?: CanvasTaskInputBinding[];
}): ReferenceProjection {
  const { canvas, nodeId, bindings } = options;
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const items: ReferenceItem[] = [];
  const blockingReasons: string[] = [];
  let ordinal = 0;

  for (const mapping of collectDirectMappings(canvas, nodeId)) {
    const mentionType = mentionTypeForMapping(mapping);
    ordinal += 1;
    const label = referenceLabel(mapping, mentionType, ordinal);
    const slotId = mapping.slotId ?? "";
    if (mentionType === "input_text") {
      const text = textNodeContent(nodeData[mapping.sourceNodeId], canvas.assets);
      items.push({
        slotId,
        sourceNodeId: mapping.sourceNodeId,
        role: mapping.role,
        mentionType,
        label,
        mediaKind: "text",
        previewUrl: null,
        assetId: null,
        status: text === "" ? "waiting" : "ready",
        blockingReason: null
      });
      continue;
    }
    if (canvas.document.nodes.some(node => node.id === mapping.sourceNodeId && node.type === "world-camera")) {
      const camera = decodeWorldCamera(nodeData[mapping.sourceNodeId]?.worldCamera);
      // 镜头类型由动画上下文派生：动态镜头在参考区显示为“视频 N”，静态才是“图片 N”。
      const dynamic = camera.ok && worldCameraShotContext(canvas, camera.value)?.kind === "dynamic";
      const referenceRole = dynamic ? "reference_video" : mapping.role;
      const effectiveMention: Woohaa3CanvasMentionType = dynamic ? "input_video" : mentionType;
      const effectiveLabel = typeof mapping.label === "string" && mapping.label !== ""
        ? mapping.label
        : referenceLabel({ ...mapping, role: referenceRole }, effectiveMention, ordinal);
      const acceptable = bindings === undefined || bindings.some(entry => entry.roles.includes(referenceRole)
        && entry.mediaKinds.includes(dynamic ? "video" : "image")
        && entry.mediaTypes.includes(dynamic ? "video/mp4" : "image/png"));
      const reason = !camera.ok
        ? "上游镜头配置无效"
        : !acceptable
          ? dynamic ? "所选模型不接受镜头视频参考" : "所选模型不接受镜头图像参考"
          : null;
      // 镜头像素由宿主/页面在提交时按当前取景冻结；配置合法且模型接受时即可引用（可 @）。
      items.push({ slotId, sourceNodeId: mapping.sourceNodeId, role: referenceRole, mentionType: effectiveMention,
        label: effectiveLabel, mediaKind: dynamic ? "video" : "image", previewUrl: null, assetId: null,
        status: reason ? "invalid" : "ready", blockingReason: reason });
      if (reason) blockingReasons.push(reason);
      continue;
    }
    const resolved = resolveMappingAsset(canvas, mapping);
    if (!resolved) {
      items.push({
        slotId,
        sourceNodeId: mapping.sourceNodeId,
        role: mapping.role,
        mentionType,
        label,
        mediaKind: null,
        previewUrl: null,
        assetId: null,
        status: "waiting",
        blockingReason: `上游节点 ${mapping.sourceNodeId} 还没有可用输出`
      });
      continue;
    }
    const binding = bindings?.find(
      (entry) =>
        entry.roles.includes(mapping.role) &&
        entry.mediaKinds.includes(resolved.mediaKind) &&
        entry.mediaTypes.includes(resolved.mediaType)
    );
    const acceptable = bindings === undefined || binding !== undefined;
    const item: ReferenceItem = {
      slotId,
      sourceNodeId: mapping.sourceNodeId,
      role: mapping.role,
      mentionType,
      label,
      mediaKind: resolved.mediaKind,
      previewUrl: resolved.previewUrl,
      assetId: resolved.assetId,
      status: resolved.ready && acceptable ? "ready" : resolved.ready ? "invalid" : "waiting",
      blockingReason: acceptable ? null : `所选模型不接受参考角色「${mapping.role}」或媒体类型「${resolved.mediaType}」`
    };
    items.push(item);
    if (item.blockingReason) blockingReasons.push(item.blockingReason);
  }

  return { items, blockingReasons };
}

/** mapping 当前指向的稳定资产解析结果。 */
type ResolvedMapping = {
  assetId: string;
  mediaKind: CanvasReferenceMediaKind;
  mediaType: string;
  previewUrl: string | null;
  ready: boolean;
};

function resolveMappingAsset(canvas: ServerCanvas, mapping: CanvasNodeInputMapping): ResolvedMapping | null {
  if (mapping.role === "text_prompt") return null;
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const explicit = (mapping.sourceAssetIds ?? []).filter((id): id is string => typeof id === "string" && id !== "");
  const assetIds =
    explicit.length > 0
      ? explicit
      : [nodeData[mapping.sourceNodeId]?.outputAssetId].filter((id): id is string => typeof id === "string" && id !== "");
  if (assetIds.length === 0) return null;
  const assetId = assetIds[0]!;
  const asset = canvas.assets.find((entry) => entry.id === assetId);
  if (!asset) return null;
  const mediaKind = asset.mediaKind;
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") return null;
  const storageKey = readStorageKey(asset);
  const mediaType = storageKey ? readMediaType(asset, storageKey) : "image/png";
  return {
    assetId,
    mediaKind,
    mediaType,
    previewUrl: readPreviewUrl(asset, canvas.id),
    ready: asset.status === "ready" && storageKey !== null
  };
}

/** 只接受稳定同源媒体 URL 作为预览（不参与权威解析）；画布内预览带画布读提示。 */
function readPreviewUrl(asset: StoredAsset, canvasId?: string): string | null {
  return resolveCanonicalMediaUrl(asset, canvasId);
}

function readStorageKey(asset: StoredAsset): string | null {
  const key = asset.metadata?.storageKey;
  return typeof key === "string" && key !== "" ? key : null;
}

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4"
};

function readMediaType(asset: StoredAsset, storageKey: string): string {
  const contentType = asset.metadata?.contentType;
  if (typeof contentType === "string" && contentType !== "") {
    return contentType.split(";")[0]!.trim().toLowerCase();
  }
  const extension = storageKey.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MEDIA_TYPES[extension] ?? "image/png";
}

function textNodeContent(data: CanvasNodeData | undefined, assets: readonly StoredAsset[]): string {
  const assetId = data?.outputAssetId;
  const asset = typeof assetId === "string" ? assets.find((entry) => entry.id === assetId) : undefined;
  const generated = asset?.mediaKind === "text" ? asset.text?.trim() ?? "" : "";
  if (generated !== "") return generated;
  const prompt = data?.prompt ?? data?.panelPrompt ?? "";
  return typeof prompt === "string" ? prompt.trim() : "";
}

/** 目标节点直接 mapping（仅保留合法 incoming source，稳定排序 + 补 slot）。 */
export function collectDirectMappings(canvas: ServerCanvas, nodeId: string): CanvasNodeInputMapping[] {
  const nodeData = canvas.nodeData as Record<string, CanvasNodeData | undefined>;
  const incoming = canvas.document.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source);
  const sourceSet = new Set(incoming);
  const nodeById = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const declared = (nodeData[nodeId]?.inputMapping ?? [])
    .filter((mapping) => sourceSet.has(mapping.sourceNodeId));
  const declaredSources = new Set(declared.map((mapping) => mapping.sourceNodeId));
  const synthesized = incoming
    .filter((sourceNodeId) => !declaredSources.has(sourceNodeId))
    .map((sourceNodeId, index) =>
      ensureWoohaa3CanvasInputMappingSlotId({
        sourceNodeId,
        role: inferWoohaa3CanvasInputRole({
          sourceNode: nodeById.get(sourceNodeId) ?? { id: sourceNodeId, type: "custom" },
          targetNode: { id: nodeId, type: nodeById.get(nodeId)?.type ?? "custom" },
          sourceData: nodeData[sourceNodeId],
          readNodeData: id => nodeData[id],
          targetData: nodeData[nodeId],
          existingRoles: declared.map((mapping) => mapping.role)
        }),
        sortKey: String(declared.length + index)
      })
    );
  return [...sortWoohaa3CanvasInputMappings(declared), ...synthesized];
}

function mentionTypeForMapping(mapping: CanvasNodeInputMapping): Woohaa3CanvasMentionType {
  if (mapping.role === "text_prompt") return "input_text";
  if (mapping.role.includes("video")) return "input_video";
  if (mapping.role.includes("audio") || mapping.role.includes("voice") || mapping.role.includes("music")) {
    return "input_audio";
  }
  return "input_image";
}

function referenceLabel(mapping: CanvasNodeInputMapping, type: Woohaa3CanvasMentionType, ordinal: number): string {
  if (typeof mapping.label === "string" && mapping.label !== "") return mapping.label;
  const noun = type === "input_image" ? "图片" : type === "input_video" ? "视频" : type === "input_audio" ? "音频" : "文本";
  return `${noun} ${ordinal}`;
}
