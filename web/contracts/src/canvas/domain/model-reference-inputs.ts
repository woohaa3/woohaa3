/**
 * 3D 模型节点（model3d）前序参考输入解析
 * （change: add-model-mcp-reference-inputs）。
 *
 * 3D 模型节点不参与任务执行，因此不走 `resolveNodeReferenceInputs`/mention 编译。
 * 但它在用 MCP 生成 `modelScript` 时同样需要知道「连进来的前序参考文本/图片/视频」。
 *
 * 本模块是纯函数，从画布聚合直接解析该节点**直接 incoming mappings** 的稳定引用：
 * - 文本：上游文字节点的权威文字内容（ready 文本资产优先，其次其 prompt/panelPrompt）；
 * - 媒体：显式 `sourceAssetIds` 优先，否则 source 的 `outputAssetId`，只接受 ready 且带
 *   稳定 storageKey 的资产；
 * - 只输出稳定引用与同源相对预览地址，绝不输出签名 URL、bytes 或外部地址。
 */
import { selfReferenceMapping, ensureWoohaa3CanvasInputMappingSlotId, inferWoohaa3CanvasInputRole } from "./core";
import type { CanvasNodeData, CanvasNodeInputMapping } from "./types";
import { sortWoohaa3CanvasInputMappings } from "./core";

/** 前序参考类型。 */
export type ModelReferenceKind = "text" | "image" | "video" | "audio";

export type ModelReferenceInput = {
  /** 目标节点内稳定的输入槽身份。 */
  slotId: string;
  kind: ModelReferenceKind;
  role: string;
  sourceNodeId: string;
  /** 人类可读标签（如「图片 1」）。 */
  label: string;
  /** 文本引用的权威内容（仅 kind === "text"）。 */
  text?: string;
  /** 稳定媒体引用（仅媒体类型且资产 ready）。 */
  asset?: {
    assetId: string;
    storageKey: string;
    mediaType: string;
    mediaKind: "image" | "video" | "audio";
    /** 同源相对读取地址，供 MCP 侧展示/下载；不定为签名 URL。 */
    url: string;
  };
  /** 尚未就绪时的诊断原因。 */
  pendingReason?: string;
};

export type ModelReferenceInputs = {
  nodeId: string;
  references: ModelReferenceInput[];
};

/** 画布公开媒体路径（与前端 `media-path.ts` 保持同一前缀）。 */
export const MEDIA_PUBLIC_BASE_PATH = "/api/media" as const;

/** 由稳定 storageKey 构造同源相对读取地址。 */
export function mediaPublicUrlFor(storageKey: string): string {
  return `${MEDIA_PUBLIC_BASE_PATH}/${storageKey}`;
}

type CanvasLike = {
  document: {
    nodes: ReadonlyArray<{ id: string; type: string }>;
    edges: ReadonlyArray<{ source: string; target: string }>;
  };
  nodeData: Record<string, CanvasNodeData | undefined>;
  assets: ReadonlyArray<{
    id: string;
    mediaKind?: string;
    status?: string;
    text?: string;
    url?: string;
    metadata?: Record<string, unknown>;
  }>;
};

/**
 * 解析目标节点（通常是 generate）的直接前序参考输入。
 * 保持 mapping 的稳定顺序；无法匹配的 source 只产生带诊断的条目，不静默消失。
 */
export function resolveModelReferenceInputs(canvas: CanvasLike, nodeId: string): ModelReferenceInputs {
  const references: ModelReferenceInput[] = [];
  const mappings = collectDirectMappings(canvas, nodeId);
  let ordinal = 0;
  for (const mapping of mappings) {
    ordinal += 1;
    const kind = referenceKindForMapping(mapping, canvas, mapping.sourceNodeId);
    const label = referenceLabel(mapping, kind, ordinal);
    const slotId = mapping.slotId ?? "";
    if (kind === "text") {
      const text = textNodeContent(canvas.nodeData[mapping.sourceNodeId], canvas.assets);
      references.push({
        slotId,
        kind,
        role: mapping.role,
        sourceNodeId: mapping.sourceNodeId,
        label,
        text,
        ...(text === "" ? { pendingReason: "上游文字节点没有内容" } : {})
      });
      continue;
    }
    const resolved = resolveMappingMedia(canvas, mapping);
    if (!resolved) {
      references.push({
        slotId,
        kind,
        role: mapping.role,
        sourceNodeId: mapping.sourceNodeId,
        label,
        pendingReason: `上游节点 ${mapping.sourceNodeId} 还没有可用输出`
      });
      continue;
    }
    references.push({
      slotId,
      kind,
      role: mapping.role,
      sourceNodeId: mapping.sourceNodeId,
      label,
      asset: resolved
    });
  }
  return { nodeId, references };
}

/**
 * 目标节点的直接 incoming mappings（补稳定 slot、稳定排序）。
 *
 * 公开纯函数（change: 2026-10-10-extract-optional-feature-extensions）：可选扩展（如
 * prompt-snippets）需要读取目标节点的直接输入 topology 来 materialize 片段正文，但 MUST NOT
 * import 宿主内部实现；本函数只依赖画布聚合与 contracts 纯逻辑，作为公共能力开放。
 */
export function collectDirectMappings(canvas: CanvasLike, nodeId: string): CanvasNodeInputMapping[] {
  const incoming = canvas.document.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  const sourceSet = new Set(incoming);
  const nodeById = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const declared = (canvas.nodeData[nodeId]?.inputMapping ?? [])
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
          sourceData: canvas.nodeData[sourceNodeId],
          targetData: canvas.nodeData[nodeId],
          existingRoles: declared.map((mapping) => mapping.role)
        }),
        sortKey: String(declared.length + index)
      })
    );
  const self = selfReferenceMapping(nodeId, canvas.nodeData[nodeId]);
  return [...(self ? [self] : []), ...sortWoohaa3CanvasInputMappings(declared), ...synthesized];
}

function referenceKindForMapping(mapping: CanvasNodeInputMapping, canvas: CanvasLike, sourceNodeId: string): ModelReferenceKind {
  const sourceType = canvas.document.nodes.find((node) => node.id === sourceNodeId)?.type;
  // 已知源类型优先于可能错误的 mapping role：历史误标为 `text_prompt` 的 image/video/audio
  // 引用不得被迫走文本路径（change: 2026-10-06-fix-model-media-references-and-animation-preview，D1）。
  if (sourceType === "video") return "video";
  if (sourceType === "audio") return "audio";
  if (sourceType === "text") return "text";
  if (sourceType === "image") return "image";
  // 源类型未知（custom/缺失）：退回 mapping role 推断。
  if (mapping.role === "text_prompt") return "text";
  if (mapping.role.includes("video")) return "video";
  if (mapping.role.includes("audio") || mapping.role.includes("voice")) return "audio";
  return "image";
}

function referenceLabel(mapping: CanvasNodeInputMapping, kind: ModelReferenceKind, ordinal: number): string {
  if (typeof mapping.label === "string" && mapping.label !== "") return mapping.label;
  const noun = kind === "text" ? "文本" : kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片";
  return `${noun} ${ordinal}`;
}

function resolveMappingMedia(
  canvas: CanvasLike,
  mapping: CanvasNodeInputMapping
): ModelReferenceInput["asset"] | null {
  const explicit = (mapping.sourceAssetIds ?? []).filter((id): id is string => typeof id === "string" && id !== "");
  const assetIds =
    explicit.length > 0
      ? explicit
      : [canvas.nodeData[mapping.sourceNodeId]?.outputAssetId].filter(
          (id): id is string => typeof id === "string" && id !== ""
        );
  if (assetIds.length === 0) return null;
  const asset = canvas.assets.find((entry) => entry.id === assetIds[0]);
  if (!asset || asset.status !== "ready") return null;
  const mediaKind = asset.mediaKind;
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") return null;
  const storageKey = readStorageKey(asset);
  if (!storageKey) return null;
  return {
    assetId: asset.id,
    storageKey,
    mediaType: readMediaType(asset, storageKey),
    mediaKind,
    url: mediaPublicUrlFor(storageKey)
  };
}

function textNodeContent(
  data: CanvasNodeData | undefined,
  assets: CanvasLike["assets"]
): string {
  const assetId = data?.outputAssetId;
  const asset = typeof assetId === "string" ? assets.find((entry) => entry.id === assetId) : undefined;
  const generated = asset?.mediaKind === "text" ? asset.text?.trim() ?? "" : "";
  if (generated !== "") return generated;
  const prompt = data?.prompt ?? data?.panelPrompt ?? "";
  return typeof prompt === "string" ? prompt.trim() : "";
}

function readStorageKey(asset: { metadata?: Record<string, unknown> }): string | null {
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

function readMediaType(asset: { metadata?: Record<string, unknown> }, storageKey: string): string {
  const contentType = asset.metadata?.contentType;
  if (typeof contentType === "string" && contentType !== "") {
    return contentType.split(";")[0]!.trim().toLowerCase();
  }
  const extension = storageKey.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MEDIA_TYPES[extension] ?? "image/png";
}
