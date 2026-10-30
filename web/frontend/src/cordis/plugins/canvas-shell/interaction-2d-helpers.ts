/**
 * 2D input family 的冷路径辅助
 * （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm 拆出，遵守文件体积守卫）。
 *
 * `resizeTarget` / `scopeResizeTarget` 只在 pointermove 的 resize 分支调用（非命中热路径），
 * 依赖 working canvas 的 group 最小尺寸约束。
 */
import {
  builtinNodeCapabilityResolver, effectiveCanvasNodeSize, type NodeCapabilityResolver,
  groupBottomPadding,
  minimumNodeSizeFor,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  scopeScaleFactor,
  type ServerCanvas
} from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { sharedCanvasNodeIndex } from "./canvas-node-index.js";
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

/**
 * 组直接成员在**画布绝对坐标**里的包围盒；没有成员时返回 null。
 *
 * 组框缩放时成员留在画布原位（不跟着框的原点走），因此缩放下限要按成员的绝对位置算：
 * 从左边拖时右边缘固定，左边缘最多收到最左成员；从右边拖时左边缘固定，右边缘最多收到最右成员。
 */
function groupContentBounds(
  canvas: ServerCanvas,
  groupId: string
): { left: number; top: number; right: number; bottom: number } | null {
  const index = sharedCanvasNodeIndex(canvas);
  if (!index) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const childId of index.children.get(groupId) ?? []) {
    const child = index.byId.get(childId);
    const at = index.absolutePosition(childId);
    if (!child || !at) continue;
    const size = effectiveCanvasNodeSize(child);
    left = Math.min(left, at.x);
    top = Math.min(top, at.y);
    right = Math.max(right, at.x + size.width);
    bottom = Math.max(bottom, at.y + size.height);
  }
  return Number.isFinite(left) ? { left, top, right, bottom } : null;
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
  const canvasState = workingCanvasOf(woohaa3CanvasStore.getState());
  const node = canvasState?.document.nodes.find((entry) => entry.id === gesture.nodeId);
  if (!node || !canvasState) return null;
  const context = { canvas: canvasState, node, data: canvasState.nodeData[node.id] };
  const resize = resolver.resolve(context).resize;
  if (!resize) return null;
  const content = node.type === "group" ? groupContentBounds(canvasState, node.id) : null;
  if (content && corner) {
    // 组框缩放：成员保持画布绝对位置，框边最多收到与成员相切。
    // 西/北方向固定右/下边，下限按「固定边 − 成员对侧边界」算；东/南方向固定左/上边。
    // 底部保留页脚（徽标与成员之间的间隔），南向拖拽不得压掉。
    const widthFloor = west ? right0 - content.left : content.right - left0;
    const heightFloor = north ? bottom0 - content.top : content.bottom + groupBottomPadding - top0;
    // 成员已越界时不得把框反向撑大：下限不超过手势开始时的尺寸。
    width = Math.max(width, Math.min(widthFloor, gesture.originWidth));
    height = Math.max(height, Math.min(heightFloor, gesture.originHeight));
  } else {
    // group 容器不得小于其直接成员的最小包围尺寸
    // （change: add-canvas-node-grouping，design D3）。
    const min = resize.minimum(context);
    width = Math.max(width, min.width);
    height = Math.max(height, min.height);
  }
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
