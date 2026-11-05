/**
 * 渲染器中立的画布命令规划器
 * （change: replace-godot-canvas-runtime-with-bevy，任务 5.1 / design D4；
 *  change: remove-canvas-groups-and-film-set —— 分组/片场规划器删除）。
 *
 * 从旧桥接的 `translateToCommands` 提取：把「用户意图」翻译成服务端 `CanvasCommand[]`。
 * 调用方（interaction controller）直接产出一批命令并交给 `CanvasSession.submitCommands`。
 *
 * 纯函数、无 DOM 依赖、不做任何本地 store 写入（规范状态只由服务端 Yjs update 回流）。
 */
import {
  bevyNodeSize,
  createHighEntropyId,
  createWoohaa3CanvasNodeId,
  isValidWoohaa3CanvasConnection,
  type CanvasCommand,
  type CanvasNodeData,
  type Woohaa3CanvasEdge,
  type Woohaa3CanvasJsonObject,
  type Woohaa3CanvasNode,
  type Woohaa3CanvasPosition
} from "@woohaa3/contracts";

export type InsertNodeIntent = {
  nodeType: string;
  /** 2D 卡片落点；导演区/共享世界模型没有卡片，省略。 */
  position?: Woohaa3CanvasPosition;
  width?: number;
  height?: number;
  nodeData?: CanvasNodeData;
  /** 显式节点 ID（change: add-paste-import-workflows，批量导入需要稳定回执）；缺省生成。 */
  nodeId?: string;
  /** 「拉线创建」：在同一次提交里从已有节点连一条边。 */
  connectFromNodeId?: string;
  connectLabel?: string;
};

export type ConnectEdgeIntent = {
  edgeId?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  data?: Woohaa3CanvasJsonObject;
};

export type NodeDataPatchIntent = {
  nodeId: string;
  value: CanvasNodeData;
};

/** 创建节点（可选连线）→ 服务端命令。 */
export function planInsertNode(intent: InsertNodeIntent): CanvasCommand[] {
  const id = intent.nodeId ?? createWoohaa3CanvasNodeId(intent.nodeType);
  // 普通模型使用内嵌预览卡片尺寸；复合资产矩形即内容框，用默认尺寸。
  const compactModelSize = intent.nodeType === "model3d"
    ? bevyNodeSize("image")
    : intent.nodeType === "composite-asset"
      ? { width: 260, height: 195 }
      : null;
  const width = intent.width ?? compactModelSize?.width;
  const height = intent.height ?? compactModelSize?.height;
  return [{
    type: "node.add",
    node: {
      id,
      type: intent.nodeType,
      // 无卡片对象（导演区/世界实例）的落点不影响 3D 呈现，但 `node.add` 结构与
      // `edit.apply` 的 node-add 都要求有限位置：缺省用 (0,0)，不能让缺键变成 `{}`。
      position: intent.position ? { ...intent.position } : { x: 0, y: 0 },
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {})
    },
    ...(intent.nodeData ? { nodeData: intent.nodeData } : {}),
    ...(intent.connectFromNodeId
      ? {
          connect: {
            fromNodeId: intent.connectFromNodeId,
            // 客户端稳定 edgeId（design D7）：服务端保留该 ID，前端 working projection
            // 与服务端生成同一实体，避免本地预览与服务端结果分叉。
            edgeId: createHighEntropyId(`edge-${intent.connectFromNodeId}-${id}`),
            ...(intent.connectLabel ? { label: intent.connectLabel } : {})
          }
        }
      : {})
  }];
}

/** 移动一批节点 → 每个节点一条 `node.update`。 */
export function planMoveNodes(positions: Readonly<Record<string, Woohaa3CanvasPosition>>): CanvasCommand[] {
  return Object.entries(positions).map(([nodeId, position]) => ({
    type: "node.update",
    nodeId,
    position: { ...position }
  }));
}

export type ResizeNodeIntent = {
  nodeId: string;
  width: number;
  height: number;
  /** 可选位置：范围从左／上边缩放时与尺寸原子提交，固定对侧边。 */
  position?: Woohaa3CanvasPosition;
};

/** 调整节点尺寸 → 一条 `node.update{width,height}`（change: add-node-resize）。 */
export function planResizeNode(intent: ResizeNodeIntent): CanvasCommand[] {
  return [{
    type: "node.update",
    nodeId: intent.nodeId,
    width: intent.width,
    height: intent.height,
    ...(intent.position ? { position: { ...intent.position } } : {})
  }];
}

export function planDeleteNodes(nodeIds: readonly string[]): CanvasCommand[] {
  return [{ type: "node.remove", nodeIds: [...nodeIds] }];
}

export function planConnectEdge(intent: ConnectEdgeIntent): CanvasCommand[] {
  return [{
    type: "edge.add",
    edge: {
      // 客户端稳定 edgeId（change: add-frontend-speculative-canvas-state，design D7）：
      // 服务端保留该 ID，前端 working projection 与服务端生成同一实体。
      id: intent.edgeId ?? createHighEntropyId(`edge-${intent.source}-${intent.target}`),
      source: intent.source,
      target: intent.target,
      sourceHandle: intent.sourceHandle ?? null,
      targetHandle: intent.targetHandle ?? null,
      ...(intent.data ? { data: intent.data } : {})
    }
  }];
}

export function planDeleteEdge(edgeId: string): CanvasCommand[] {
  return [{ type: "edge.remove", edgeId }];
}

export function planNodeDataPatch(intent: NodeDataPatchIntent): CanvasCommand[] {
  return [{ type: "nodeData.patch", nodeId: intent.nodeId, value: intent.value }];
}

/**
 * 多选聚合输出：把选中的一组节点展开为每个合法来源→目标的真实边
 * （change: add-multi-select-aggregate-connect）。
 *
 * 对每个来源用 `isValidWoohaa3CanvasConnection` 过滤角色不兼容、重复边与自环；
 * 全部无效时返回**空批次**（调用方据此给出稳定反馈，不提交空命令）。
 */
export function planAggregateConnect(
  nodes: readonly Woohaa3CanvasNode[],
  edges: readonly Woohaa3CanvasEdge[],
  sourceNodeIds: readonly string[],
  targetId: string
): CanvasCommand[] {
  const commands: CanvasCommand[] = [];
  for (const source of sourceNodeIds) {
    if (source === targetId) continue;
    if (!isValidWoohaa3CanvasConnection(
      { source, target: targetId, sourceHandle: null, targetHandle: null },
      [...nodes],
      [...edges],
    )) continue;
    commands.push(...planConnectEdge({ source, target: targetId }));
  }
  return commands;
}
