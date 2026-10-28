/**
 * 跨语言 range golden：TS `composite-asset-scope` 与 Rust `canvas_query::scope` 共享同一 fixture
 * （change: 2026-10-12-align-film-set-scope-with-isometric-grid，任务 2.3）。
 *
 * 断言地面投影轴 AXIS_X/AXIS_Y、地面平行四边形顶点、8 抓手、边内外与 AABB 空白角；
 * Rust 侧 `bevy/tests/scope_golden.rs` 读取同一文件并断言相同值。同时校验投影常量与 Rust
 * `isometric_grid::plan::AXIS_X/AXIS_Y` 一致，未来更换投影必须同时更新两侧与形状。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPOSITE_ASSET_DIAMOND_EDGE_SLOPE,
  COMPOSITE_ASSET_SCOPE_AXIS_X,
  COMPOSITE_ASSET_SCOPE_AXIS_Y,
  compositeAssetScopeContains,
  compositeAssetScopeGeometry,
  compositeAssetScopeGrip,
  compositeAssetScopeGripHit,
  compositeAssetScopeIntersectsRect,
  normalizeScopeBaseRect,
  type CompositeAssetScopeGeometry,
  type CompositeAssetScopeShape
} from "./render-scene.js";
import { CANVAS_CAMERA_PITCH } from "./model-focus.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "..", "..", "fixtures", "canvas-scope-golden.json"), "utf8")
) as {
  edgeSlope: number;
  axisX: number;
  axisY: number;
  minHalf: number;
  cases: Array<{
    name: string;
    base: { x: number; y: number; width: number; height: number };
    shape: CompositeAssetScopeShape;
    ground: [number, number, number, number];
    center: [number, number];
    radius: [number, number];
    aabb: [number, number, number, number];
    vertices: Array<[number, number]>;
    handles: Array<[number, number]>;
    contains: Array<{ point: [number, number]; expect: boolean }>;
    intersect: Array<{ rect: [number, number, number, number]; expect: boolean }>;
  }>;
};

const tuple = (geometry: CompositeAssetScopeGeometry): number[] =>
  [geometry.aabb.x, geometry.aabb.y, geometry.aabb.width, geometry.aabb.height];
const points = (geometry: CompositeAssetScopeGeometry): number[][] =>
  geometry.vertices.map((vertex) => [vertex.x, vertex.y]);
const handles = (geometry: CompositeAssetScopeGeometry): number[][] =>
  geometry.handles.map((handle) => [handle.point.x, handle.point.y]);

describe("canvas scope golden（change: 2026-10-12-align-film-set-scope-with-isometric-grid）", () => {
  it("fixture 结构完整：rect 探针为长度 4 的数值数组（防止畸形探针让断言空转）", () => {
    const numeric = (value: unknown, length: number): boolean =>
      Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === "number");
    for (const testCase of fixture.cases) {
      expect(numeric(testCase.ground, 4), `${testCase.name} ground`).toBe(true);
      expect(numeric(testCase.center, 2), `${testCase.name} center`).toBe(true);
      expect(numeric(testCase.radius, 2), `${testCase.name} radius`).toBe(true);
      expect(numeric(testCase.aabb, 4), `${testCase.name} aabb`).toBe(true);
      for (const vertex of testCase.vertices) expect(numeric(vertex, 2), `${testCase.name} vertex`).toBe(true);
      for (const handle of testCase.handles) expect(numeric(handle, 2), `${testCase.name} handle`).toBe(true);
      for (const probe of testCase.contains) {
        expect(numeric(probe.point, 2), `${testCase.name} contains point`).toBe(true);
        expect(typeof probe.expect, `${testCase.name} contains expect`).toBe("boolean");
      }
      for (const probe of testCase.intersect) {
        expect(numeric(probe.rect, 4), `${testCase.name} intersect rect`).toBe(true);
        expect(typeof probe.expect, `${testCase.name} intersect expect`).toBe("boolean");
      }
    }
  });

  it("地面投影轴与 Rust isometric_grid::plan 一致并由全局 pitch 决定", () => {
    expect(COMPOSITE_ASSET_DIAMOND_EDGE_SLOPE).toBe(fixture.edgeSlope);
    expect(COMPOSITE_ASSET_SCOPE_AXIS_X).toBeCloseTo(fixture.axisX, 6);
    expect(COMPOSITE_ASSET_SCOPE_AXIS_Y).toBeCloseTo(fixture.axisY, 6);
    const rust = readFileSync(
      resolve(here, "..", "..", "..", "..", "bevy", "src", "isometric_grid", "plan.rs"),
      "utf8"
    );
    const pitchDegrees = Number(rust.match(/CANVAS_CAMERA_PITCH: f32 = ([\d.]+) \* PI \/ 180\.0;/)![1]!);
    expect((pitchDegrees * Math.PI) / 180).toBeCloseTo(CANVAS_CAMERA_PITCH, 6);
    const axisX = Number(rust.match(/const AXIS_X: f32 = ([\d_.]+);/)![1]!.replace(/_/g, ""));
    expect(axisX).toBeCloseTo(COMPOSITE_ASSET_SCOPE_AXIS_X, 6);
    expect(Math.sin(CANVAS_CAMERA_PITCH) * axisX).toBeCloseTo(COMPOSITE_ASSET_SCOPE_AXIS_Y, 6);
    expect(Math.abs(COMPOSITE_ASSET_SCOPE_AXIS_Y / axisX)).toBeCloseTo(COMPOSITE_ASSET_DIAMOND_EDGE_SLOPE, 6);
  });

  for (const testCase of fixture.cases) {
    describe(testCase.name, () => {
      const ground = { cx: testCase.ground[0], cy: testCase.ground[1], hx: testCase.ground[2], hz: testCase.ground[3] };
      const geometry = compositeAssetScopeGeometry(testCase.base, testCase.shape, fixture.minHalf, ground);

      it("中心、半径、顶点、抓手与 AABB 与 golden 一致", () => {
        expect(geometry.shape).toBe(testCase.shape);
        expect([geometry.center.x, geometry.center.y]).toEqual(testCase.center);
        expect([geometry.radiusX, geometry.radiusY]).toEqual(testCase.radius);
        expect(tuple(geometry)).toEqual(testCase.aabb);
        expect(points(geometry)).toEqual(testCase.vertices);
        expect(handles(geometry)).toEqual(testCase.handles);
        // 基准矩形保留为内容 fit 矩形，不被 AABB 覆盖。
        expect(geometry.base).toEqual(testCase.base);
      });

      it("点包含覆盖边内外与 AABB 空白角", () => {
        for (const probe of testCase.contains) {
          expect(compositeAssetScopeContains(geometry, { x: probe.point[0], y: probe.point[1] })).toBe(probe.expect);
        }
      });

      it("框选正面积相交覆盖包含、触边与空白角", () => {
        for (const probe of testCase.intersect) {
          const [x, y, width, height] = probe.rect;
          expect(compositeAssetScopeIntersectsRect(geometry, { x, y, width, height })).toBe(probe.expect);
        }
      });
    });
  }

  it("地面宽深相等时为菱形，四条边斜率由全局 pitch 决定", () => {
    const geometry = compositeAssetScopeGeometry(
      { x: 0, y: 0, width: 260, height: 195 },
      "isometric-diamond",
      32,
      { cx: 100, cy: 50, hx: 40, hz: 40 }
    );
    const edge = { x: geometry.vertices[1].x - geometry.vertices[0].x, y: geometry.vertices[1].y - geometry.vertices[0].y };
    expect(edge.y / edge.x).toBeCloseTo(COMPOSITE_ASSET_DIAMOND_EDGE_SLOPE, 6);
    const edge2 = { x: geometry.vertices[3].x - geometry.vertices[0].x, y: geometry.vertices[3].y - geometry.vertices[0].y };
    expect(edge2.y / edge2.x).toBeCloseTo(-COMPOSITE_ASSET_DIAMOND_EDGE_SLOPE, 6);
  });

  it("地面非正方时为平行四边形：AABB 宽高比由全局 pitch 决定", () => {
    const geometry = compositeAssetScopeGeometry(
      { x: 0, y: 0, width: 200, height: 100 },
      "isometric-diamond",
      32,
      { cx: 0, cy: 0, hx: 60, hz: 30 }
    );
    expect(geometry.aabb.width / geometry.aabb.height).toBeCloseTo(COMPOSITE_ASSET_SCOPE_AXIS_X / COMPOSITE_ASSET_SCOPE_AXIS_Y, 6);
    // 四顶点不共线于轴，仍是凸四边形。
    expect(points(geometry).length).toBe(4);
  });

  it("8 抓手可点：顶点/边中点命中，中心不命中", () => {
    const geometry = compositeAssetScopeGeometry(
      { x: 0, y: 0, width: 260, height: 195 },
      "isometric-diamond",
      32,
      { cx: 0, cy: 0, hx: 40, hz: 40 }
    );
    expect(compositeAssetScopeGripHit(geometry, { x: geometry.vertices[1].x, y: geometry.vertices[1].y })?.id).toBe("e");
    expect(compositeAssetScopeGripHit(geometry, { x: geometry.vertices[0].x, y: geometry.vertices[0].y })?.id).toBe("n");
    expect(compositeAssetScopeGripHit(geometry, { x: geometry.center.x, y: geometry.center.y })).toBeNull();
    // 矩形分支同样暴露 8 抓手且命中四角。
    const rect = compositeAssetScopeGeometry({ x: 0, y: 0, width: 200, height: 100 }, "rect", 32);
    expect(compositeAssetScopeGrip(rect).length).toBe(8);
    expect(compositeAssetScopeGripHit(rect, { x: 200, y: 100 })?.id).toBe("se");
  });

  it("极小地面围绕中心保留最小可点击范围且半径大于零", () => {
    const tiny = normalizeScopeBaseRect({ x: 10, y: 10, width: 0, height: 0 }, 32);
    expect(tiny).toEqual({ x: -22, y: -22, width: 64, height: 64 });
    const geometry = compositeAssetScopeGeometry(
      { x: 0, y: 0, width: 4, height: 4 },
      "isometric-diamond",
      32,
      { cx: 0, cy: 0, hx: 1, hz: 1 }
    );
    expect(geometry.radiusX).toBeGreaterThan(0);
    expect(geometry.radiusY).toBeGreaterThan(0);
  });
});
