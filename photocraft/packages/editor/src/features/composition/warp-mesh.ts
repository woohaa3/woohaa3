/**
 * 变形网格的纯几何（U53）：单位网格、控制点索引与拖动。
 *
 * 网格形状与内核 `BezierMesh` 一致：`us`/`vs` 是 0–1 的**块边界**（长度 = 块数 + 1），
 * 控制点是 `(3c+1) × (3r+1)` 的行主序**文档坐标**——每块内部按三等分插值，跨块共享边。
 * 叠加层只改 `points`，不改 `us`/`vs`：块边界由「网格分割」命令单独调整，两件事分开。
 *
 * 与 `workflows.ts` 的解耦：这里只产出 `WarpMesh` 数据，参数编译仍走 `warpMeshParams`。
 */

import type { TransformRect, WarpMesh } from "./workflows.js";

export type WarpPoint = [number, number];

/** 块边界：长度 = 块数 + 1，首 0 尾 1。 */
function boundaries(patches: number): number[] {
  const count = Math.max(1, Math.round(patches));
  return Array.from({ length: count + 1 }, (_, index) => index / count);
}

/** 控制点轴位置：每块三等分，长度 = 3 × 块数 + 1。 */
function controlAxis(patches: number): number[] {
  const count = Math.max(1, Math.round(patches));
  return Array.from({ length: 3 * count + 1 }, (_, index) => index / (3 * count));
}

/** 每行控制点数（`3c+1`，`c = us.length - 1` 个块）。 */
export function meshColumns(mesh: WarpMesh): number {
  return 3 * (mesh.us.length - 1) + 1;
}

/** 控制点行数（`3r+1`）。 */
export function meshRows(mesh: WarpMesh): number {
  return 3 * (mesh.vs.length - 1) + 1;
}

/** 第 `row` 行第 `column` 个控制点的下标（行主序）。 */
export function meshIndex(mesh: WarpMesh, column: number, row: number): number {
  return row * meshColumns(mesh) + column;
}

/**
 * 矩形上的单位网格：`cols × rows` 块，控制点按三等分铺满 `rect`。
 *
 * `rect` 用**上游角点约定** `[x0,y0,x1,y1]`，与 `warpMeshParams` 的 `rect` 同一套；换算只在
 * 这里做一次，避免「宽高 vs 角点」两套约定在叠加层里再分叉一次。
 *
 * 与内核 `BezierMesh::identity` 等价（线性映射的三次贝塞尔拟合就是线性插值），但不需要
 * 跑贝塞尔反解，界面切换网格密度时也不会抖动。
 */
export function identityWarpMesh(rect: TransformRect, cols = 1, rows = 1): WarpMesh {
  const [x0, y0, x1, y1] = rect;
  const width = x1 - x0;
  const height = y1 - y0;
  const columns = controlAxis(cols);
  const rowsAxis = controlAxis(rows);
  const points: WarpPoint[] = [];
  for (const t of rowsAxis) {
    const y = y0 + t * height;
    for (const s of columns) points.push([x0 + s * width, y]);
  }
  return { us: boundaries(cols), vs: boundaries(rows), points };
}

/** 网格是否已回到单位网格；用于判断「无变化」不提交。 */
export function isIdentityWarpMesh(mesh: WarpMesh, rect: TransformRect, tolerance = 1e-6): boolean {
  const identity = identityWarpMesh(rect, mesh.us.length - 1, mesh.vs.length - 1);
  if (identity.points.length !== mesh.points.length) return false;
  return mesh.points.every(([x, y], index) => {
    const [ix, iy] = identity.points[index];
    return Math.abs(x - ix) <= tolerance && Math.abs(y - iy) <= tolerance;
  });
}

/**
 * 把一个控制点移到 `to`，返回新网格（不改入参）。
 *
 * 只动被拖的点：相邻块共享边上的控制点本来就是同一个点，改它会让两侧形状一起变——这正是
 * Photoshop 拖动单个网格点的效果。越界不夹取（变形本来就允许出画布）。
 */
export function moveMeshPoint(mesh: WarpMesh, index: number, to: WarpPoint): WarpMesh {
  if (!Number.isInteger(index) || index < 0 || index >= mesh.points.length) return mesh;
  if (!Number.isFinite(to[0]) || !Number.isFinite(to[1])) return mesh;
  const points = mesh.points.map((point, position) => (position === index ? [to[0], to[1]] as WarpPoint : point));
  return { us: [...mesh.us], vs: [...mesh.vs], points };
}

/** 控制点是否可在界面上拖动（角度/弯曲样式的预设网格不可拖）。 */
export function isMeshEditable(mesh: WarpMesh): boolean {
  return mesh.points.length === meshColumns(mesh) * meshRows(mesh) && mesh.points.length > 0;
}

/**
 * 网格线：把相邻控制点连起来（每块 3×3 小格）。
 *
 * 数量只受块数影响，块数由「网格分割」限制在 1–64，不会因为网格密而爆 DOM。
 */
export function meshLines(mesh: WarpMesh): { from: WarpPoint; to: WarpPoint }[] {
  const lines: { from: WarpPoint; to: WarpPoint }[] = [];
  const columns = meshColumns(mesh);
  const rows = meshRows(mesh);
  const point = (column: number, row: number): WarpPoint => mesh.points[meshIndex(mesh, column, row)] ?? [0, 0];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      lines.push({ from: point(column, row), to: point(column + 1, row) });
    }
  }
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows - 1; row += 1) {
      lines.push({ from: point(column, row), to: point(column, row + 1) });
    }
  }
  return lines;
}
