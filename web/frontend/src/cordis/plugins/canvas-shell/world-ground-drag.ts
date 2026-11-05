/**
 * 共享世界对象的直接地面拖动（普通画布入口，不含镜头）。
 *
 * 世界模型没有内容卡片：指针命中来自渲染器 `queryModelPick` 的真实表面/空模型锚点，
 * 所以拖动不能复用卡片 `drag` 手势的位置预览（那写的是卡片 `position`）。这里把两个
 * 地面点转成米制增量：
 *
 * - 每次移动只更新控制器的瞬时 `worldGroundPreviews`（与导演区搬动的预览同一通道），
 *   不写规范状态、不发命令、不改卡片布局；
 * - 释放时才提交 `nodeData.patch`，写入新的 `sharedWorldInstance.transform.position`，
 *   完整保留原始 `instanceId`、姿态、尺度与高度 h；撤销即恢复旧变换。
 *
 * 纯规则（命中筛选、增量、是否达到提交阈值、提交计划）集中在本文件，便于回归。
 */
import {
  decodeWorldInstanceData,
  encodeWorldInstanceData,
  type CanvasCommand,
  type CanvasNodeData,
  type GroundPoint,
  type ServerCanvas
} from "@woohaa3/contracts";

/** 地面拖动的起点：命中的世界实例与按下时的地面点。 */
export type WorldGroundDragStart = {
  nodeId: string;
  /** 按下瞬间的规范实例数据（JSON），用于检测外部改写与空操作。 */
  source: string;
  /** 已解码的实例数据；提交时以它为底。 */
  instance: NonNullable<ReturnType<typeof instanceOf>>;
  start: GroundPoint;
};

function instanceOf(canvas: ServerCanvas | null | undefined, nodeId: string) {
  const decoded = decodeWorldInstanceData(canvas?.nodeData?.[nodeId]?.sharedWorldInstance);
  return decoded.ok ? decoded.value : null;
}

/** 该节点是否是可拖动的共享世界模型（`sharedWorldInstance` 合法且节点存在）。 */
export function isWorldDragTarget(canvas: ServerCanvas | null | undefined, nodeId: string | null): boolean {
  if (!canvas || !nodeId) return false;
  if (!canvas.document.nodes.some((node) => node.id === nodeId)) return false;
  return instanceOf(canvas, nodeId) !== null;
}

/**
 * 开始一次地面拖动。
 *
 * `ground` 来自 `controller.queryWorldGround`：聚焦/过渡/模态期间为 `null`，此时返回
 * `null` 让调用方走其余手势分支（例如地面拖动框选）。
 */
export function beginWorldGroundDrag(
  canvas: ServerCanvas | null | undefined,
  nodeId: string | null,
  ground: GroundPoint | null
): WorldGroundDragStart | null {
  if (!ground || !Number.isFinite(ground.u) || !Number.isFinite(ground.v)) return null;
  if (!canvas || !nodeId) return null;
  const instance = instanceOf(canvas, nodeId);
  if (!instance) return null;
  return {
    nodeId,
    // 用解码后的规范化值作并发基线：原始 JSON 的键顺序变化不应误判为外部改写。
    source: JSON.stringify(instance),
    instance,
    start: { u: ground.u, v: ground.v }
  };
}

/**
 * 指针移动：确认实例未被并发改写后，返回相对起点的地面增量。
 *
 * `null` 表示这次手势已失效（节点删除/实例被外部改写），调用方应取消预览。
 */
export function worldGroundDelta(
  start: WorldGroundDragStart,
  canvas: ServerCanvas | null | undefined,
  ground: GroundPoint | null
): GroundPoint | null {
  if (!ground || !Number.isFinite(ground.u) || !Number.isFinite(ground.v)) return null;
  const current = instanceOf(canvas, start.nodeId);
  if (!current || JSON.stringify(current) !== start.source) return null;
  return { u: ground.u - start.start.u, v: ground.v - start.start.v };
}

/** 释放时是否应提交：位移达到 1cm 才写，避免误点产生一条撤销记录。 */
export function worldGroundMoved(delta: GroundPoint | null | undefined): delta is GroundPoint {
  if (!delta || !Number.isFinite(delta.u) || !Number.isFinite(delta.v)) return false;
  return Math.abs(delta.u) > 0.01 || Math.abs(delta.v) > 0.01;
}

/**
 * 释放提交：只改地面 `u/v`，保留 `h`、旋转、缩放与 `instanceId`。
 *
 * 返回 `null` 表示无净变化或实例已失效（不提交，撤销历史不新增空条目）。
 */
export function planWorldGroundMove(
  start: WorldGroundDragStart,
  delta: GroundPoint | null | undefined
): CanvasCommand[] | null {
  if (!worldGroundMoved(delta)) return null;
  const transform = start.instance.transform;
  const next = {
    ...start.instance,
    transform: {
      ...transform,
      position: {
        u: transform.position.u + delta.u,
        v: transform.position.v + delta.v,
        h: transform.position.h
      }
    }
  };
  if (!decodeWorldInstanceData(next).ok) return null;
  // 复用共享 codec 的规范化输出（纯 JSON），与契约其它世界写入入口一致。
  const sharedWorldInstance = encodeWorldInstanceData(next) as CanvasNodeData["sharedWorldInstance"];
  return [{ type: "nodeData.patch", nodeId: start.nodeId, value: { sharedWorldInstance } }];
}
