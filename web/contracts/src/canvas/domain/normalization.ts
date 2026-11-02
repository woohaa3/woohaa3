import { normalizeContentNodeData } from "../content-node-data.js";
import { sanitizeWoohaa3CanvasNodeData,
  sanitizeSerializedParentIds,
  type Woohaa3CanvasEdge,
  type Woohaa3CanvasNodeDataMap,
  type Woohaa3CanvasDocument } from "./core";
import { DEFAULT_CANVAS_TITLE,
  type CanvasNodeData,
  type GenerationKind,
  type ServerCanvas,
  type StoredAsset } from "./types";
import { normalizeVideoEditIntents } from "../../video/video-edit.js";
import { decodeFilmSetContent, FILM_SET_CONTENT_FIELD } from "../film-set-content.js";
import { isPureModelNodeType } from "./core/input-role.js";
import { FILM_SET_SHOT_PREVIEW_NODE_TYPE, isShotPreviewNode } from "./core/shot-preview-node.js";
import { isSupportedShotReferenceEdgeData, resolveShotReferenceSource, shotReferenceRoleForKind, SHOT_IMAGE_REFERENCE_EDGE_KIND, SHOT_REFERENCE_EDGE_KIND } from "./core/shot-reference.js";
import { shotReferenceDecision } from "./core/connection-rules.js";
import { isCompositeAssetNodeType, isFilmSetNode, readCompositeAssetExtensionId } from "./core/composite-asset-identity.js";
import { migrateContentNodeData, observeContentResolver, type ContentContributionResolver } from "../content-contribution.js";
import { DIRECTOR_STUDIO_DEFAULT_TITLE, LEGACY_ANIMATION_DEFAULT_TITLE } from "../director-studio-title.js";
import { decodeFilmSetGroupMarker, FILM_SET_GROUP_FIELD, validateFilmSetGroupBindings } from "../film-set-group.js";

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
 * 与运行时节点种类一一对应（`text`/`image`/`video`/`audio`/`model3d`/`animation3d`）；
 * 前端的 `CanvasNodeKind` 用同一集合。这些是**应用节点**，不属于「未知类型」，因此规范化
 * 必须保留它们。已下线的旧类型（`generate`/`edit`/`shot`/`start`）不再兼容，会被收敛为
 * `custom` 并剪除 nodeData（change: 2026-10-07-remove-legacy-node-type-compat）。
 */
export const WOOHAA3_APP_NODE_TYPES = ["text", "image", "video", "audio", "model3d", "composite-asset", FILM_SET_SHOT_PREVIEW_NODE_TYPE] as const;

export function normalizeCanvas(input: ServerCanvas, options?: NormalizeCanvasOptions): ServerCanvas {
  observeContentResolver(options?.content);
  const assets = Array.isArray(input.assets) ? input.assets.map(normalizeAsset) : [];
  const sanitizedNodeData = sanitizeWoohaa3CanvasNodeData(input.nodeData) as Woohaa3CanvasNodeDataMap<CanvasNodeData>;
  const document: Woohaa3CanvasDocument = {
    ...input.document,
    nodes: input.document.nodes.map((node) => {
      return normalizeNodeType(node, options?.extraNodeTypes);
    })
  };
  // group 结构完整性（change: add-canvas-node-grouping，design D1/D6）：
  // 不受信任输入里的 parentId 可能悬空或成环；清除它们并把坐标烘焙为绝对坐标，
  // 避免坏数据让渲染投影或 Yjs observer 反复计算相对偏移。同时在 group 被当作
  // 边端点时丢弃该边（持久化 group edge 不合法）。
  const sanitizedNodes = sanitizeSerializedParentIds(document.nodes);
  const nodeIdsAfterSanitize = new Set(sanitizedNodes.map((node) => node.id));
  const groupIds = new Set(sanitizedNodes.filter((node) => node.type === "group").map((node) => node.id));
  // 纯模型节点（片场 animation3d + 通用扩展节点 extension3d）不能作为边端点；加载/升级时
  // 同批清除已有相关边（change D8；change: 2026-10-10-add-game-furnace-extension 泛化）。
  const filmSetIds = new Set(sanitizedNodes.filter((node) => isPureModelNodeType(node.type, sanitizedNodeData[node.id] as Record<string, unknown> | undefined)).map((node) => node.id));
  // 拍摄镜头预览是归属呈现，不是普通边端点（change 2026-10-15 D2/D5）：同批清除相关边。
  // 唯一例外是合法镜头参考边（D9 / 任务 8.1）：动态镜头预览 → 视频生成节点。
  const shotPreviewIds = new Set(
    sanitizedNodes.filter((node) => isShotPreviewNode(node.type, sanitizedNodeData[node.id])).map((node) => node.id)
  );
  const readSanitizedNodeData = (nodeId: string) =>
    sanitizedNodeData[nodeId] as Record<string, unknown> | undefined;
  const connectionNodes = sanitizedNodes as unknown as Parameters<typeof shotReferenceDecision>[1];
  /** 镜头参考边合法性：结构版本受支持、来源动态预览、目标视频生成节点、且当前画布不存在重复边。 */
  const isLegalShotReferenceEdge = (edge: Woohaa3CanvasEdge): boolean => {
    const decision = shotReferenceDecision(
      { source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null },
      connectionNodes,
      [],
      { get: readSanitizedNodeData }
    );
    return decision.ok && isSupportedShotReferenceEdgeData(edge.data as Record<string, unknown> | undefined)
      && edge.data?.kind === (decision.source.kind === "static" ? SHOT_IMAGE_REFERENCE_EDGE_KIND : SHOT_REFERENCE_EDGE_KIND);
  };
  document.nodes = sanitizedNodes;
  document.edges = document.edges.filter(
    (edge) => nodeIdsAfterSanitize.has(edge.source) && nodeIdsAfterSanitize.has(edge.target)
      && !groupIds.has(edge.source) && !groupIds.has(edge.target)
      && !filmSetIds.has(edge.source) && !filmSetIds.has(edge.target)
      && ((!shotPreviewIds.has(edge.source) && !shotPreviewIds.has(edge.target)) || isLegalShotReferenceEdge(edge))
  );

  // Node data is subordinate to the structural document. Never carry orphan
  // keys across a load; doing so lets execution target a node ID that no
  // longer exists after CRDT hydration.
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const nodeTypes = new Map(document.nodes.map((node) => [node.id, node.type]));
  const nodeData = Object.fromEntries(Object.entries(sanitizedNodeData)
    .filter(([nodeId]) => nodeIds.has(nodeId) && nodeTypes.get(nodeId) !== "custom")) as Woohaa3CanvasNodeDataMap<CanvasNodeData>;

  // 片场（animation3d）无连线输入：清除片场自身 inputMapping 以及指向片场来源的 mapping
  // （change: 2026-10-08-make-film-set-model-only，design D8）。与边清理同批、幂等。
  cleanFilmSetInputMappings(nodeData, filmSetIds);
  // 拍摄镜头预览（D2）：归一化不得剥掉 preview 节点身份；同时清除其上的输入 mapping，
  // 预览不能作为普通生成/参考输入。
  cleanShotPreviewInputMappings(nodeData, nodeTypes, document.edges);

  // slot 身份在创建/planner 阶段生成并持久化（change: 2026-10-07-remove-residual-compatibility）：
  // 读取/normalize 不再按 sourceNodeId/sortKey 重建或补齐 slot 身份。

  // 视频编辑 intent 安全收敛（change: port-video-editing-dialogs，design D4/D6）：
  // 丢弃危险/非法 intent（含 data URL / object URL / 临时签名 URL），只保留稳定身份。
  applyVideoEditIntentSanitizer(nodeData);
  // 片场内部内容收敛（change: 2026-10-08-make-film-set-model-only）：
  // 缺失字段保持缺失（旧片场为空集合，不在此补写）；非法集合按空集合丢弃，绝不写入部分内容。
  applyFilmSetContentSanitizer(nodeData, nodeTypes, options?.content);
  applyFilmSetGroupSanitizer(nodeData, nodeTypes, options?.content);
  // Missing resources remain represented by bindings and retry diagnostics.
  // Existing foreign references still cannot grant group capabilities.
  for (const node of document.nodes) {
    if (node.type !== "group") continue;
    const marker = decodeFilmSetGroupMarker(nodeData[node.id]?.[FILM_SET_GROUP_FIELD]);
    if (!marker.ok) continue;
    const validation = validateFilmSetGroupBindings({
      id: input.id,
      title: input.title,
      revision: input.revision,
      updatedAt: input.updatedAt,
      document,
      nodeData,
      assets,
      jobs: Array.isArray(input.jobs) ? input.jobs : []
    }, node.id, marker.value, new Set(marker.value.sceneBindings.map(binding => binding.sourceNodeId)));
    if (validation) delete nodeData[node.id]![FILM_SET_GROUP_FIELD];
  }
  // 导演场更名（change: 2026-10-10-add-game-furnace-extension，design D1）：
  // 只把「系统创建且未被用户改写」的旧默认标题幂等更新为新展示名；自定义标题原样保留。
  migrateDirectorStudioLegacyTitle(nodeData, nodeTypes);

  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : DEFAULT_CANVAS_TITLE;
  return { ...input, title, document, nodeData, assets, jobs: Array.isArray(input.jobs) ? input.jobs : [] };
}

/**
 * Film-set group state is an explicit capability. Invalid markers are removed
 * as a unit so a normal group can never be accidentally treated as a film set,
 * while a legacy composite remains available to the read-only migration path.
 */
function normalizedClaimedNodeData(data: CanvasNodeData, content: ContentContributionResolver): CanvasNodeData | undefined {
  for (const contribution of content.implementations()) {
    const codec = contribution.nodeData;
    if (!codec?.schemaVersion || typeof codec.schemaVersion(data) !== "number") continue;
    try {
      const normalized = codec.normalize(structuredClone(data));
      if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return data;
      return normalized as CanvasNodeData;
    } catch {
      return data;
    }
  }
  return undefined;
}

function applyFilmSetGroupSanitizer(
  nodeData: Record<string, CanvasNodeData>,
  nodeTypes: Map<string, string>,
  content?: ContentContributionResolver
): void {
  for (const [nodeId, stored] of Object.entries(nodeData)) {
    let data = stored;
    if (content && data) {
      const migrated = migrateContentNodeData(data, content);
      if (migrated.readOnly) continue;
      if (migrated.data !== data && migrated.data && typeof migrated.data === "object") {
        data = migrated.data as CanvasNodeData;
        nodeData[nodeId] = data;
      }
    }
    if (!data || data[FILM_SET_GROUP_FIELD] === undefined) continue;
    if (nodeTypes.get(nodeId) !== "group") {
      delete data[FILM_SET_GROUP_FIELD];
      continue;
    }
    const owned = content ? normalizedClaimedNodeData(data, content) : undefined;
    if (owned) {
      nodeData[nodeId] = owned;
      continue;
    }
    const decoded = decodeFilmSetGroupMarker(data[FILM_SET_GROUP_FIELD]);
    if (!decoded.ok) {
      delete data[FILM_SET_GROUP_FIELD];
      continue;
    }
    (data as Record<string, unknown>)[FILM_SET_GROUP_FIELD] = decoded.value;
  }
}

function normalizeNodeType(
  node: Woohaa3CanvasDocument["nodes"][number],
  extraNodeTypes?: readonly string[]
): Woohaa3CanvasDocument["nodes"][number] {
  if (
    (WOOHAA3_APP_NODE_TYPES as readonly string[]).includes(node.type)
    || node.type === "group"
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
 * 片场内部内容收敛（change: 2026-10-08-make-film-set-model-only，design D3；
 * change: 2026-10-11-extract-film-set-extension D5/D11）。
 *
 * 严格按业务身份处理：
 * - 片场业务（`composite-asset` + `extensionId="film-set"`）：合法集合写回规范化值，非法集合删除字段；
 * - 未知/不可用业务（缺失/未知 `extensionId` 的复合资产）**保留原数据与引用**，不做删除或改写，
 *   以便停用/未注册业务的已保存内容不丢失；静态展示不等于业务授权。
 * 非复合资产节点出现的同名字段被清除，避免任意 opaque state 通过未识别字段进入持久层。
 */
function applyFilmSetContentSanitizer(
  nodeData: Record<string, CanvasNodeData>,
  nodeTypes: Map<string, string>,
  content?: ContentContributionResolver
): void {
  for (const [nodeId, data] of Object.entries(nodeData)) {
    if (!data) continue;
    const type = nodeTypes.get(nodeId);
    if (content && isCompositeAssetNodeType(type)) {
      nodeData[nodeId] = normalizeContentNodeData(data, content);
      continue;
    }
    if (data[FILM_SET_CONTENT_FIELD] === undefined) continue;
    // 未知/不可用业务的合法原数据必须保留（不删引用、不改写）。
    if (isCompositeAssetNodeType(type) && readCompositeAssetExtensionId(data) === null) continue;
    if (!isFilmSetNode(type, data)) {
      delete data[FILM_SET_CONTENT_FIELD];
      continue;
    }
    const result = decodeFilmSetContent(data[FILM_SET_CONTENT_FIELD]);
    if (result.ok) {
      data[FILM_SET_CONTENT_FIELD] = result.value as unknown as CanvasNodeData[string];
    } else {
      delete data[FILM_SET_CONTENT_FIELD];
    }
  }
}

/**
 * 导演场旧默认标题幂等迁移（change: 2026-10-10-add-game-furnace-extension，design D1）。
 *
 * 只对 `animation3d` 节点、且标题与旧系统默认标题逐字相等时改写为新默认标题。用户手动输入的
 * 其它标题（含同样被改成「导演场」的自定义名）不会因此被再次改写，因此迁移幂等：
 * 第二次加载时标题已经是新默认标题，不再匹配旧值。
 */
function migrateDirectorStudioLegacyTitle(
  nodeData: Record<string, CanvasNodeData>,
  nodeTypes: Map<string, string>
): void {
  for (const [nodeId, data] of Object.entries(nodeData)) {
    if (!data || data.title !== LEGACY_ANIMATION_DEFAULT_TITLE) continue;
    if (!isFilmSetNode(nodeTypes.get(nodeId), data)) continue;
    data.title = DIRECTOR_STUDIO_DEFAULT_TITLE;
  }
}

/**
 * 清除片场相关 inputMapping（change: 2026-10-08-make-film-set-model-only，design D8）。
 *
 * 片场不能作为边端点，因此既清除片场自身的输入 mapping，也清除其他节点中「来源是片场」的
 * mapping。只删相关项、保留其他合法 mapping；无匹配时为 no-op（幂等）。真正的 mapping 生命周期
 * 收敛仍由 `reconcileInputMappings` 在批末完成。
 */
function cleanFilmSetInputMappings(
  nodeData: Record<string, CanvasNodeData>,
  filmSetIds: ReadonlySet<string>
): void {
  if (filmSetIds.size === 0) return;
  for (const [nodeId, data] of Object.entries(nodeData)) {
    const mappings = data?.inputMapping;
    if (!Array.isArray(mappings) || mappings.length === 0) continue;
    if (filmSetIds.has(nodeId)) {
      delete data.inputMapping;
      continue;
    }
    const filtered = mappings.filter((mapping) => !filmSetIds.has(mapping.sourceNodeId));
    if (filtered.length === mappings.length) continue;
    if (filtered.length > 0) data.inputMapping = filtered;
    else delete data.inputMapping;
  }
}

/**
 * 清除拍摄镜头预览相关的 inputMapping（change: 2026-10-15 D2；任务 8.1 修订）。
 *
 * 预览不是普通资产：清除预览自身上的输入 mapping，也清除其他节点「来源是预览」的 mapping。
 * **例外**：目标为视频生成节点且角色为 `shot_reference` 的专用镜头参考保留（D9）。只删相关项、
 * 保留其他合法 mapping；无匹配时为 no-op（幂等）。归属数据本身**不**在此删除，避免把非法状态
 * 自动「修复」成看似合法。
 */
function cleanShotPreviewInputMappings(
  nodeData: Record<string, CanvasNodeData>,
  nodeTypes: ReadonlyMap<string, string>,
  edges: readonly Woohaa3CanvasEdge[]
): void {
  const previewIds = new Set(
    [...nodeTypes.entries()].filter(([id, type]) => isShotPreviewNode(type, nodeData[id])).map(([id]) => id)
  );
  if (previewIds.size === 0) return;
  for (const [nodeId, data] of Object.entries(nodeData)) {
    const mappings = data?.inputMapping;
    if (!Array.isArray(mappings) || mappings.length === 0) continue;
    if (previewIds.has(nodeId)) {
      delete data.inputMapping;
      continue;
    }
    const filtered = mappings.filter((mapping) => {
      if (!previewIds.has(mapping.sourceNodeId)) return true;
      const source = resolveShotReferenceSource(mapping.sourceNodeId, nodeData[mapping.sourceNodeId], id => nodeData[id]);
      return source && mapping.role === shotReferenceRoleForKind(source.kind)
        && edges.some(edge => edge.source === mapping.sourceNodeId && edge.target === nodeId);
    });
    if (filtered.length === mappings.length) continue;
    if (filtered.length > 0) data.inputMapping = filtered;
    else delete data.inputMapping;
  }
}
