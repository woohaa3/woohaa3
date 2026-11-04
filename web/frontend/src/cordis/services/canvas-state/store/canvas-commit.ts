/**
 * 画布提交边界（任务 2.5 / design.md D4）。
 *
 * 规范画布的唯一写入口。所有变更——节点、边、nodeData、assets、jobs、viewpoint——
 * 都经过 `commitCanvas`，由它在一次提交内同时更新 `document`、`nodeData`、
 * `assets`、`jobs`、`revision` 与 `updatedAt`。返回 `changed: false` 时不递增 revision，
 * 避免无操作提交制造 revision 抖动。
 */
import { DEFAULT_NODE_DIMS, collectWoohaa3CanvasRemovalIds, createWoohaa3CanvasEdge, fromWoohaa3CanvasDocument, isValidWoohaa3CanvasConnection, nextWoohaa3CanvasNodeZIndex, toWoohaa3CanvasDocument, type CanvasNodeData, type ServerCanvas, type StoredAsset, type StoredJob, type Woohaa3CanvasEdge, type Woohaa3CanvasJsonObject, type Woohaa3CanvasNode, type Woohaa3CanvasPosition, type Woohaa3CanvasSnapshot } from "@woohaa3/contracts";

export type CanvasCommitRejectionCode =
  | "unknown-node"
  | "unknown-edge"
  | "invalid-edge-endpoint"
  | "invalid-parent"
  | "node-data-orphan"
  | "invalid-connection";

export type CanvasCommitRejection = {
  code: CanvasCommitRejectionCode;
  message: string;
};

export type CanvasCommitPatch = {
  nodes?: readonly Woohaa3CanvasNode[];
  edges?: readonly Woohaa3CanvasEdge[];
  /**
   * nodeData 的增量补丁。值为 `null` 表示删除该键；键必须指向补丁生效后的节点，
   * 否则整次提交被拒绝（拒绝时规范画布完全不变）。
   */
  nodeData?: Readonly<Record<string, CanvasNodeData | null>>;
  assets?: readonly StoredAsset[];
  jobs?: readonly StoredJob[];
};

export type CanvasCommitResult =
  | { ok: true; canvas: ServerCanvas; changed: boolean }
  | { ok: false; rejection: CanvasCommitRejection };

export type CanvasCommitOptions = {
  now?: string;
};

/** 规范聚合的渲染器投影。渲染快照与增量 diff 都从这里出发。 */
export function canvasGraphOf(canvas: ServerCanvas): Woohaa3CanvasSnapshot {
  return fromWoohaa3CanvasDocument(canvas.document);
}

/** 提交一次规范变更。任何校验失败都不改变输入聚合。 */
export function commitCanvas(
  canvas: ServerCanvas,
  patch: CanvasCommitPatch,
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  const now = options.now ?? new Date().toISOString();
  const current = canvasGraphOf(canvas);

  const nodes = [...(patch.nodes ?? current.nodes)];
  const edges = [...(patch.edges ?? current.edges)];
  const nodeIds = new Set(nodes.map((node) => node.id));

  for (const node of nodes) {
    if (node.parentId !== undefined && !nodeIds.has(node.parentId)) {
      return reject("invalid-parent", `节点 ${node.id} 的父节点 ${node.parentId} 不存在`);
    }
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return reject(
        "invalid-edge-endpoint",
        `边 ${edge.id} 的端点不存在：${edge.source} -> ${edge.target}`
      );
    }
  }

  const nodeData = pruneNodeData(
    canvas.nodeData as Record<string, CanvasNodeData>,
    nodeIds
  );
  if (patch.nodeData) {
    for (const [nodeId, value] of Object.entries(patch.nodeData)) {
      if (value === null) {
        // 删除键永远合法：同一提交内被删除的节点必然不在 nodeIds 里，
        // 允许它清理自己的 nodeData，否则「删除节点」这条路径无法自洽。
        delete nodeData[nodeId];
        continue;
      }
      if (!nodeIds.has(nodeId)) {
        return reject("node-data-orphan", `节点业务数据指向不存在的节点 ${nodeId}`);
      }
      nodeData[nodeId] = { ...(nodeData[nodeId] ?? {}), ...value };
    }
  }

  const assets = patch.assets ? [...patch.assets] : canvas.assets;
  const jobs = patch.jobs ? [...patch.jobs] : canvas.jobs;

  const document = toWoohaa3CanvasDocument({ nodes, edges }, now);
  const unchanged = isSameCommittedState(canvas, { document, nodeData, assets, jobs });

  if (unchanged) return { ok: true, canvas, changed: false };

  return {
    ok: true,
    changed: true,
    canvas: {
      ...canvas,
      revision: canvas.revision + 1,
      document,
      nodeData: nodeData as ServerCanvas["nodeData"],
      assets,
      jobs,
      updatedAt: now
    }
  };
}

/** 新增节点（不指定 zIndex 时取当前最高层 + 1），并可选写入初始 nodeData。 */
export function addCanvasNode(
  canvas: ServerCanvas,
  node: Woohaa3CanvasNode,
  nodeData?: CanvasNodeData,
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  const graph = canvasGraphOf(canvas);
  if (graph.nodes.some((entry) => entry.id === node.id)) {
    return reject("unknown-node", `节点 ${node.id} 已存在`);
  }
  const nextNode: Woohaa3CanvasNode = {
    ...node,
    width: node.width ?? DEFAULT_NODE_DIMS.width,
    height: node.height ?? DEFAULT_NODE_DIMS.height,
    zIndex: typeof node.zIndex === "number" && Number.isFinite(node.zIndex)
      ? node.zIndex
      : nextWoohaa3CanvasNodeZIndex(graph.nodes)
  };
  return commitCanvas(
    canvas,
    {
      nodes: [...graph.nodes, nextNode],
      nodeData: nodeData ? { [node.id]: nodeData } : undefined
    },
    options
  );
}

/**
 * 在一次提交里新增节点**并**从已有节点连一条边过来。
 *
 * 「拉线创建」是一个用户动作，所以只递增一个 revision —— 否则运行时需要先拿到新节点的
 * 规范 ID 才能建边，而它无权生成规范 ID。
 */
export function addCanvasNodeConnected(
  canvas: ServerCanvas,
  request: {
    node: Woohaa3CanvasNode;
    nodeData?: CanvasNodeData;
    connectFromNodeId: string;
    connectLabel?: string;
  },
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  const graph = canvasGraphOf(canvas);
  const source = graph.nodes.find((node) => node.id === request.connectFromNodeId);
  if (!source) {
    return reject("unknown-node", `连线起点 ${request.connectFromNodeId} 不存在`);
  }
  if (graph.nodes.some((entry) => entry.id === request.node.id)) {
    return reject("unknown-node", `节点 ${request.node.id} 已存在`);
  }

  const nextNode: Woohaa3CanvasNode = {
    ...request.node,
    width: request.node.width ?? DEFAULT_NODE_DIMS.width,
    height: request.node.height ?? DEFAULT_NODE_DIMS.height,
    zIndex: typeof request.node.zIndex === "number" && Number.isFinite(request.node.zIndex)
      ? request.node.zIndex
      : nextWoohaa3CanvasNodeZIndex(graph.nodes)
  };
  const nodes = [...graph.nodes, nextNode];

  const candidate = {
    source: source.id,
    target: nextNode.id,
    sourceHandle: null,
    targetHandle: null
  };
  // 连接判定需要目标 nodeData（镜头参考判定读取 taskKind 等）；新节点数据尚未入画布，合并请求携带值。
  const connectData = {
    get: (id: string) => (id === nextNode.id ? (request.nodeData as Record<string, unknown> | undefined) : (canvas.nodeData[id] as Record<string, unknown> | undefined))
  };
  if (!isValidWoohaa3CanvasConnection(candidate, nodes, graph.edges, connectData)) {
    return reject("invalid-connection", `${source.type} -> ${nextNode.type} 不是合法连线`);
  }
  const generated = createWoohaa3CanvasEdge(candidate, nodes);
  if (!generated) {
    return reject("invalid-connection", `无法为 ${source.id} -> ${nextNode.id} 创建边`);
  }
  const edge = {
    ...generated,
    data: {
      ...generated.data,
      ...(request.connectLabel ? { label: request.connectLabel } : {})
    }
  };

  return commitCanvas(
    canvas,
    {
      nodes,
      edges: [...graph.edges, edge],
      nodeData: request.nodeData ? { [nextNode.id]: request.nodeData } : undefined
    },
    options
  );
}

/**
 * 提交拖拽结束时的最终逻辑坐标。
 *
 * 请求里出现未知节点时**整体拒绝**而不是静默忽略：桥接层需要把「基于过期投影的变更」
 * 变成可诊断的拒绝结果（`canvas-sync` spec 的运行时非法变更约束）。
 */
export function moveCanvasNodes(
  canvas: ServerCanvas,
  positions: Readonly<Record<string, Woohaa3CanvasPosition>>,
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  const graph = canvasGraphOf(canvas);
  const knownIds = new Set(graph.nodes.map((node) => node.id));
  const unknown = Object.keys(positions).filter((nodeId) => !knownIds.has(nodeId));
  if (unknown.length > 0) {
    return reject("unknown-node", `移动了不存在的节点：${unknown.join(", ")}`);
  }
  const nodes = graph.nodes.map((node) => {
    const position = positions[node.id];
    return position ? { ...node, position } : node;
  });
  return commitCanvas(canvas, { nodes }, options);
}

/** 删除节点及其后代、关联边与 nodeData。 */
export function deleteCanvasNodes(
  canvas: ServerCanvas,
  nodeIds: readonly string[],
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  const graph = canvasGraphOf(canvas);
  const removalIds = collectWoohaa3CanvasRemovalIds(graph.nodes, [...nodeIds], canvas.nodeData);
  if (removalIds.size === 0) return { ok: true, canvas, changed: false };
  return commitCanvas(
    canvas,
    {
      nodes: graph.nodes.filter((node) => !removalIds.has(node.id)),
      edges: graph.edges.filter(
        (edge) => !removalIds.has(edge.source) && !removalIds.has(edge.target)
      ),
      nodeData: Object.fromEntries([...removalIds].map((id) => [id, null]))
    },
    options
  );
}

/**
 * 连接两个节点。连线合法性与边结构（handle 规则、边 `data.kind`）复用 domain 的规则，
 * 调用方只负责提供端点与可选稳定 id。
 */
export function connectCanvasEdge(
  canvas: ServerCanvas,
  connection: {
    id?: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
    /** 额外边数据，必须是纯 JSON；会覆盖 domain 生成的 `data.kind`。 */
    data?: Woohaa3CanvasJsonObject;
  },
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  const graph = canvasGraphOf(canvas);
  if (
    !graph.nodes.some((node) => node.id === connection.source)
    || !graph.nodes.some((node) => node.id === connection.target)
  ) {
    return reject(
      "unknown-node",
      `连线端点不存在：${connection.source} -> ${connection.target}`
    );
  }

  const candidate = {
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle ?? null,
    targetHandle: connection.targetHandle ?? null
  };
  const connectionData = { get: (id: string) => canvas.nodeData[id] as Record<string, unknown> | undefined };
  if (!isValidWoohaa3CanvasConnection(candidate, graph.nodes, graph.edges, connectionData)) {
    return reject(
      "invalid-connection",
      `${connection.source} -> ${connection.target} 不是合法连线（端点相同、重复连线或不满足 handle 规则）`
    );
  }

  const generated = createWoohaa3CanvasEdge(candidate, graph.nodes);
  if (!generated) {
    return reject("invalid-connection", `无法为 ${connection.source} -> ${connection.target} 创建边`);
  }
  const edge = {
    ...generated,
    // 调用方提供 id 时优先使用：桥接命令需要可重放的稳定 id，而不是时间戳生成值。
    id: connection.id ?? generated.id,
    data: connection.data ? { ...generated.data, ...connection.data } : generated.data
  };
  if (graph.edges.some((entry) => entry.id === edge.id)) {
    return reject("unknown-edge", `边 ${edge.id} 已存在`);
  }
  return commitCanvas(canvas, { edges: [...graph.edges, edge] }, options);
}

/** 断开一条已知的边。未知 edgeId 被拒绝，规范画布不变。 */
export function disconnectCanvasEdge(
  canvas: ServerCanvas,
  edgeId: string,
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  const graph = canvasGraphOf(canvas);
  if (!graph.edges.some((edge) => edge.id === edgeId)) {
    return reject("unknown-edge", `边 ${edgeId} 不存在`);
  }
  return commitCanvas(
    canvas,
    { edges: graph.edges.filter((edge) => edge.id !== edgeId) },
    options
  );
}

/** 合并更新某个节点的业务数据。 */
export function patchCanvasNodeData(
  canvas: ServerCanvas,
  nodeId: string,
  patch: CanvasNodeData,
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  const graph = canvasGraphOf(canvas);
  if (!graph.nodes.some((node) => node.id === nodeId)) {
    return reject("unknown-node", `节点 ${nodeId} 不存在`);
  }
  return commitCanvas(canvas, { nodeData: { [nodeId]: patch } }, options);
}

/** 替换资产集合。二进制不在这里，只写元数据。 */
export function setCanvasAssets(
  canvas: ServerCanvas,
  assets: readonly StoredAsset[],
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  return commitCanvas(canvas, { assets }, options);
}

/** 替换任务记录集合。 */
export function setCanvasJobs(
  canvas: ServerCanvas,
  jobs: readonly StoredJob[],
  options: CanvasCommitOptions = {}
): CanvasCommitResult {
  return commitCanvas(canvas, { jobs }, options);
}

function pruneNodeData(
  nodeData: Record<string, CanvasNodeData>,
  nodeIds: ReadonlySet<string>
): Record<string, CanvasNodeData> {
  const next: Record<string, CanvasNodeData> = {};
  for (const [nodeId, data] of Object.entries(nodeData)) {
    if (nodeIds.has(nodeId)) next[nodeId] = data;
  }
  return next;
}

function isSameCommittedState(
  canvas: ServerCanvas,
  next: {
    document: ServerCanvas["document"];
    nodeData: Record<string, CanvasNodeData>;
    assets: readonly StoredAsset[];
    jobs: readonly StoredJob[];
  }
): boolean {
  return JSON.stringify({
    nodes: canvas.document.nodes,
    edges: canvas.document.edges,
    nodeData: canvas.nodeData,
    assets: canvas.assets,
    jobs: canvas.jobs
  }) === JSON.stringify({
    nodes: next.document.nodes,
    edges: next.document.edges,
    nodeData: next.nodeData,
    assets: next.assets,
    jobs: next.jobs
  });
}

function reject(code: CanvasCommitRejectionCode, message: string): CanvasCommitResult {
  return { ok: false, rejection: { code, message } };
}
