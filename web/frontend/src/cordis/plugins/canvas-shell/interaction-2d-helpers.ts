/**
 * 2D input family 的冷路径辅助
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm 拆出，遵守文件体积守卫）。
 *
 * `resizeTarget` / `scopeResizeTarget` 只在 pointermove 的 resize 分支调用（非命中热路径），
 * 依赖 working canvas 的 group 最小尺寸约束。
 */
import {
  builtinNodeCapabilityResolver, type NodeCapabilityResolver,
  minimumNodeSizeFor,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  scopeScaleFactor
} from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { Point } from "./hit-test.js";

/** 8 抓手方向顺序（与 Rust `canvas_query::scope::HANDLE_NAMES` / contracts 一致）。 */
export const SCOPE_HANDLE_ORDER = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;

/**
 * 地面范围对角锁定的等比缩放（change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D6）。
 *
 * `handle` 为拖拽抓手的世界坐标、`anchor` 为对角锁定锚点（对角顶点或对边中点），均由 accepted
 * 范围几何提供。把指针位移投影到缩放轴 `handle - anchor`：`k = 1 + dot(world - handle, handle - anchor) / |handle - anchor|²`，
 * 夹到最小比例。等比缩放规范尺寸 `width = w0×k`、`height = h0×k`；节点中心按 `anchor + k×(originCenter - anchor)`
 * 回算，使对角抓手保持不动（左/上方向拖动时同时提交 position）。
 */
export function scopeResizeTarget(
  gesture: { handle: Point; anchor: Point; originCenter: Point; originWidth: number; originHeight: number },
  world: Point,
  minimum = minimumNodeSizeFor("composite-asset")
): { width: number; height: number; position: Point } | null {
  const w0 = gesture.originWidth;
  const h0 = gesture.originHeight;
  if (!(w0 > 0) || !(h0 > 0) || !Number.isFinite(world.x) || !Number.isFinite(world.y)) return null;
  const minScale = Math.max(minimum.width / w0, minimum.height / h0);
  const k = Math.max(scopeScaleFactor(world, gesture.handle, gesture.anchor), minScale);
  const width = Math.round(w0 * k);
  const height = Math.round(h0 * k);
  if (width === Math.round(w0) && height === Math.round(h0)) return null;
  const centerX = gesture.anchor.x + k * (gesture.originCenter.x - gesture.anchor.x);
  const centerY = gesture.anchor.y + k * (gesture.originCenter.y - gesture.anchor.y);
  return { width, height, position: { x: centerX - width / 2, y: centerY - height / 2 } };
}

/** 组四角缩放的抓手方向；顺序与 Rust `canvas_query::scope::CORNER_NAMES` 一致。 */
export type GroupResizeCorner = "nw" | "ne" | "sw" | "se";

/** 命中的抓手名是否为组四角之一。 */
export function isGroupResizeCorner(handle: string | undefined): handle is GroupResizeCorner {
  return handle === "nw" || handle === "ne" || handle === "sw" || handle === "se";
}

/** resize 目标尺寸：自由缩放 + 下限 clamp + group 最小包围约束。 */
export function resizeTarget(
  gesture: {
    nodeId: string;
    start: Point;
    originWidth: number;
    originHeight: number;
    /** 拖拽的角（组四角缩放）；缺省为既有右下角自由缩放。 */
    corner?: GroupResizeCorner;
    /** 节点绝对左上角；角缩放据它固定对角，缺省不改变位置。 */
    origin?: Point;
  },
  world: Point,
  resolver: NodeCapabilityResolver = builtinNodeCapabilityResolver
): { width: number; height: number; position?: Point } | null {
  const dx = world.x - gesture.start.x;
  const dy = world.y - gesture.start.y;
  const corner = gesture.corner;
  const origin = gesture.origin;
  const anchored = corner && origin ? origin : null;
  const left0 = anchored?.x ?? 0;
  const top0 = anchored?.y ?? 0;
  const right0 = left0 + gesture.originWidth;
  const bottom0 = top0 + gesture.originHeight;
  // 西/北方向的角拖拽同时移动左上角；其余方向沿用既有「向右下生长」的行为。
  const west = corner === "nw" || corner === "sw";
  const north = corner === "nw" || corner === "ne";
  const left = west ? left0 + dx : left0;
  const right = west ? right0 : right0 + dx;
  const top = north ? top0 + dy : top0;
  const bottom = north ? bottom0 : bottom0 + dy;
  // 节点自由缩放为任意宽高比；媒体内容在 Bevy 侧按自身比例 contain。
  let width = Math.max(MIN_NODE_WIDTH, right - left);
  let height = Math.max(MIN_NODE_HEIGHT, bottom - top);
  // group 容器不得小于其直接成员的最小包围尺寸
  // （change: add-canvas-node-grouping，design D3）。
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
  const rounded = { width: Math.round(width), height: Math.round(height) };
  if (!corner) return rounded;
  // 对角固定：西/北拖拽由未移动的右/下边反算左上角，下限 clamp 时也不会顶偏对角。
  return {
    ...rounded,
    position: {
      x: Math.round(west ? right - rounded.width : left0),
      y: Math.round(north ? bottom - rounded.height : top0)
    }
  };
}
