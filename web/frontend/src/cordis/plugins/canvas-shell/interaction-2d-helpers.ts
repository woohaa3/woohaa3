/**
 * 2D input family 的冷路径辅助
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm 拆出，遵守文件体积守卫；
 *   change: remove-canvas-groups-and-film-set —— 组四角与片场范围缩放一并删除）。
 *
 * `resizeTarget` 只在 pointermove 的 resize 分支调用（非命中热路径）。
 */
import {
  builtinNodeCapabilityResolver, type NodeCapabilityResolver,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH
} from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { Point } from "./hit-test.js";

/** resize 目标尺寸：自由缩放 + 下限 clamp。 */
export function resizeTarget(
  gesture: {
    nodeId: string;
    start: Point;
    originWidth: number;
    originHeight: number;
    edge?: import("./scene-area-cursor.js").FrameEdge;
    originPosition?: Point;
  },
  world: Point,
  resolver: NodeCapabilityResolver = builtinNodeCapabilityResolver
): { width: number; height: number; position?: Point } | null {
  const dx = world.x - gesture.start.x;
  const dy = world.y - gesture.start.y;
  // 节点自由缩放为任意宽高比；媒体内容在 Bevy 侧按自身比例 contain。
  let width = Math.max(MIN_NODE_WIDTH, gesture.originWidth + dx * (gesture.edge?.x ?? 1));
  let height = Math.max(MIN_NODE_HEIGHT, gesture.originHeight + dy * (gesture.edge?.y ?? 1));
  const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
  const node = canvasState?.document.nodes.find((entry) => entry.id === gesture.nodeId);
  if (!node || !canvasState) return null;
  const context = { canvas: canvasState, node, data: canvasState.nodeData[node.id] };
  const resize = resolver.resolve(context).resize;
  if (!resize) return null;
  const min = resize.minimum(context);
  width = Math.max(width, min.width);
  height = Math.max(height, min.height);
  if (Math.abs(width - gesture.originWidth) < 0.5 && Math.abs(height - gesture.originHeight) < 0.5) return null;
  width = Math.round(width);
  height = Math.round(height);
  const position = gesture.edge && gesture.originPosition ? {
    x: gesture.originPosition.x + (gesture.edge.x < 0 ? gesture.originWidth - width : 0),
    y: gesture.originPosition.y + (gesture.edge.y < 0 ? gesture.originHeight - height : 0)
  } : undefined;
  return { width, height, ...(position ? { position } : {}) };
}
