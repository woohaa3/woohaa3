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
import { canvasPointToGround, createHighEntropyId, decodeSceneAreaData, managedNodeRelationOf, newWorldInstance, remapWorldCopyReferences, sceneAreaAnimationOrigin, type ManagedNodeLifecycleResolver } from "@woohaa3/contracts";
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
  lifecycle?: ManagedNodeLifecycleResolver;
  payload: CanvasCopyPayload;
  anchor: PasteAnchor;
  /** 当前本地视口（视口是各浏览器本地状态，不在规范画布内）。 */
  viewport: { x: number; y: number; zoom: number };
  /** 生成稳定 ID；测试可注入确定性实现。 */
  createId?: (prefix: string, index: number) => string;
  /**
   * 调用方已确认**无法**在目标画布解析的工程对象 storageKey
   * （编辑扩展工作区，任务 2.4）。
   *
   * 未授权/对象缺失的跨画布复制必须在这里显式列出：命中即拒绝整次粘贴，不写悬空引用。
   */
  unverifiedProjectObjects?: readonly string[];
  onRefusal?: (message: string) => void;
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
  if (refusal) { options.onRefusal?.(refusal.message); return null; }

  const makeId = options.createId ?? defaultPasteId;

  // 1. 预分配新 ID（载荷顺序稳定 ⇒ 重复粘贴生成不同新 ID）。
  const idMap = new Map<string, string>();
  payload.nodes.forEach((node, index) => {
    idMap.set(node.id, makeId(node.type, index));
  });

  // Trusted extensions remap their business entities and content references.
  const remappedData = new Map<string, import("@woohaa3/contracts").CanvasNodeData>();
  try {
    for (const adapter of options.lifecycle?.implementations() ?? []) {
      for (const entry of adapter.remapCopy?.({ nodes: payload.nodes, nodeData: payload.nodeData, nodeIds: new Map(idMap), createId: makeId }) ?? []) {
        if (!idMap.has(entry.sourceNodeId) || remappedData.has(entry.sourceNodeId)) return null;
        idMap.set(entry.sourceNodeId, entry.nodeId);
        remappedData.set(entry.sourceNodeId, entry.data);
      }
    }
  } catch { return null; }
  // Missing extension support is explicit: never create a partial owner closure.
  for (const node of payload.nodes) {
    const relation = managedNodeRelationOf(payload.nodeData[node.id]);
    if (relation && (!idMap.has(relation.ownerNodeId) || !remappedData.has(node.id))) return null;
  }
  if (new Set(idMap.values()).size !== idMap.size) return null;

  const instanceIds = new Map<string, string>();
  const groupIds = new Map<string, string>();
  const areaIds = new Map<string, string>();
  const cameraIds = new Map<string, string>();
  for (const [index, node] of payload.nodes.entries()) {
    const data = remappedData.get(node.id) ?? payload.nodeData[node.id];
    for (const [key, field, table] of [
      ["sharedWorldInstance", "instanceId", instanceIds], ["workflowGroup2d", "groupId", groupIds],
      ["sceneArea", "areaId", areaIds], ["worldCamera", "cameraId", cameraIds]
    ] as const) {
      const value = data?.[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const id = (value as Record<string, unknown>)[field];
        if (typeof id === "string") table.set(id, makeId(field, index));
      }
    }
  }
  const world = remapWorldCopyReferences({
    nodes: payload.nodes.map(node => ({ nodeId: node.id, nodeData: remappedData.get(node.id) ?? payload.nodeData[node.id] })),
    ids: { nodeIds: idMap, instanceIds, groupIds, areaIds, cameraIds }
  });
  if (!world.ok) {
    options.onRefusal?.(world.code === "binding-unavailable"
      ? world.field === "memberNodeIds"
        ? `组成员 ${world.reference?.id ?? ""} 不在复制集合中，请将缺失成员一起复制后重试。`
        : world.field === "animation.tracks.instanceId" || world.field === "animationScript.instanceTracks"
          ? `动画对象 ${world.reference?.id ?? ""} 不在复制集合中，请将动画对象一起复制后重试。`
          : world.field === "animationScript.cameraTracks"
            ? `动画镜头 ${world.reference?.id ?? ""} 不在复制集合中，请将动画镜头一起复制后重试。`
        : "绑定的模型不在复制集合中，请将目标模型一起复制后重试。"
      : "复制内容无效，无法粘贴。请检查选择后重试。");
    return null;
  }
  for (const [index, entry] of world.nodes.entries()) {
    if (!entry.worldKind) continue;
    const data = entry.nodeData;
    for (const key of ["workflowGroup2d", "sceneArea"] as const) {
      const value = data[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        (value as Record<string, unknown>).scopeVersion = makeId("scopeVersion", index);
      }
    }
    remappedData.set(entry.sourceNodeId, data as import("@woohaa3/contracts").CanvasNodeData);
  }

  // 2. 计算包围盒中心，用于对齐锚点。
  //    包围盒与偏移都必须在**绝对坐标**下计算：成员节点保存的是相对父级的局部坐标，
  //    直接对它们加偏移会把子树整体推走（change: add-canvas-node-grouping，design D6）。
  //    预览节点排在源节点之后：`node.add` 校验源片场已存在（design D2/D3）。
  const placed = toAbsoluteNodes(payload.nodes, payload.nodeData);
  // 每个节点换算到**载荷根坐标系**再算包围盒：group 成员的 `position` 是相对父级的局部坐标，
  // 与 group 自身的画布坐标混在一个包围盒里会把中心算到组外，粘贴落点随之偏离鼠标
  // （change: add-canvas-node-grouping，design D6）。
  const bounds = boundingBox(placed.map((entry) => ({ position: entry.absolute, width: entry.node.width, height: entry.node.height })));
  const anchor = resolveAnchorPosition(options.anchor, options.viewport);
  const dx = anchor.x - (bounds.minX + bounds.maxX) / 2;
  const dy = anchor.y - (bounds.minY + bounds.maxY) / 2;
  const groundDelta = canvasPointToGround({ x: dx, y: dy });

  const commands: CanvasCommand[] = [];
  for (const asset of payload.assets ?? []) {
    const existing = canvas.assets.find(a => a.id === asset.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(asset)) return null;
    if (!existing) commands.push({ type: "asset.upsert", asset });
  }
  const newNodeIds: string[] = [];

  // 3. node.add creates root nodes, so flatten the accepted source parent chain
  //    into canvas coordinates before applying the shared translation.
  //    扩展重映射的数据随 node.add 一起提交，可信生命周期复核完整闭包。
  for (const [index, { node, absolute }] of placed.entries()) {
    const newId = idMap.get(node.id);
    if (newId === undefined) continue;
    newNodeIds.push(newId);
    let mappedData = remappedData.get(node.id);
    if (node.type === "model3d") {
      const source = mappedData ?? payload.nodeData[node.id] ?? {};
      const existing = source.sharedWorldInstance as ReturnType<typeof newWorldInstance> | undefined;
      const placedInstance = newWorldInstance(existing?.instanceId ?? makeId("instanceId", index), { x: absolute.x + dx, y: absolute.y + dy });
      if (existing) {
        placedInstance.transform = {
          ...existing.transform,
          position: {
            u: existing.transform.position.u + groundDelta.u,
            v: existing.transform.position.v + groundDelta.v,
            h: existing.transform.position.h
          }
        };
      }
      mappedData = { ...source, sharedWorldInstance: placedInstance };
      remappedData.set(node.id, mappedData);
    } else if (node.type === "scene-area") {
      const source = mappedData ?? payload.nodeData[node.id] ?? {};
      const area = decodeSceneAreaData(source.sceneArea);
      if (!area.ok) return null;
      const origin = sceneAreaAnimationOrigin(area.value);
      mappedData = { ...source, sceneArea: {
        ...area.value,
        bounds: {
          min: { u: area.value.bounds.min.u + groundDelta.u, v: area.value.bounds.min.v + groundDelta.v },
          max: { u: area.value.bounds.max.u + groundDelta.u, v: area.value.bounds.max.v + groundDelta.v }
        },
        // Position tracks are relative to the area origin; moving the copy's
        // origin carries the whole authored shot without rewriting the script.
        animationOrigin: { u: origin.u + groundDelta.u, v: origin.v + groundDelta.v }
      } };
      remappedData.set(node.id, mappedData);
    }
    commands.push({
      type: "node.add",
      node: {
        id: newId,
        type: node.type,
        ...(node.position ? { position: { x: absolute.x + dx, y: absolute.y + dy } } : {}),
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
        ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {})
      },
      ...(mappedData ? { nodeData: mappedData } : {})
    });
  }

  // 4. nodeData：清理后的用户配置。放在节点之后，保证 node 存在。
  //    扩展重映射的数据已随 node.add 写入，其它配置保持通用 patch 语义。
  for (const node of payload.nodes) {
    if (remappedData.has(node.id)) continue;
    const data = payload.nodeData[node.id];
    if (!data || Object.keys(data).length === 0) continue;
    const newId = idMap.get(node.id);
    if (newId === undefined) continue;
    const remapped = data;
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

function boundingBox(nodes: readonly {
  position: Woohaa3CanvasPosition;
  width?: number;
  height?: number;
}[]): {
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

function orderParentsFirst(nodes: readonly CopyNode[], nodeData: CanvasCopyPayload["nodeData"]): CopyNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: CopyNode[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: CopyNode): void => {
    if (done.has(node.id) || visiting.has(node.id)) return;
    visiting.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) visit(parent);
    const relation = managedNodeRelationOf(nodeData[node.id]);
    const owner = relation ? byId.get(relation.ownerNodeId) : undefined;
    if (owner) visit(owner);
    visiting.delete(node.id);
    done.add(node.id);
    result.push(node);
  };
  for (const node of nodes) visit(node);
  return result;
}

/**
 * 把载荷节点按父级优先排序，标注是否顶层（顶层才承载整体平移），并给出
 * **载荷根坐标系**下的位置（change: add-canvas-node-grouping，design D6）。
 *
 * 成员节点保存的是相对 parent 的局部坐标，平移必须只作用于顶层，
 * 否则嵌套子树会被偏移两次。父级先于子级输出，保证服务端 `node.add` 时 parent 已存在。
 *
 * `absolute` 只用于计算包围盒：它沿载荷内的 parent 链累加偏移。父级不在载荷内时
 * （例如单独复制组内成员）保持该节点自身的局部坐标——那一帧里所有节点仍然一致，
 * 对齐锚点后依然落在正确位置。
 */
function toAbsoluteNodes(nodes: readonly CopyNode[], nodeData: CanvasCopyPayload["nodeData"]): Array<{
  node: CopyNode;
  isTopLevel: boolean;
  absolute: Woohaa3CanvasPosition;
}> {
  const included = new Set(nodes.map((node) => node.id));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const absolutePosition = (node: CopyNode): Woohaa3CanvasPosition => {
    let x = node.position?.x ?? 0;
    let y = node.position?.y ?? 0;
    const guard = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId && !guard.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent?.position) break;
      guard.add(parentId);
      x += parent.position.x;
      y += parent.position.y;
      parentId = parent.parentId;
    }
    return { x, y };
  };
  return orderParentsFirst(nodes, nodeData).map((node) => ({
    node,
    // parent 不在载荷内（被过滤）时该节点退化为顶层，需要承载平移。
    isTopLevel: node.parentId === undefined || !included.has(node.parentId),
    absolute: absolutePosition(node)
  }));
}

function cloneJson(value: Woohaa3CanvasJsonObject): Woohaa3CanvasJsonObject {
  return JSON.parse(JSON.stringify(value)) as Woohaa3CanvasJsonObject;
}

