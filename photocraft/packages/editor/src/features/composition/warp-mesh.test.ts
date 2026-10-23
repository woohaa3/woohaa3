import { expect, it } from "vitest";
import {
  identityWarpMesh,
  isIdentityWarpMesh,
  isMeshEditable,
  meshColumns,
  meshIndex,
  meshLines,
  meshRows,
  moveMeshPoint
} from "./warp-mesh.js";
import type { TransformRect } from "./workflows.js";

const rect: TransformRect = [10, 20, 70, 60];

it("单位网格：接受角点框 [x0,y0,x1,y1] 并铺满该矩形", () => {
  // 角点 (10,20)-(70,60) 与 width/height 40 等价；这里验证换算只发生在几何层。
  const mesh = identityWarpMesh([10, 20, 70, 60], 1, 1);
  expect(mesh.points[0]).toEqual([10, 20]);
  expect(mesh.points[15]).toEqual([70, 60]);
});

it("单位网格：块边界 0–1，控制点为 (3c+1)×(3r+1) 且铺满矩形", () => {
  const mesh = identityWarpMesh(rect, 1, 1);
  // `us`/`vs` 是块边界（块数 + 1 个），控制点轴才是 3c+1。
  expect(mesh.us).toEqual([0, 1]);
  expect(mesh.vs).toEqual([0, 1]);
  expect(mesh.points).toHaveLength(16);
  expect(meshColumns(mesh)).toBe(4);
  expect(meshRows(mesh)).toBe(4);
  // 行主序：第一个点左上，第五个点是第二行首。
  expect(mesh.points[0]).toEqual([10, 20]);
  expect(mesh.points[1][0]).toBeCloseTo(30);
  expect(mesh.points[4][0]).toBe(10);
  expect(mesh.points[4][1]).toBeCloseTo(20 + 40 / 3);
  expect(mesh.points[15]).toEqual([70, 60]);
});

it("多块网格：块数只增边界，控制点数按 3c+1 增长", () => {
  const mesh = identityWarpMesh(rect, 2, 3);
  expect(mesh.us).toEqual([0, 0.5, 1]);
  expect(mesh.vs).toHaveLength(4);
  expect(meshColumns(mesh)).toBe(7);
  expect(meshRows(mesh)).toBe(10);
  expect(mesh.points).toHaveLength(70);
  expect(isMeshEditable(mesh)).toBe(true);
});

it("索引按行主序换算，越界或非法拖动不改网格", () => {
  const mesh = identityWarpMesh(rect, 1, 1);
  expect(meshIndex(mesh, 0, 0)).toBe(0);
  expect(meshIndex(mesh, 3, 3)).toBe(15);
  expect(moveMeshPoint(mesh, 16, [0, 0])).toBe(mesh);
  expect(moveMeshPoint(mesh, 0, [Number.NaN, 0])).toBe(mesh);
  expect(moveMeshPoint(mesh, 1.5, [0, 0])).toBe(mesh);
});

it("拖动单个控制点只改那个点，其余点与轴不变", () => {
  const mesh = identityWarpMesh(rect, 1, 1);
  const next = moveMeshPoint(mesh, 5, [-4, 33]);
  expect(next.points[5]).toEqual([-4, 33]);
  expect(next.us).toEqual(mesh.us);
  expect(next.points.filter((_, index) => index !== 5)).toEqual(mesh.points.filter((_, index) => index !== 5));
  // 不改入参。
  expect(mesh.points[5]).not.toEqual([-4, 33]);
});

it("单位网格判定在容差内为真，拖动任一点后为假", () => {
  const mesh = identityWarpMesh(rect, 1, 1);
  expect(isIdentityWarpMesh(mesh, rect)).toBe(true);
  expect(isIdentityWarpMesh(moveMeshPoint(mesh, 5, [mesh.points[5][0] + 1e-9, mesh.points[5][1]]), rect)).toBe(true);
  expect(isIdentityWarpMesh(moveMeshPoint(mesh, 5, [mesh.points[5][0] + 1, mesh.points[5][1]]), rect)).toBe(false);
  // 2×2 块同样按自身块数判定，多块单位网格也算无变化。
  expect(isIdentityWarpMesh(identityWarpMesh(rect, 2, 2), rect)).toBe(true);
});

it("网格线连接相邻控制点，行主线数量随控制点网格增长", () => {
  // 4×4 控制点：横线 3×4 = 12，纵线 4×3 = 12。
  const one = meshLines(identityWarpMesh(rect, 1, 1));
  expect(one).toHaveLength(24);
  const two = meshLines(identityWarpMesh(rect, 2, 2));
  expect(two).toHaveLength(6 * 7 * 2);
  // 线段端点取自控制点，不使用另外一套坐标。
  const mesh = identityWarpMesh(rect, 1, 1);
  expect(one[0].from).toEqual(mesh.points[0]);
  expect(one[0].to).toEqual(mesh.points[1]);
});
