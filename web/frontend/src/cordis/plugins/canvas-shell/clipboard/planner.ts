/**
 * 粘贴规划器（change: align-godot-canvas-interactions，任务 4.3 / 4.4 / design D6）。
 *
 * 纯步骤：
 * 1. 为全部节点和边预分配新 ID；
 * 2. 重写 parent、内部边和**仍然有效**的入边引用；
 * 3. 以锚点逻辑位置为中心摆放（缺失时用视口中心）；
 * 4. 生成按依赖排序的 `node.add` / `nodeData.patch` / `edge.add` 命令。
 *
 * 输出是**一个** `CanvasCommand[]`，由调用方作为一个服务端批次原子提交。这里不做任何
 * 本地 Store/Y.Doc 更新，也不做 optimistic 状态。
 */
import type { CanvasCommand, ServerCanvas, Woohaa3CanvasJsonObject, Woohaa3CanvasPosition } from "@woohaa3/contracts";
import { createHighEntropyId, remapFilmSetItemIds, decodeFilmSetNodeData, canonicalFilmSetFields, canonicalShotPreviewFields, filmSetAnimationsOf, cloneFilmSetAnimations, LEGACY_FILM_SET_ANIMATION_FIELDS, isFilmSetNode, shotPreviewNodeId, shotPreviewOwnershipOf, SHOT_PREVIEW_SCHEMA_VERSION, FILM_SET_SHOT_PREVIEW_NODE_TYPE } from "@woohaa3/contracts";
import type { CanvasCopyPayload, CopyNode } from "./payload.js";
import { imageEditAssetIdsOf, imageEditProjectObjectOf } from "./payload.js";

export type PastePlan = {
  /** 按依赖排序的服务端命令。 */
  commands: CanvasCommand[];
  /** 新节点 ID（按载荷顺序）。 */
  newNodeIds: string[];
  /** 新边 ID。 */
  newEdgeIds: string[];
  /** 包围盒中心最终对齐的逻辑点。 */
  anchor: Woohaa3CanvasPosition;
};

export type PasteAnchor =
  | { kind: "point"; position: Woohaa3CanvasPosition }
  | { kind: "viewport-center"; hostSize: { width: number; height: number } }
  | null;

export type PlanPasteOptions = {
  /** 当前规范画布（用于过滤失效入边）。 */
  canvas: ServerCanvas;
  payload: CanvasCopyPayload;
  anchor: PasteAnchor;
  /** 当前本地视口（视口是各浏览器本地状态，不在规范画布内）。 */
  viewport: { x: number; y: number; zoom: number };
  /** 生成稳定 ID；测试可注入确定性实现。 */
  createId?: (prefix: string, index: number) => string;
  /**
   * 调用方已确认**无法**在目标画布解析的工程对象 storageKey
   * （change: 2026-10-16-integrate-photocraft-image-editing，任务 2.4）。
   *
   * 未授权/对象缺失的跨画布复制必须在这里显式列出：命中即拒绝整次粘贴，不写悬空引用。
   */
  unverifiedProjectObjects?: readonly string[];
};

/** 粘贴拒绝原因（供 UI 显示明确原因，而不是静默无操作）。 */
export type PasteRefusal = {
  code: "project-object-unverified" | "project-reference-missing";
  message: string;
};

/**
 * 粘贴前的引用完整性检查（纯函数，无 I/O）。
 *
 * 工程图片节点自带基线与来源资产引用；复制到别的画布时这些资产必须**一并**带过去或在
 * 目标画布已存在，工程对象本身也必须可解析。任一缺失即拒绝，避免产生跨画布悬空引用与
 * 「看起来能编辑、实际打不开」的工程节点。
 */
export function checkPasteReferences(options: {
  canvas: ServerCanvas;
  payload: CanvasCopyPayload;
  unverifiedProjectObjects?: readonly string[];
}): PasteRefusal | null {
  const { canvas, payload } = options;
  const unverified = new Set(options.unverifiedProjectObjects ?? []);
  const carried = new Set((payload.assets ?? []).map((asset) => asset.id));
  for (const asset of canvas.assets) carried.add(asset.id);

  for (const node of payload.nodes) {
    const data = payload.nodeData[node.id];
    if (!data) continue;
    const projectObject = imageEditProjectObjectOf(data);
    if (projectObject && unverified.has(projectObject.storageKey)) {
      return {
        code: "project-object-unverified",
        message: "工程对象在目标画布不可用，复制已取消"
      };
    }
    const required = imageEditAssetIdsOf(data);
    if (node.type === "image" && typeof data.outputAssetId === "string" && data.outputAssetId !== "") {
      required.push(data.outputAssetId);
    }
    const missing = required.filter((id) => !carried.has(id));
    if (missing.length > 0) {
      return {
        code: "project-reference-missing",
        message: `图片编辑引用的资产无法一并复制：${missing.join("、")}`
      };
    }
  }
  return null;
}

/**
 * 模块级单调计数 + 高熵后缀，保证同一毫秒内重复粘贴也生成互不冲突的 ID。
 */
let pasteSequence = 0;

function defaultPasteId(prefix: string, index: number): string {
  pasteSequence += 1;
  return `${createHighEntropyId(prefix)}-${pasteSequence.toString(36)}-${index}`;
}

/**
 * 规划一次粘贴。返回 `null` 表示载荷在目标画布中无法形成任何有效实体
 * （例如所有入边都悬空、节点为空）——此时调用方应作为无操作处理，不提交空批次。
 */
export function planCanvasPaste(options: PlanPasteOptions): PastePlan | null {
  const { canvas, payload } = options;
  if (payload.nodes.length === 0) return null;
  // 引用不完整时整次拒绝：宁可无操作，也不写入跨画布悬空引用（任务 2.4）。
  const refusal = checkPasteReferences({
    canvas,
    payload,
    ...(options.unverifiedProjectObjects ? { unverifiedProjectObjects: options.unverifiedProjectObjects } : {})
  });
  if (refusal) return null;

  const makeId = options.createId ?? defaultPasteId;

  // 1. 预分配新 ID（载荷顺序稳定 ⇒ 重复粘贴生成不同新 ID）。
  const idMap = new Map<string, string>();
  payload.nodes.forEach((node, index) => {
    idMap.set(node.id, makeId(node.type, index));
  });

  // 1b. 片场内部 clipId 映射与预览**派生身份**重算
  //     （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 5.5 / design D2/D3）。
  //     clipId 映射先算一次并复用：nodeData 重写与预览归属必须落到同一份新 clipId，且不得重复
  //     调用 makeId（默认实现会推进模块级序列，重复调用会产生不同 ID）。
  const filmSetClipIds = new Map<string, Map<string, string>>();
  for (const node of payload.nodes) {
    const data = payload.nodeData[node.id];
    if (!data || !isFilmSetNode(node.type, data)) continue;
    const decoded = decodeFilmSetNodeData(data);
    if (!decoded.ok) continue;
    const clips = filmSetAnimationsOf(decoded.value).clips;
    filmSetClipIds.set(node.id, new Map(clips.map((clip, index) => [clip.id, makeId("clip", index)])));
  }
  // 预览节点 ID 是 (filmSetNodeId, clipId) 的纯派生值：粘贴后所属片场与镜头都是新 ID，
  // 必须重算节点 ID 与归属。源片场不在载荷内（不应发生）时丢弃该预览，不产生悬空归属。
  const precomputedPreviewData = new Map<string, import("@woohaa3/contracts").CanvasNodeData>();
  for (const node of payload.nodes) {
    const ownership = shotPreviewOwnershipOf(payload.nodeData[node.id]);
    if (!ownership) continue;
    const newOwner = idMap.get(ownership.filmSetNodeId);
    const newClipId = filmSetClipIds.get(ownership.filmSetNodeId)?.get(ownership.clipId);
    if (!newOwner || !newClipId) {
      idMap.delete(node.id);
      continue;
    }
    idMap.set(node.id, shotPreviewNodeId(newOwner, newClipId));
    const fields = canonicalShotPreviewFields({
      shotPreview: { schemaVersion: SHOT_PREVIEW_SCHEMA_VERSION, filmSetNodeId: newOwner, clipId: newClipId }
    }) as import("@woohaa3/contracts").CanvasNodeData;
    precomputedPreviewData.set(node.id, fields);
  }

  // 2. 计算包围盒中心，用于对齐锚点。
  //    包围盒与偏移都必须在**绝对坐标**下计算：成员节点保存的是相对父级的局部坐标，
  //    直接对它们加偏移会把子树整体推走（change: add-canvas-node-grouping，design D6）。
  //    预览节点排在源节点之后：`node.add` 校验源片场已存在（design D2/D3）。
  const orderedNodes = [
    ...payload.nodes.filter((node) => node.type !== FILM_SET_SHOT_PREVIEW_NODE_TYPE),
    ...payload.nodes.filter((node) => node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE)
  ];
  const absolute = toAbsoluteNodes(orderedNodes);
  const bounds = boundingBox(absolute.map((entry) => entry.node));
  const anchor = resolveAnchorPosition(options.anchor, options.viewport);
  const dx = anchor.x - (bounds.minX + bounds.maxX) / 2;
  const dy = anchor.y - (bounds.minY + bounds.maxY) / 2;

  const commands: CanvasCommand[] = [];
  for (const asset of payload.assets ?? []) {
    const existing = canvas.assets.find(a => a.id === asset.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(asset)) return null;
    if (!existing) commands.push({ type: "asset.upsert", asset });
  }
  const newNodeIds: string[] = [];

  // 3. 节点：parent 重写为新 ID；只有**顶层节点**承载整体平移，成员保持相对坐标。
  //    父节点先于子节点输出（拓扑排序），保证服务端 applyCommand 时 parent 存在。
  //    预览节点的归属必须在**同一条** `node.add` 内携带：`nodeData.patch` 对携带 `shotPreview`
  //    的值一律拒绝（归属只能随源生命周期变化，design D2）。
  for (const { node, isTopLevel } of absolute) {
    const newId = idMap.get(node.id);
    if (newId === undefined) continue;
    newNodeIds.push(newId);
    const previewData = precomputedPreviewData.get(node.id);
    commands.push({
      type: "node.add",
      node: {
        id: newId,
        type: node.type,
        position: isTopLevel
          ? { x: node.position.x + dx, y: node.position.y + dy }
          : { ...node.position },
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
        ...(node.parentId !== undefined && idMap.has(node.parentId)
          ? { parentId: idMap.get(node.parentId) }
          : {}),
        ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {})
      },
      ...(previewData ? { nodeData: previewData } : {})
    });
  }

  // 4. nodeData：清理后的用户配置。放在节点之后，保证 node 存在。
  //    片场（composite-asset）的内部对象与镜头 ID 按节点稳定重映射，媒体资产共享不复制
  //    （change: 2026-10-08-make-film-set-model-only，design D3）。
  //    预览节点的归属已随 `node.add` 写入，这里跳过。
  for (const node of payload.nodes) {
    if (node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE) continue;
    const data = payload.nodeData[node.id];
    if (!data || Object.keys(data).length === 0) continue;
    const newId = idMap.get(node.id);
    if (newId === undefined) continue;
    const remapped = isFilmSetNode(node.type, data) ? remapFilmSetNodeData(data, makeId, filmSetClipIds.get(node.id)) : data;
    if (!remapped) continue;
    commands.push({
      type: "nodeData.patch",
      nodeId: newId,
      value: remapped
    });
  }

  // 5. 内部边：两端都重写。
  const newEdgeIds: string[] = [];
  for (const edge of payload.edges) {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (!source || !target) continue;
    const newEdgeId = makeId("edge", newEdgeIds.length);
    newEdgeIds.push(newEdgeId);
    commands.push({
      type: "edge.add",
      edge: {
        id: newEdgeId,
        source,
        target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        ...(Object.keys(edge.data).length > 0 ? { data: cloneJson(edge.data) as Woohaa3CanvasJsonObject } : {})
      }
    });
  }

  // 6. 入边：只在源节点仍存在于**目标画布**时保留；否则过滤（不产生悬空边）。
  const existingNodeIds = new Set(canvas.document.nodes.map((node) => node.id));
  for (const edge of payload.incomingEdges) {
    if (!existingNodeIds.has(edge.source)) continue;
    const target = idMap.get(edge.target);
    if (!target) continue;
    const newEdgeId = makeId("edge", newEdgeIds.length);
    newEdgeIds.push(newEdgeId);
    commands.push({
      type: "edge.add",
      edge: {
        id: newEdgeId,
        source: edge.source,
        target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        ...(Object.keys(edge.data).length > 0 ? { data: cloneJson(edge.data) as Woohaa3CanvasJsonObject } : {})
      }
    });
  }

  if (newNodeIds.length === 0) return null;
  return { commands, newNodeIds, newEdgeIds, anchor };
}

function resolveAnchorPosition(
  anchor: PasteAnchor,
  viewport: { x: number; y: number; zoom: number }
): Woohaa3CanvasPosition {
  if (anchor && anchor.kind === "point") return anchor.position;
  const host = anchor && anchor.kind === "viewport-center"
    ? anchor.hostSize
    : { width: 0, height: 0 };
  // 屏幕中心 = logical*zoom + (x,y) ⇒ logical = (screen - (x,y)) / zoom。
  return {
    x: (host.width / 2 - viewport.x) / viewport.zoom,
    y: (host.height / 2 - viewport.y) / viewport.zoom
  };
}

function boundingBox(nodes: readonly CopyNode[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + (node.width ?? 0));
    maxY = Math.max(maxY, node.position.y + (node.height ?? 0));
  }
  return { minX, minY, maxX, maxY };
}

function orderParentsFirst(nodes: readonly CopyNode[]): CopyNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: CopyNode[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: CopyNode): void => {
    if (done.has(node.id) || visiting.has(node.id)) return;
    visiting.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) visit(parent);
    visiting.delete(node.id);
    done.add(node.id);
    result.push(node);
  };
  for (const node of nodes) visit(node);
  return result;
}

/**
 * 把载荷节点按父级优先排序，并标注是否顶层（顶层才承载整体平移）
 * （change: add-canvas-node-grouping，design D6）。
 *
 * 成员节点保存的是相对 parent 的局部坐标，平移必须只作用于顶层，
 * 否则嵌套子树会被偏移两次。父级先于子级输出，保证服务端 `node.add` 时 parent 已存在。
 */
function toAbsoluteNodes(nodes: readonly CopyNode[]): Array<{ node: CopyNode; isTopLevel: boolean }> {
  const included = new Set(nodes.map((node) => node.id));
  return orderParentsFirst(nodes).map((node) => ({
    node,
    // parent 不在载荷内（被过滤）时该节点退化为顶层，需要承载平移。
    isTopLevel: node.parentId === undefined || !included.has(node.parentId)
  }));
}

function cloneJson(value: Woohaa3CanvasJsonObject): Woohaa3CanvasJsonObject {
  return JSON.parse(JSON.stringify(value)) as Woohaa3CanvasJsonObject;
}

/**
 * 重写片场 nodeData 的内部对象与镜头 ID（复制片场语义，change design D3）。
 *
 * 媒体资产共享不复制；只分配新的内部对象 ID 与新的 clipId，保持来源引用（assetId）不变。
 * `clipIds` 由调用方预分配并复用：预览节点归属必须落到**同一份**新 clipId，因此这里不能重复
 * 调用 `makeId`（默认实现会推进模块级序列）。内容非法时返回 `null`（调用方跳过该 nodeData，
 * 不写入部分/悬空内容）。
 */
function remapFilmSetNodeData(
  data: Woohaa3CanvasJsonObject,
  makeId: (prefix: string, index: number) => string,
  clipIds: Map<string, string> | undefined
): Woohaa3CanvasJsonObject | null {
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok) return null;
  if (!clipIds) return null;
  const itemIds = new Map(decoded.value.filmSetContent.items.map((item, index) => [item.id, makeId("film-object", index)]));
  const content = remapFilmSetItemIds(decoded.value.filmSetContent, item => itemIds.get(item.id)!);
  const collection = cloneFilmSetAnimations(filmSetAnimationsOf(decoded.value));
  collection.defaultClipId = collection.defaultClipId ? clipIds.get(collection.defaultClipId)! : null;
  for (const clip of collection.clips) {
    clip.id = clipIds.get(clip.id)!;
    for (const binding of clip.bindings) binding.itemId = itemIds.get(binding.itemId)!;
  }
  const shared = { ...data };
  for (const field of LEGACY_FILM_SET_ANIMATION_FIELDS) delete shared[field];
  return { ...shared, ...canonicalFilmSetFields({ ...decoded.value, filmSetContent: content, filmSetAnimations: collection }) } as Woohaa3CanvasJsonObject;
}
