import { normalizeContentNodeData } from "../content-node-data.js";
import { sanitizeWoohaa3CanvasNodeData,
  type Woohaa3CanvasNodeDataMap,
  type Woohaa3CanvasDocument } from "./core";
import { DEFAULT_CANVAS_TITLE,
  type CanvasNodeData,
  type GenerationKind,
  type ServerCanvas,
  type StoredAsset } from "./types";
import { normalizeVideoEditIntents } from "../../video/video-edit.js";
import { isCompositeAssetNodeType } from "./core/composite-asset-identity.js";
import { observeContentResolver, type ContentContributionResolver } from "../content-contribution.js";
import { validateWorldIdentities, nodeHasCanvasCard } from "./world-identities.js";

export type UploadFileDescriptor = {
  name: string;
  type: string;
};

export function uploadedMediaKind(file: UploadFileDescriptor): GenerationKind | null {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();

  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?)$/i.test(name)) return "image";
  if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv|avi|flv|wmv)$/i.test(name)) return "video";
  if (type.startsWith("audio/") || /\.(mp3|wav|ogg|m4a|aac|flac|wma)$/i.test(name)) return "audio";
  if (type.startsWith("text/") || /\.(md|markdown|json|txt|csv|log|yaml|yml|xml|html?|js|ts|tsx|jsx)$/i.test(name)) return "text";
  return null;
}

export type NormalizeCanvasOptions = {
  extraNodeTypes?: readonly string[];
  content?: ContentContributionResolver;
};

/**
 * 应用已知的规范节点类型。
 *
 * 与运行时节点种类一一对应（`text`/`image`/`video`/`audio`/`model3d`/`composite-asset`）；
 * 前端的 `CanvasNodeKind` 用同一集合。这些是**应用节点**，不属于「未知类型」，因此规范化
 * 必须保留它们。已下线的旧类型（`generate`/`edit`/`shot`/`start`/`group`/`film-set-shot-preview`）
 * 不再兼容，读取时收敛为 `custom`；不再保留旧容器迁移。
 */
export const WOOHAA3_APP_NODE_TYPES = ["text", "image", "video", "audio", "model3d", "composite-asset", "workflow-group-2d", "scene-area", "world-camera"] as const;

export class InvalidWorldIdentitiesError extends Error {}

export function normalizeCanvas(input: ServerCanvas, options?: NormalizeCanvasOptions): ServerCanvas {
  observeContentResolver(options?.content);
  const worldError = validateWorldIdentities(input.document.nodes, input.nodeData);
  if (worldError) throw new InvalidWorldIdentitiesError(worldError);
  const assets = Array.isArray(input.assets) ? input.assets.map(normalizeAsset) : [];
  const sanitizedNodeData = sanitizeWoohaa3CanvasNodeData(input.nodeData) as Woohaa3CanvasNodeDataMap<CanvasNodeData>;
  const document: Woohaa3CanvasDocument = {
    ...input.document,
    nodes: input.document.nodes.map((node) => normalizeNodeType(node, options?.extraNodeTypes))
  };
  // 导演区/共享世界模型没有卡片布局：读取时丢弃遗留的卡片坐标与尺寸，
  // 位置只由 sceneArea.bounds / sharedWorldInstance.transform 表达。
  document.nodes = document.nodes.map(node => {
    if (nodeHasCanvasCard(node, sanitizedNodeData[node.id] as Record<string, unknown> | undefined)) return node;
    const next = { ...node };
    delete next.position;
    delete next.width;
    delete next.height;
    delete next.parentId;
    delete next.zIndex;
    return next;
  });
  const normalizedWorldError = validateWorldIdentities(document.nodes, sanitizedNodeData);
  if (normalizedWorldError) throw new InvalidWorldIdentitiesError(normalizedWorldError);

  const nodeIdsAfterSanitize = new Set(document.nodes.map((node) => node.id));
  document.edges = document.edges.filter(
    (edge) => nodeIdsAfterSanitize.has(edge.source) && nodeIdsAfterSanitize.has(edge.target)
  );

  // Node data is subordinate to the structural document. Never carry orphan
  // keys across a load; doing so lets execution target a node ID that no
  // longer exists after CRDT hydration.
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const nodeTypes = new Map(document.nodes.map((node) => [node.id, node.type]));
  const nodeData = Object.fromEntries(Object.entries(sanitizedNodeData)
    .filter(([nodeId]) => nodeIds.has(nodeId) && nodeTypes.get(nodeId) !== "custom")) as Woohaa3CanvasNodeDataMap<CanvasNodeData>;

  // slot 身份在创建/planner 阶段生成并持久化（change: 2026-10-07-remove-residual-compatibility）：
  // 读取/normalize 不再按 sourceNodeId/sortKey 重建或补齐 slot 身份。

  // 视频编辑 intent 安全收敛（change: port-video-editing-dialogs，design D4/D6）：
  // 丢弃危险/非法 intent（含 data URL / object URL / 临时签名 URL），只保留稳定身份。
  applyVideoEditIntentSanitizer(nodeData);
  // 通用复合资产的内容收敛（业务扩展自带的 content contribution，例如炉体）。
  applyCompositeContentSanitizer(nodeData, nodeTypes, options?.content);

  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : DEFAULT_CANVAS_TITLE;
  return { ...input, title, document, nodeData, assets, jobs: Array.isArray(input.jobs) ? input.jobs : [] };
}

function normalizeNodeType(
  node: Woohaa3CanvasDocument["nodes"][number],
  extraNodeTypes?: readonly string[]
): Woohaa3CanvasDocument["nodes"][number] {
  if (
    (WOOHAA3_APP_NODE_TYPES as readonly string[]).includes(node.type)
    || node.type === "custom"
    || extraNodeTypes?.includes(node.type)
  ) return node;
  return { ...node, type: "custom" };
}

function normalizeAsset(asset: StoredAsset): StoredAsset {
  // 资产契约要求 `mediaKind` 必填；缺失的记录已在 `parseCanvasAggregate` 被拒绝，
  // 这里不再做旧格式推断迁移。
  return asset;
}

/**
 * 对每个 nodeData 上的 `videoEditIntents` 做 canonical 收敛
 * （change: port-video-editing-dialogs，design D4/D6）。
 *
 * 非法/危险 intent（data URL、object URL、临时签名 URL、越界时间、超限等）被整体丢弃，
 * 绝不写入规范状态；合法 intent 稳定排序后写回。
 */
function applyVideoEditIntentSanitizer(nodeData: Record<string, CanvasNodeData>): void {
  for (const data of Object.values(nodeData)) {
    if (!data || data.videoEditIntents === undefined) continue;
    const result = normalizeVideoEditIntents(data.videoEditIntents);
    if (result.ok) {
      if (result.value.length > 0) data.videoEditIntents = result.value;
      else delete data.videoEditIntents;
    } else {
      delete data.videoEditIntents;
    }
  }
}

/**
 * 复合资产内容收敛（change: 2026-10-08-make-film-set-model-only，design D3；
 * change: 2026-10-11-extract-film-set-extension D5/D11；change: remove-canvas-groups-and-film-set）。
 *
 * 只有已注册的内容 contribution 才收敛；未知/不可用业务的复合资产**保留原数据与引用**，
 * 不做删除或改写，以便停用/未注册业务的已保存内容不丢失。
 */
function applyCompositeContentSanitizer(
  nodeData: Record<string, CanvasNodeData>,
  nodeTypes: Map<string, string>,
  content?: ContentContributionResolver
): void {
  if (!content) return;
  for (const [nodeId, data] of Object.entries(nodeData)) {
    if (!data) continue;
    if (!isCompositeAssetNodeType(nodeTypes.get(nodeId))) continue;
    nodeData[nodeId] = normalizeContentNodeData(data, content);
  }
}
