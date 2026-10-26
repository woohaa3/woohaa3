/**
 * 节点剪贴板可移植载荷（change: align-godot-canvas-interactions，任务 4.1）。
 *
 * Web 从当前规范 ServerCanvas 生成 `infinspire-canvas-copy-v1` JSON，**不**序列化运行时
 * 对象、不复制投影缓存里的旧业务字段。载荷包含：
 * - 选中节点及其**后代**（parentId 链）；
 * - 选区**内部边**（两端都在集合内）；
 * - 可在目标画布中继续成立的**入边描述**（源节点仍在目标画布时的依赖）；
 * - 经过复制策略清理的 nodeData（删除任务运行态与本机路径，见 contracts）。
 *
 * 纯 JSON、确定性排序，方便往返测试。
 */
import type { ServerCanvas, Woohaa3CanvasJsonObject, Woohaa3CanvasPosition, Woohaa3CanvasSerializedNode } from "@woohaa3/contracts";
import {
  decodeImageEditDocument,
  filmSetObjectOwnershipOf, filmSetObjectModelNodeId,
  filmSetAssetReferences,
  isImageProjectDocument, decodeFilmSetNodeData, model3DNodeDataFields,
  readFilmSetContent,
  sanitizeNodeDataForClipboard,
  type ImageEditProjectObjectRef,
  type StoredAsset
} from "@woohaa3/contracts";
import { managedNodeRelationOf } from "@woohaa3/contracts";

export const CANVAS_COPY_FORMAT = "infinspire-canvas-copy-v1";

/** 载荷里的结构节点：只保留可移植结构字段。 */
export type CopyNode = {
  id: string;
  type: string;
  position: Woohaa3CanvasPosition;
  width?: number;
  height?: number;
  parentId?: string;
  zIndex?: number;
};

export type CopyEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data: Woohaa3CanvasJsonObject;
};

/** 入边描述：源节点在粘贴目标画布中不存在时由 planner 过滤。 */
export type CopyIncomingEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data: Woohaa3CanvasJsonObject;
};

export type CanvasCopyPayload = {
  format: typeof CANVAS_COPY_FORMAT;
  sourceCanvasId?: string;
  assets?: StoredAsset[];
  /**
   * 复制携带的图片工程对象引用（去重；内容寻址，目标画布可继续解析）。
   * （编辑扩展工作区，任务 2.4）
   *
   * 只在载荷内含工程图片节点时出现。粘贴方据此确认工程对象可用；缺失时拒绝粘贴，
   * 不留下跨画布悬空引用。旧载荷（无此字段）保持可解析。
   */
  projectObjects?: ImageEditProjectObjectRef[];
  nodes: CopyNode[];
  /** 选区内部边（两端都在 nodes 内）。 */
  edges: CopyEdge[];
  /** 选区边界上的入边（源在选区外）。 */
  incomingEdges: CopyIncomingEdge[];
  nodeData: Record<string, Woohaa3CanvasJsonObject>;
};

/**
 * 从规范画布与选择集合构造复制载荷。
 *
 * 选择集合会被扩展为「选中节点 + 其后代」；pipeline 后续不会再读取画布，因此载荷
 * 自带完整结构。返回 `null` 表示选择为空或全部失效。
 */
export function buildCanvasCopyPayload(
  canvas: ServerCanvas,
  selectedNodeIds: readonly string[],
  options: { snapshotNodeIds?: readonly string[] } = {}
): CanvasCopyPayload | null {
  const nodes = canvas.document.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const validSelected = [...new Set(selectedNodeIds)].filter((id) => byId.has(id));
  if (validSelected.length === 0) return null;

  const included = new Set<string>(validSelected);
  // 扩展后代：父节点被复制时其子树一起复制，否则粘贴后 parentId 悬空。
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (node.parentId && included.has(node.parentId) && !included.has(node.id)) {
        included.add(node.id);
        grew = true;
      }
    }
  }

  // Owner closures are relation-driven, independent of media provider identity.
  const previewOwnerByNode = new Map<string, string>();
  for (const node of nodes) {
    const object = filmSetObjectOwnershipOf(canvas.nodeData[node.id]);
    if (object) { previewOwnerByNode.set(node.id, object.filmSetNodeId); continue; }
    const managed = managedNodeRelationOf(canvas.nodeData[node.id]);
    if (managed) { previewOwnerByNode.set(node.id, managed.ownerNodeId); continue; }
  }
  let closureGrew = true;
  while (closureGrew) {
    closureGrew = false;
    for (const node of nodes) {
      const owner = previewOwnerByNode.get(node.id);
      if (owner && included.has(owner) && !included.has(node.id)) { included.add(node.id); closureGrew = true; }
    }
  }
  for (const id of [...included]) {
    const owner = previewOwnerByNode.get(id);
    // 对象容器可以在所属片场未被选中时物化为独立 model3d；拍摄镜头预览仍必须丢弃。
    const isObjectContainer = !!filmSetObjectOwnershipOf(canvas.nodeData[id]);
    const isManagedMedia = !!managedNodeRelationOf(canvas.nodeData[id]);
    if (owner && !included.has(owner) && !isObjectContainer && !isManagedMedia) included.delete(id);
  }
  // 单独选择外层容器时只复制其真实 model3d 子节点；容器自身不参与复制。
  for (const id of validSelected) {
    const node = byId.get(id);
    const owner = filmSetObjectOwnershipOf(canvas.nodeData[id]);
    if (node?.type !== "composite-asset" || !owner || included.has(owner.filmSetNodeId)) continue;
    if (included.has(filmSetObjectModelNodeId(owner.filmSetNodeId, owner.itemId))) included.delete(id);
  }

  if (included.size === 0) return null;

  // 单独复制片场对象容器时，将当前对象模型物化为普通 model3d 快照。
  // 容器仍然是片场生命周期里的 composite-asset；只有在复制闭包不包含所属片场时，
  // 才切断归属并把当下的模型内容写进载荷，保证粘贴结果不再依赖源片场。
  const materializedModelData = new Map<string, Woohaa3CanvasJsonObject>();
  const materializedNodeIds = new Set<string>();
  for (const node of nodes) {
    if (!included.has(node.id)) continue;
    const ownership = filmSetObjectOwnershipOf(canvas.nodeData[node.id]);
    if (!ownership || included.has(ownership.filmSetNodeId)) continue;
    const ownerData = canvas.nodeData[ownership.filmSetNodeId];
    const decoded = decodeFilmSetNodeData(ownerData);
    if (!decoded.ok) continue;
    const item = decoded.value.filmSetContent.items.find(candidate => candidate.id === ownership.itemId);
    if (!item || item.kind !== "model") {
      // 空容器没有可独立复制的内容；从选区中移除，避免产生悬空容器。
      included.delete(node.id);
      continue;
    }
    materializedNodeIds.add(node.id);
    materializedModelData.set(node.id, JSON.parse(JSON.stringify(model3DNodeDataFields({
      kind: "model3d", title: item.name, model: item.model
    }))) as Woohaa3CanvasJsonObject);
  }
  if (included.size === 0) return null;
  const copyNodes: CopyNode[] = nodes
    .filter((node) => included.has(node.id))
    .map(node => ({ ...toCopyNode(node), ...(materializedNodeIds.has(node.id) ? { type: "model3d" } : {}) }));

  const copyEdges: CopyEdge[] = [];
  const incomingEdges: CopyIncomingEdge[] = [];
  for (const edge of canvas.document.edges) {
    const sourceIn = included.has(edge.source);
    const targetIn = included.has(edge.target);
    if (sourceIn && targetIn) {
      copyEdges.push(toCopyEdge(edge));
    } else if (targetIn && !sourceIn) {
      incomingEdges.push({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        data: { ...edge.data }
      });
    }
  }

  const rawNodeData = canvas.nodeData as Record<string, Woohaa3CanvasJsonObject | undefined>;
  const nodeData: Record<string, Woohaa3CanvasJsonObject> = {};
  const assetsById = new Map(canvas.assets.map((asset) => [asset.id, asset]));
  const nodeTypeById = new Map(nodes.map((node) => [node.id, node.type]));
  for (const id of [...included].sort()) {
    const raw = rawNodeData[id];
    const cleaned = materializedModelData.get(id) ?? sanitizeNodeDataForClipboard(raw ?? {});
    // A standalone provider-backed media copy is a frozen ordinary node. Keep
    // the source reference for the async snapshot path, but never paste the
    // extension lifecycle lock into another canvas.
    const relation = managedNodeRelationOf(cleaned);
    if (cleaned.mediaContent && relation && !included.has(relation.ownerNodeId)) delete cleaned.managedBy;
    restoreContentReferences(raw, cleaned, nodeTypeById.get(id), assetsById, options.snapshotNodeIds?.includes(id) ?? false);
    if (Object.keys(cleaned).length > 0) nodeData[id] = cleaned;
  }

  // 引用收集：片场内部对象引用（既有）之外，媒体节点的稳定内容引用也必须一并携带。
  // 上传的图片/视频/音频节点把内容存在 `outputAssetId`（清理器已按内容语义保留），
  // 若只把指针留在 nodeData 而不带资产，粘贴到别的画布就会得到「有引用、没有图」的节点
  // （change: fix-copy-keeps-node-media）。
  const referencedAssetIds = new Set<string>(filmSetReferenceIdsOf(nodeData));
  const projectObjects = new Map<string, ImageEditProjectObjectRef>();
  for (const node of copyNodes) {
    const data = nodeData[node.id];
    if (!data) continue;
    for (const assetId of imageEditAssetIdsOf(data)) referencedAssetIds.add(assetId);
    // 内容引用与视频封面：只带指针不带资产会得到「有引用、没有图」的节点。
    for (const field of ["outputAssetId", "posterAssetId"] as const) {
      const assetId = data[field];
      if (typeof assetId === "string" && assetId !== "") referencedAssetIds.add(assetId);
    }
    const projectObject = imageEditProjectObjectOf(data);
    if (projectObject) projectObjects.set(projectObject.storageKey, projectObject);
  }

  return {
    format: CANVAS_COPY_FORMAT,
    ...(projectObjects.size > 0 ? { sourceCanvasId: canvas.id } : {}),
    assets: canvas.assets.filter(asset => referencedAssetIds.has(asset.id)),
    ...(projectObjects.size > 0 ? { projectObjects: [...projectObjects.values()] } : {}),
    nodes: copyNodes,
    edges: copyEdges,
    incomingEdges,
    nodeData
  };
}

/**
 * 恢复节点内容的稳定媒体引用（change: fix-copy-keeps-node-media）。
 *
 * `sanitizeNodeDataForClipboard` 保守地删除 `outputAssetId`，但它对上传素材是**唯一内容引用**：
 * 上传节点的 nodeData 只有 `title`/`outputAssetId`/`resourceKind`/`taskStatus`，剪掉后就得到
 * 一个没有图的空节点（复制图片/视频/音频必然丢内容）。
 *
 * 判定只依赖可核对的事实，不猜语义：
 * - 资产必须在**来源画布**中存在且 `ready`；
 * - 资产 `source` 为 `uploaded`（用户素材本身即内容）或 `external`（稳定外部引用）；
 *   生成结果的资产是 `generated`，仍按任务结果指针剪除；
 * - 资产 `mediaKind` 必须与节点类型匹配，避免把结果图挂到文本节点上。
 *
 * 资产会随载荷的 `assets` 一并携带，因此目标画布可解析该引用。
 */
function restoreContentReferences(
  raw: Woohaa3CanvasJsonObject | undefined,
  cleaned: Woohaa3CanvasJsonObject,
  nodeType: string | undefined,
  assetsById: ReadonlyMap<string, StoredAsset>,
  providerSnapshot = false
): void {
  // 带编辑定义/工程版本的图片节点：`outputAssetId` 是版本的一部分（工程与 PNG 成对）。
  const hasImageEdit = raw !== undefined && decodeImageEditDocument(raw.imageEdit).ok;
  const outputAssetId = raw?.outputAssetId;
  if (typeof outputAssetId !== "string" || outputAssetId === "") return;
  if (hasImageEdit) {
    if (cleaned.outputAssetId === undefined) cleaned.outputAssetId = outputAssetId;
    return;
  }
  if (!nodeType) return;
  const asset = assetsById.get(outputAssetId);
  if (!asset || asset.status !== "ready") return;
  // A confirmed provider snapshot is content even when its immutable asset was
  // generated. It is no longer a task-result pointer on the copied node.
  if (!providerSnapshot && asset.source !== "uploaded" && asset.source !== "external") return;
  if (asset.mediaKind !== nodeType) return;
  cleaned.outputAssetId = outputAssetId;
  // 上传节点的就绪状态同样属于「节点可用」的一部分（服务端上传路径写入 successed）。
  // 只补回任务成功的终态，不复制进行中/失败态。
  if (cleaned.taskStatus === undefined && raw?.taskStatus === "successed") {
    cleaned.taskStatus = "successed";
  }
  if (cleaned.resourceKind === undefined && typeof raw?.resourceKind === "string") {
    cleaned.resourceKind = raw.resourceKind;
  }
}

function filmSetReferenceIdsOf(nodeData: Record<string, Woohaa3CanvasJsonObject>): string[] {  const ids = new Set<string>();
  for (const data of Object.values(nodeData)) {
    for (const assetId of filmSetAssetReferences(readFilmSetContent(data))) ids.add(assetId);
  }
  return [...ids];
}

/** 图片编辑定义引用的稳定资产 id（工程分支含全部来源资产）。 */
export function imageEditAssetIdsOf(data: Woohaa3CanvasJsonObject | undefined): string[] {
  const decoded = decodeImageEditDocument(data?.imageEdit);
  if (!decoded.ok) return [];
  const ids = new Set<string>([decoded.value.baseAssetId]);
  if (isImageProjectDocument(decoded.value)) {
    for (const id of decoded.value.sourceAssetIds) ids.add(id);
  }
  return [...ids];
}

/** 图片编辑定义携带的工程对象引用（非工程分支为 `null`）。 */
export function imageEditProjectObjectOf(data: Woohaa3CanvasJsonObject | undefined): ImageEditProjectObjectRef | null {
  const decoded = decodeImageEditDocument(data?.imageEdit);
  if (!decoded.ok || !isImageProjectDocument(decoded.value)) return null;
  return decoded.value.project;
}

export function serializeCanvasCopyPayload(payload: CanvasCopyPayload): string {
  return JSON.stringify(payload);
}

/**
 * 解析并校验剪贴板载荷。只接受 `infinspire-canvas-copy-v1`；普通文本或未知 JSON
 * 返回 `null`（粘贴为无操作，不创建节点）。
 */
export function parseCanvasCopyPayload(input: string | null | undefined): CanvasCopyPayload | null {
  if (!input) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    return null;
  }
  return isCanvasCopyPayload(raw) ? raw : null;
}

export function isCanvasCopyPayload(input: unknown): input is CanvasCopyPayload {
  if (!isRecord(input)) return false;
  if (input.format !== CANVAS_COPY_FORMAT) return false;
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges) || !Array.isArray(input.incomingEdges)) {
    return false;
  }
  if (!isRecord(input.nodeData)) return false;
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (!isRecord(node) || typeof node.id !== "string" || node.id === "") return false;
    if (typeof node.type !== "string" || node.type === "") return false;
    if (!isPosition(node.position)) return false;
    nodeIds.add(node.id);
  }
  for (const edge of input.edges) {
    if (!isRecord(edge) || typeof edge.id !== "string" || edge.id === "") return false;
    if (typeof edge.source !== "string" || typeof edge.target !== "string") return false;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false;
  }
  for (const edge of input.incomingEdges) {
    if (!isRecord(edge) || typeof edge.source !== "string" || typeof edge.target !== "string") return false;
    if (!nodeIds.has(edge.target)) return false;
  }
  // 工程对象引用可选（旧载荷没有）；存在时逐字段校验，不接受的形状整条拒绝。
  if (input.sourceCanvasId !== undefined && (typeof input.sourceCanvasId !== "string" || !input.sourceCanvasId || input.sourceCanvasId.length > 512)) return false;
  if (input.projectObjects !== undefined) {
    if (!Array.isArray(input.projectObjects)) return false;
    for (const ref of input.projectObjects) {
      if (!isProjectObjectRef(ref)) return false;
    }
  }
  return true;
}

function isProjectObjectRef(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return (
    typeof input.storageKey === "string" && input.storageKey !== "" &&
    typeof input.checksum === "string" && input.checksum !== "" &&
    typeof input.contentType === "string" && input.contentType !== "" &&
    typeof input.size === "number" && Number.isFinite(input.size) && input.size >= 0
  );
}

function toCopyNode(node: Woohaa3CanvasSerializedNode): CopyNode {
  return {
    id: node.id,
    type: node.type,
    position: { ...node.position },
    ...(node.width !== undefined ? { width: node.width } : {}),
    ...(node.height !== undefined ? { height: node.height } : {}),
    ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
    ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {})
  };
}

function toCopyEdge(edge: ServerCanvas["document"]["edges"][number]): CopyEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    data: { ...edge.data }
  };
}

function isPosition(input: unknown): input is Woohaa3CanvasPosition {
  return isRecord(input) && typeof input.x === "number" && typeof input.y === "number";
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
