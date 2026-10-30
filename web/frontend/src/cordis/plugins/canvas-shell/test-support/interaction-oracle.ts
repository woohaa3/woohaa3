/**
 * 2D 命中测试的**测试基线 oracle**（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
 *
 * 生产命中已迁至 Bevy WASM interaction query（`BevyRuntime.queryPoint` / `queryMarquee`）；
 * 本文件是测试用的行为基线（design D2 备选方案中明确的「迁移测试基线」），只用于单元测试
 * 在无 WASM 时驱动 controller 的命中分支。它**不是生产代码**，也不被 canvas-shell 生产模块
 * 导入（架构守卫排除 `/test-support/`）。
 *
 * 逻辑与既有 TS `hitTest` 一致，用于固定可见行为；权威实现是 Rust `canvas_query::interaction`。
 */
import {
  bevyAggregateHandle,
  bevyEdgeDeleteHitRect,
  bevyEdgeHoverBridgeRect,
  bevyNodeHistoryStripRect,
  bevyNodeSize,
  bevyPort,
  bevyResizeHandleRect,
  bevySelectionBounds,
  RESIZE_HANDLE_SIZE,
  type BevyNodeKind,
  type CanvasRenderScene
} from "@woohaa3/contracts";
import type { PointHit } from "../../canvas-runtime/bevy-runtime.js";

export type { PointHit };

type Point = { x: number; y: number };

function nodeSize(node: { type: BevyNodeKind; width?: number; height?: number }): { width: number; height: number } {
  const fallback = bevyNodeSize(node.type);
  return {
    width: node.width && node.width > 0 ? node.width : fallback.width,
    height: node.height && node.height > 0 ? node.height : fallback.height
  };
}

function portPosition(node: { x: number; y: number; type: BevyNodeKind; width?: number; height?: number }, side: "input" | "output"): Point {
  const size = nodeSize(node);
  return bevyPort({ x: node.x, y: node.y, width: size.width, height: size.height }, side);
}

/**
 * 组容器四角抓手命中框，顺序 `nw/ne/sw/se`
 * （与 Rust `layout::resize_corner_rects` 一致：命中框以角点为中心，与圆形抓手同心）。
 */
function groupCornerHandleRects(node: { x: number; y: number; width: number; height: number }) {
  const size = RESIZE_HANDLE_SIZE;
  const half = size / 2;
  const corners = [
    ["nw", node.x - half, node.y - half],
    ["ne", node.x + node.width - half, node.y - half],
    ["sw", node.x - half, node.y + node.height - half],
    ["se", node.x + node.width - half, node.y + node.height - half]
  ] as const;
  return corners.map(([handle, x, y]) => ({ handle, rect: { x, y, width: size, height: size } }));
}

function curvePoints(start: Point, end: Point, steps = 64): Point[] {
  const bend = Math.max(65, Math.abs(end.x - start.x) * 0.5);
  return Array.from({ length: steps + 1 }, (_unused, index) => {
    const t = index / steps;
    const u = 1 - t;
    return {
      x: u ** 3 * start.x + 3 * u * u * t * (start.x + bend) + 3 * u * t * t * (end.x - bend) + t ** 3 * end.x,
      y: u ** 3 * start.y + 3 * u * u * t * start.y + 3 * u * t * t * end.y + t ** 3 * end.y
    };
  });
}

/** 测试基线命中测试：与迁移前 `hitTest` 语义一致。 */
export function hitTestOracle(
  scene: CanvasRenderScene,
  world: Point,
  zoom = scene.viewport.zoom,
  hoveredEdgeId: string | null = null
): PointHit | null {
  const radius = Math.max(10, 10 / zoom);
  const nodeMap = new Map(scene.nodes.map((node) => [node.id, node]));
  const nodeRect = (node: CanvasRenderScene["nodes"][number]) => ({
    x: node.x,
    y: node.y,
    width: nodeSize(node).width,
    height: nodeSize(node).height
  });
  const hoveredEdge = hoveredEdgeId ? scene.edges.find((edge) => edge.id === hoveredEdgeId) : undefined;
  const hoveredSource = hoveredEdge ? nodeMap.get(hoveredEdge.source) : undefined;
  const hoveredTarget = hoveredEdge ? nodeMap.get(hoveredEdge.target) : undefined;
  const hoveredEndpoints =
    hoveredSource && hoveredTarget && !hoveredSource.ghost && !hoveredTarget.ghost
      ? { source: nodeRect(hoveredSource), target: nodeRect(hoveredTarget) }
      : null;
  if (hoveredEdge && hoveredEndpoints) {
    // 命中区比视觉按钮略大，补上标签与按钮之间的间隙（修复：删除按钮悬停丢失）。
    const button = bevyEdgeDeleteHitRect(
      hoveredEndpoints.source,
      hoveredEndpoints.target,
      hoveredEdge.label ?? ""
    );
    if (world.x >= button.x && world.x <= button.x + button.width && world.y >= button.y && world.y <= button.y + button.height) {
      return { kind: "edge-delete", edgeId: hoveredEdge.id };
    }
  }
  const selected = new Set(scene.selection.nodes);
  const nodeOrder = [
    ...scene.nodes.filter((node) => node.type !== "group").reverse(),
    ...scene.nodes.filter((node) => node.type === "group").reverse()
  ];
  for (const node of nodeOrder) {
    if (node.ghost) continue;
    const { width, height } = nodeSize(node);
    if (node.type === "group") {
      if ((node.group?.outputCapableLeafCount ?? 0) > 0) {
        const output = portPosition(node, "output");
        if (Math.hypot(world.x - output.x, world.y - output.y) <= radius) {
          return { kind: "port", nodeId: node.id, side: "output" };
        }
      }
    } else {
      for (const side of ["input", "output"] as const) {
        const point = portPosition(node, side);
        if (Math.hypot(world.x - point.x, world.y - point.y) <= radius) return { kind: "port", nodeId: node.id, side };
      }
    }
    // resize 抓手优先于底部历史条；历史入口已从右上角迁移到节点底部历史条
    // （change: 2026-10-12-unify-generation-history-strip）。
    if (selected.has(node.id)) {
      if (node.type === "group" && node.group?.collapsed !== true) {
        // 组容器四角都能拖拽缩放，方向名与 Rust `scope::CORNER_NAMES` 一致。
        const corner = groupCornerHandleRects(nodeRect(node)).find(({ rect }) =>
          world.x >= rect.x && world.x <= rect.x + rect.width && world.y >= rect.y && world.y <= rect.y + rect.height
        );
        if (corner) return { kind: "resize", nodeId: node.id, handle: corner.handle };
      } else {
        const handle = bevyResizeHandleRect({ x: node.x, y: node.y, width, height });
        if (world.x >= handle.x && world.x <= handle.x + handle.width && world.y >= handle.y && world.y <= handle.y + handle.height) {
          return { kind: "resize", nodeId: node.id };
        }
      }
    }
    if (node.type !== "group" && !node.compositeAsset) {
      const strip = bevyNodeHistoryStripRect({ x: node.x, y: node.y, width, height });
      if (world.x >= strip.x && world.x <= strip.x + strip.width && world.y >= strip.y && world.y <= strip.y + strip.height) {
        return { kind: "history", nodeId: node.id };
      }
    }
    if (world.x >= node.x && world.x <= node.x + width && world.y >= node.y && world.y <= node.y + height) {
      return { kind: "node", nodeId: node.id };
    }
  }
  // 聚合把手（change: add-multi-select-aggregate-connect）：选区外空白边缘，先于边/空白判定。
  if (scene.selection.nodes.length >= 2) {
    const selectedSet = new Set(scene.selection.nodes);
    const bounds = bevySelectionBounds(
      scene.nodes
        .filter((node) => selectedSet.has(node.id))
        .map((node) => ({ x: node.x, y: node.y, width: node.width, height: node.height }))
    );
    if (bounds) {
      const radius = Math.max(12, 12 / zoom);
      for (const side of ["input", "output"] as const) {
        const point = bevyAggregateHandle(bounds, side);
        if (Math.hypot(world.x - point.x, world.y - point.y) <= radius) {
          return { kind: "aggregate-handle", direction: side };
        }
      }
    }
  }
  // 悬停保持区：有标签时删除按钮在标签右侧，曲线只从标签中间穿过；指针从线体经标签走到
  // 按钮时靠这一段维持悬停，按钮不会在途中消失（修复：删除按钮悬停丢失）。
  if (hoveredEdge && hoveredEndpoints) {
    const bridge = bevyEdgeHoverBridgeRect(
      hoveredEndpoints.source,
      hoveredEndpoints.target,
      hoveredEdge.label ?? ""
    );
    if (world.x >= bridge.x && world.x <= bridge.x + bridge.width && world.y >= bridge.y && world.y <= bridge.y + bridge.height) {
      return { kind: "edge", edgeId: hoveredEdge.id };
    }
  }
  for (let index = scene.edges.length - 1; index >= 0; index -= 1) {
    const edge = scene.edges[index];
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    const points = curvePoints(portPosition(source, "output"), portPosition(target, "input"));
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((world.x - a.x) * dx + (world.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      if (Math.hypot(world.x - a.x - dx * t, world.y - a.y - dy * t) <= 7 / zoom) {
        return { kind: "edge", edgeId: edge.id };
      }
    }
  }
  return null;
}

/** 测试基线框选：与迁移前 `selectInRect` 语义一致。 */
export function selectInRectOracle(
  scene: CanvasRenderScene,
  rect: { x: number; y: number; width: number; height: number }
): string[] {
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  return scene.nodes
    .filter((node) => {
      if (node.ghost) return false;
      const { width, height } = nodeSize(node);
      return node.x < right && node.x + width > left && node.y < bottom && node.y + height > top;
    })
    .map((node) => node.id);
}
