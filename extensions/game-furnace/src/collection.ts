/**
 * 游戏炼丹炉 extension 前端素材收集（纯规划）
 * （change: 2026-10-10-add-game-furnace-extension，任务 4.2–4.8 / design D2/D3/D4）。
 *
 * 本模块只做纯素材规划/文件分类/稳定上传校验与内容契约转出；真正的原子提交经宿主注入的
 * Canvas Session / Canvas 权威边界完成，不含后端代码或凭据。
 *
 * 按 integration 新架构重实现：真正的可信前端入口 `descriptor`（`src/frontend/index.ts`）随后续
 * 阶段（聚焦工作区/菜单贡献）落地——`activation: "server-active"` 的站点扩展在服务端插件装载时
 * 才由 reconciler 装配，避免现在就发布一个空 plugin。
 *
 * 原实现的容器 guest WASM 炉体渲染依赖已被移除的 `container-render/v1` ABI；新架构下炉体几何
 * 走宿主通用 3D 呈现路径（见 port-plan.md 阶段 2），本文件不再加载任何 WASM。
 */
import {
  describeCanvasSource,
  COMPOSITE_ASSET_NODE_TYPE, FILM_SET_EXTENSION_ID, GAME_FURNACE_EXTENSION_ID, readCompositeAssetExtensionId,
  fnv1a64Hex,
  expandSelectionWithGroups,
  type CanvasMediaKind,
  type ServerCanvas,
  type StoredAsset,
  type Woohaa3CanvasJsonObject,
  type Woohaa3CanvasNode
} from "@woohaa3/contracts";
import {
  DEFAULT_CATEGORY_BY_KIND,
  GAME_FURNACE_LABEL,
  GAME_FURNACE_PLUGIN_ID,
  MAX_INLINE_SNAPSHOT_CHARS,
  MAX_INLINE_TEXT_CHARS,
  MAX_NAME_LENGTH,
  defaultResourceDescription,
  gameFurnaceContent,
  type GameResource,
  type GameResourceInput,
  type GameResourceKind,
  type GameResourceMetadata,
  type GameResourcePayload,
  type GameResourceSource
} from "./shared.js";

export { GAME_FURNACE_PLUGIN_ID, GAME_FURNACE_LABEL, gameFurnaceContent };

/** 内容定义导出的公共面（供宿主与后端共享同一 identity）。 */
export const GAME_FURNACE_FRONTEND_DEFINITION = {
  pluginId: GAME_FURNACE_PLUGIN_ID,
  label: GAME_FURNACE_LABEL,
  content: gameFurnaceContent
} as const;

// ---------------------------------------------------------------------------
// 素材 drop 规划：任意类型 → 稳定快照 + 资源引用（design D4/D5）
// ---------------------------------------------------------------------------

const KIND_BY_NODE_TYPE: Readonly<Record<string, GameResourceKind>> = {
  image: "image",
  video: "video",
  audio: "audio",
  text: "text",
  model3d: "model"
};

/**
 * 按**完整身份**（type + extensionId）判别复合资产业务，而非把整个 `composite-asset` 类别
 * 都当成片场（D1/D11）。未知/缺失业务身份的复合资产归为 `unknown`，不误判为片场。
 */
function gameResourceKindForNode(node: SourceNode, data: Record<string, unknown>): GameResourceKind {
  const base = KIND_BY_NODE_TYPE[node.type];
  if (base !== undefined) return base;
  if (node.type !== COMPOSITE_ASSET_NODE_TYPE) return "unknown";
  const extensionId = readCompositeAssetExtensionId(data);
  if (extensionId === FILM_SET_EXTENSION_ID) return "film-set";
  if (extensionId === GAME_FURNACE_EXTENSION_ID) return "model";
  return "unknown";
}

type SourceNode = ServerCanvas["document"]["nodes"][number];

/** 一次收集规划：单个原子 `resources.add` 操作 + 来源规范快照（供权威边界重验）。 */
export type GameFurnaceDropPlan = {
  label: string;
  operations: Woohaa3CanvasJsonObject[];
  sourceSnapshots: { nodeId: string; data: Woohaa3CanvasJsonObject }[];
};

/**
 * 纯快照导入规划器：把来源节点集合展开为一批素材操作。整批原子；任一项无法解析时返回 null
 * （宿主拒绝整批，不静默只加入其他项）。来源身份与完整规范快照一起交给权威边界重验。
 *
 * - 多选内的 group 按稳定文档顺序递归展开为叶子；直接选中与经 group 选中重叠时去重。
 * - 仅含空结构组（无叶子）时返回 null，由宿主说明没有可收集内容。
 */
export function planGameFurnaceDrop(
  canvas: ServerCanvas,
  sourceNodeIds: readonly string[],
  collectionId?: string
): GameFurnaceDropPlan | null {
  const sources = expandGameFurnaceSources(canvas, sourceNodeIds);
  if (!sources) return null;
  const resources: GameResourceInput[] = [];
  const sourceSnapshots: { nodeId: string; data: Woohaa3CanvasJsonObject }[] = [];
  for (const node of sources) {
    const data = (canvas.nodeData[node.id] ?? {}) as Record<string, unknown>;
    const resource = resourceFromNode(canvas, node, data);
    if (!resource) return null;
    // A retry reuses its collection identity; a new gesture copies again.
    if (collectionId) resource.resourceId = `res-${fnv1a64Hex(JSON.stringify([collectionId, node.id]))}`;
    resources.push(resource);
    sourceSnapshots.push({ nodeId: node.id, data: structuredClone(data) as Woohaa3CanvasJsonObject });
  }
  if (resources.length === 0) return null;
  return {
    label: `收集 ${resources.length} 项素材`,
    operations: [{ type: "resources.add", resources } as unknown as Woohaa3CanvasJsonObject],
    sourceSnapshots
  };
}

/**
 * 展开一次 drop 的来源节点为按稳定顺序排列的叶子集合（任务 4.6）。
 *
 * - 相同来源 ID 按首次出现去重；
 * - group 递归展开为叶子（按 `parentId` 归属、按文档顺序访问）；
 * - 直接选中叶子与其所属 group 同时出现时去重；
 * - 任一来源 ID 不存在于文档时返回 `null`（整批拒绝，不静默跳过）。
 */
export function expandGameFurnaceSources(canvas: ServerCanvas, sourceNodeIds: readonly string[]): SourceNode[] | null {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of sourceNodeIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  const nodes: Woohaa3CanvasNode[] = canvas.document.nodes.map((node) => ({ ...node, data: {} }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const tops: Woohaa3CanvasNode[] = [];
  for (const id of ordered) {
    const node = byId.get(id);
    if (!node) return null;
    tops.push(node);
  }
  // group 递归展开为叶子；`seen` 保证重叠选择去重。空结构组不产出叶子。
  const expanded = expandSelectionWithGroups(tops, nodes);
  return expanded.map((node) => ({
    id: node.id,
    type: node.type,
    position: { ...node.position },
    ...(node.width !== undefined ? { width: node.width } : {}),
    ...(node.height !== undefined ? { height: node.height } : {}),
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {})
  }));
}

function resourceFromNode(canvas: ServerCanvas, node: SourceNode, data: Record<string, unknown>): GameResourceInput | null {
  const descriptor = describeCanvasSource(canvas, node.id);
  if (!descriptor) return null;
  const kind = gameResourceKindForNode(node, data);
  const title = typeof data.title === "string" && data.title.trim() !== "" ? data.title.trim() : DEFAULT_CATEGORY_BY_KIND[kind];
  const resourceId = `res-${node.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const assetIds: string[] = [];
  const metadata: GameResourceMetadata = {};
  let payload: GameResourcePayload;
  /** 是否存在工作区内可渲染的内联/媒体预览（供确定性默认描述，任务 4.9）。 */
  let hasPreview = false;

  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  const output = outputId ? canvas.assets.find((asset) => asset.id === outputId && asset.status === "ready") : undefined;

  if (kind === "image" || kind === "video" || kind === "audio") {
    if (!output || typeof output.metadata?.storageKey !== "string" || !output.metadata.storageKey) return null; // 未就绪媒体不作为可用游戏资源（design D4）。
    assetIds.push(output.id);
    if (typeof output.metadata?.storageKey === "string") metadata.storageKey = output.metadata.storageKey;
    if (typeof output.metadata?.contentType === "string") metadata.mime = output.metadata.contentType;
    if (typeof output.metadata?.size === "number") metadata.size = output.metadata.size;
    if (kind === "image") metadata.previewAssetId = output.id;
    payload = { kind: "asset", assetIds };
    hasPreview = true;
  } else if (kind === "text") {
    const text = typeof output?.text === "string" ? output.text : typeof data.prompt === "string" ? data.prompt : "";
    if (output) assetIds.push(output.id);
    // 规划阶段携带完整原件；权威重验后由后端转存，不能先丢掉全文。
    payload = { kind: "text", assetIds, snapshot: text.length > MAX_INLINE_TEXT_CHARS
      ? { text, overBudget: true, textChars: text.length }
      : { text } };
    hasPreview = true;
  } else if (kind === "model" || kind === "film-set") {
    const snapshot: Woohaa3CanvasJsonObject = {};
    // 片场业务必须保存**完整** items-only 定义（独立根 + 静态镜头 + items + 全部片段），
    // 否则收集后的权威重验/历史等价会丢根/镜头/片段（D7/D10/D11）。非片场仍按节点级模型字段。
    const sourceKeys = kind === "film-set"
      ? ["extensionId", "title", "scenePlacement", "sceneCamera", "filmSetContent", "filmSetAnimations", "origin"]
      : ["modelScript", "modelScriptLanguage", "modelScriptVersion", "modelContentVersion", "motionScript", "motionContentVersion", "initialCamera", "timeline", "modelPlacement", "scenePlacement", "extensionId"];
    for (const key of sourceKeys) {
      if (data[key] !== undefined) snapshot[key] = structuredClone(data[key]) as never;
    }
    // 完整模型/导演场源码保留在快照中；超过预算时同样完整保留原件并标记 `overBudget`，
    // UI/LLM 摘要明确标识，不把截断内容声称成完整定义（design D4/D7）。
    if (JSON.stringify(snapshot).length > MAX_INLINE_SNAPSHOT_CHARS) snapshot.overBudget = true;
    payload = { kind: kind === "film-set" ? "scene" : "model", assetIds: [...new Set(assetIds)], snapshot };
  } else {
    // 未来规范节点/未知类型：保存 JSON 兼容内容；无自动预览（design D4）。
    const unknownData = structuredClone(data) as never;
    const opaqueSnapshot: Woohaa3CanvasJsonObject = { unknownNodeType: node.type, nodeData: unknownData };
    if (JSON.stringify(opaqueSnapshot).length > MAX_INLINE_SNAPSHOT_CHARS) opaqueSnapshot.overBudget = true;
    payload = { kind: "opaque", assetIds: [], snapshot: opaqueSnapshot };
  }

  const dependencies: NonNullable<GameResourcePayload["assets"]> = [];
  for (const asset of descriptor.assets) {
    const storageKey = asset.metadata?.storageKey;
    if (typeof storageKey !== "string" || !storageKey) {
      if (asset.mediaKind === "text" && typeof asset.text === "string") continue;
      return null;
    }
    dependencies.push({ assetId: asset.id, storageKey,
      mime: typeof asset.metadata?.contentType === "string" ? asset.metadata.contentType : "application/octet-stream",
      ...(typeof asset.metadata?.size === "number" ? { size: asset.metadata.size } : {}) });
  }
  for (const storageKey of descriptor.mediaKeys) {
    if (!dependencies.some(asset => asset.storageKey === storageKey)) dependencies.push({ assetId: storageKey, storageKey, mime: "application/octet-stream" });
  }
  if (dependencies.length) payload = { ...payload,
    assetIds: [...new Set([...payload.assetIds, ...dependencies.map(asset => asset.assetId)])], assets: dependencies };

  // 确定性默认描述（任务 4.9）：只来自可信元数据/有界内容摘要，不调用收费分析、不猜测语义。
  const description = defaultResourceDescription({ kind, name: title, metadata, hasPreview });

  return {
    resourceId,
    kind,
    name: title,
    description,
    payload,
    source: { canvasId: canvas.id, nodeId: node.id, sourceContentHash: descriptor.contentHash },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {})
  };
}

/** 拒绝自身与自身所属组形成的循环（design D4）。 */
export function isSelfOrAncestorDrop(canvas: ServerCanvas, nodeId: string, sourceIds: readonly string[]): boolean {
  if (sourceIds.includes(nodeId)) return true;
  const nodes = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  for (const sourceId of sourceIds) {
    let current = nodes.get(sourceId);
    const guard = new Set<string>();
    while (current?.parentId && !guard.has(current.parentId)) {
      if (current.parentId === nodeId) return true;
      guard.add(current.parentId);
      current = nodes.get(current.parentId);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 文件导入（任务 4.7/4.9）：上传成功的稳定资产 → 素材操作
// ---------------------------------------------------------------------------

/** 与 Media 上传协议兼容的稳定资产三要素（不受信任输入，逐字段校验后使用）。 */
export type UploadedFileMedia = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  url?: string;
};

/** 素材类别 → 画布资产 `mediaKind`（受控映射；未知/参考类保留为通用 `file`）。 */
const MEDIA_KIND_BY_FURNACE_KIND: Readonly<Record<GameResourceKind, CanvasMediaKind>> = {
  image: "image",
  video: "video",
  audio: "audio",
  text: "text",
  model: "file",
  "film-set": "file",
  container: "file",
  unknown: "file"
};

/** 文件上传的进行态（仅工作区可见，不写入规范项目；任务 4.9）。 */
export type GameFurnaceUploadStage = "pending" | "uploading" | "done" | "failed";

/** 一个待导入/导入中的文件（本地 UI 状态，非规范素材）。 */
export type GameFurnaceUploadItem = {
  id: string;
  name: string;
  stage: GameFurnaceUploadStage;
  /** 0..100 上传进度（可用时）。 */
  progress?: number;
  /** 失败时的安全可读原因（不泄漏底层正文）。 */
  error?: string;
};

/** 上传进度/失败的可读文案；进行态与失败原因必须可见（spec「上传进度和失败 SHALL 可见」）。 */
export function uploadStatusLabel(item: GameFurnaceUploadItem): string {
  switch (item.stage) {
    case "pending":
      return `待上传${item.name ? `：${item.name}` : ""}`;
    case "uploading":
      return `上传中${typeof item.progress === "number" ? ` ${Math.max(0, Math.min(100, Math.round(item.progress)))}%` : ""}${item.name ? `：${item.name}` : ""}`;
    case "done":
      return `已添加${item.name ? `：${item.name}` : ""}`;
    case "failed":
      return `上传失败${item.name ? `：${item.name}` : ""}${item.error ? `（${item.error}）` : ""}`;
  }
}

/** 由文件元数据派生受支持的素材类别；无 decoder 的通用 MIME 归为 `unknown` 并保留原件。 */
export function resourceKindForUpload(file: { type?: string; name?: string }): { kind: GameResourceKind; category: string } {
  const mime = (file.type ?? "").toLowerCase();
  if (mime.startsWith("image/")) return { kind: "image", category: DEFAULT_CATEGORY_BY_KIND.image };
  if (mime.startsWith("video/")) return { kind: "video", category: DEFAULT_CATEGORY_BY_KIND.video };
  if (mime.startsWith("audio/")) return { kind: "audio", category: DEFAULT_CATEGORY_BY_KIND.audio };
  if (mime.startsWith("text/") || mime === "application/json" || mime === "text/markdown") return { kind: "text", category: DEFAULT_CATEGORY_BY_KIND.text };
  return { kind: "unknown", category: DEFAULT_CATEGORY_BY_KIND.unknown };
}

/** 确定性素材名称：优先用户文件名，缺失时回退默认分类（不猜测语义，任务 4.9）。 */
export function deriveResourceName(file: { name?: string }, kind: GameResourceKind): string {
  const name = typeof file.name === "string" ? file.name.trim() : "";
  return name !== "" ? name : DEFAULT_CATEGORY_BY_KIND[kind];
}

/**
 * 把一次成功上传的稳定字节构造为画布资产（内容寻址）。
 *
 * 只有拿到稳定 storageKey/checksum/contentType/size 且 `assetId` 合法时才返回；否则返回 `null`，
 * 调用方不得写入假 ready 项（spec「先保存稳定资产再关联项目」）。运行态失败不进入规范画布。
 */
export function stableAssetFromUpload(input: {
  assetId: string;
  file: { name?: string; type?: string; size?: number };
  media: UploadedFileMedia;
  now?: string;
}): StoredAsset | null {
  if (!isIdString(input.assetId)) return null;
  const stable = stableUploadMetadata(input.media);
  if (!stable) return null;
  const derived = resourceKindForUpload(input.file);
  const asset: StoredAsset = {
    id: input.assetId,
    title: deriveResourceName(input.file, derived.kind),
    mediaKind: MEDIA_KIND_BY_FURNACE_KIND[derived.kind],
    source: "uploaded",
    status: "ready",
    createdAt: input.now ?? new Date().toISOString(),
    url: typeof input.media.url === "string" && input.media.url !== "" ? input.media.url : `/api/media/${input.media.storageKey}`,
    metadata: { storageKey: input.media.storageKey, checksum: input.media.checksum, contentType: input.media.contentType, size: input.media.size }
  };
  return asset;
}

/**
 * 把一次成功上传的稳定资产转成待登记的素材输入（任务 4.7/4.9）。
 *
 * 只有拿到稳定 storageKey/checksum/contentType/size 后才允许调用；缺少稳定引用即返回 `null`，
 * 调用方不得写入假 ready 项（spec「文件收集 SHALL 先保存稳定资产再关联项目」）。
 *
 * `assetId` 是经宿主登记后的稳定资产 id；登记成功前不得调用（否则不写假关联）。
 * 默认描述只来自可信元数据（MIME/字节/是否可预览），不调用收费分析、不猜测语义（任务 4.9）。
 */
export function resourceFromUploadedFile(input: {
  resourceId: string;
  file: { name?: string; type?: string; size?: number };
  media: UploadedFileMedia;
  assetId: string;
  description?: string;
}): GameResourceInput | null {
  if (!isIdString(input.resourceId)) return null;
  if (!isIdString(input.assetId)) return null;
  const { media } = input;
  const stable = stableUploadMetadata(media);
  if (stable === null) return null;

  const derived = resourceKindForUpload(input.file);
  // Resource labels have a stricter bound than filenames. The asset title and
  // uploaded File retain the original name, so long files remain importable.
  const filename = deriveResourceName(input.file, derived.kind);
  const name = filename.length > MAX_NAME_LENGTH
    ? `${filename.slice(0, MAX_NAME_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, "")}…`
    : filename;
  const metadata: GameResourceMetadata = { mime: media.contentType, size: media.size, storageKey: media.storageKey };
  if (derived.kind === "image") metadata.previewAssetId = input.assetId;
  const hasPreview = derived.kind === "image" || derived.kind === "video" || derived.kind === "audio";

  return {
    resourceId: input.resourceId,
    kind: derived.kind,
    name,
    category: derived.category,
    description: input.description ?? defaultResourceDescription({ kind: derived.kind, name, metadata, hasPreview }),
    payload: { kind: derived.kind === "text" ? "text" : derived.kind === "unknown" ? "opaque" : "asset", assetIds: [input.assetId] },
    metadata
  };
}

/**
 * 上传完成后的原子登记规划（任务 4.7/4.9）：一个资产批次里先 `asset.upsert` 稳定资产，再
 * `resources.add` 关联素材。任一不稳定即返回 `null`，不产生部分状态。调用方经受保护会话提交。
 */
export function planUploadedResourceCollection(input: {
  resourceId: string;
  file: { name?: string; type?: string; size?: number };
  media: UploadedFileMedia;
  assetId: string;
  description?: string;
  now?: string;
}): { label: string; operations: Woohaa3CanvasJsonObject[] } | null {
  const resource = resourceFromUploadedFile(input);
  const asset = stableAssetFromUpload(input);
  if (!resource || !asset) return null;
  return {
    label: "添加文件素材",
    operations: [
      { type: "asset.upsert", asset } as unknown as Woohaa3CanvasJsonObject,
      { type: "resources.add", resources: [resource] } as unknown as Woohaa3CanvasJsonObject
    ]
  };
}

/** 从 Media 上传响应构造素材操作（`resources.add`），供工作区经宿主原子提交。 */
export function planFileCollection(input: {
  resourceId: string;
  file: { name?: string; type?: string; size?: number };
  media: UploadedFileMedia;
  assetId: string;
  description?: string;
}): { label: string; operations: Woohaa3CanvasJsonObject[] } | null {
  const resource = resourceFromUploadedFile(input);
  if (!resource) return null;
  return {
    label: "添加文件素材",
    operations: [{ type: "resources.add", resources: [resource] } as unknown as Woohaa3CanvasJsonObject]
  };
}

/** 稳定上传 URL 只在站内相对路径下可引用；其它来源拒绝（不保存只在其它浏览器有效的 URL）。 */
export function stableUploadMetadata(media: UploadedFileMedia): Record<string, unknown> | null {
  if (typeof media.storageKey !== "string" || media.storageKey === "") return null;
  if (typeof media.checksum !== "string" || media.checksum === "") return null;
  if (typeof media.contentType !== "string" || media.contentType === "") return null;
  if (typeof media.size !== "number" || !Number.isFinite(media.size) || media.size < 0) return null;
  return { storageKey: media.storageKey, checksum: media.checksum, contentType: media.contentType, size: media.size };
}

function isIdString(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export type { GameResource, GameResourceInput, GameResourceKind, GameResourcePayload, GameResourceSource };
