import { describe, expect, it } from "vitest";
import {
  documentCorners,
  documentToView,
  guideDragPosition,
  guideSegment,
  hitGuide,
  rulerOriginAt,
  rulerReading,
  screenThreshold,
  validTransform,
  viewToDocument,
  type ViewTransformState,
} from "./view-transform.js";

const DOC: [number, number] = [200, 100];

function close(actual: readonly number[], expected: readonly number[]) {
  expect(actual[0]).toBeCloseTo(expected[0]!, 9);
  expect(actual[1]).toBeCloseTo(expected[1]!, 9);
}

describe("旋转视图与 Rust `ViewTransform` 同一份数学", () => {
  it("单位变换把文档角点映射到偏移量，且可逆", () => {
    const transform: ViewTransformState = { zoom: 1, offset: [0, 0], rotation: 0 };
    close(documentToView([0, 0], transform, DOC), [0, 0]);
    close(documentToView(DOC, transform, DOC), DOC);
    close(viewToDocument([0, 0], transform, DOC), [0, 0]);
    expect(validTransform(transform)).toBe(true);
  });

  it("任意角度与偏移下往返都回到源坐标，旋转中心不动", () => {
    for (const rotation of [0, 15, 30, -45, 90, 180, 359.5]) {
      for (const offset of [[0, 0], [37, -12]] as const) {
        const transform: ViewTransformState = { zoom: 1.7, offset, rotation };
        for (const point of [[0, 0], [200, 100], [12.5, 88.25], [-30, 140]] as const) {
          close(viewToDocument(documentToView(point, transform, DOC), transform, DOC), point);
        }
        close(documentToView([100, 50], transform, DOC), [offset[0] + 100 * 1.7, offset[1] + 50 * 1.7]);
      }
    }
  });

  it("顺时针 90° 把源 +x 轴映射到屏幕 +y 轴", () => {
    const transform: ViewTransformState = { zoom: 1, offset: [0, 0], rotation: 90 };
    close(documentToView([200, 50], transform, DOC), [100, 150]);
    close(documentToView([100, 0], transform, DOC), [150, 50]);
  });

  it("屏幕阈值随缩放换算，非法输入返回 0 而不是 NaN", () => {
    expect(screenThreshold(8, 2)).toBe(4);
    expect(screenThreshold(-1, 2)).toBe(0);
    expect(screenThreshold(Number.NaN, 2)).toBe(0);
    expect(screenThreshold(8, 0)).toBe(0);
    expect(screenThreshold(8, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("四角与参考线段都按同一矩阵投影", () => {
    const transform: ViewTransformState = { zoom: 1, offset: [0, 0], rotation: 90 };
    const corners = documentCorners(transform, DOC);
    expect(corners).toHaveLength(4);
    close(corners[0]!, [150, -50]);
    const [a, b] = guideSegment(true, 200, transform, DOC);
    // 旋转 90° 后 "竖线" 变成水平屏幕线。
    expect(a[1]).toBeCloseTo(b[1]!, 9);
    expect(Math.abs(a[0] - b[0])).toBeGreaterThan(1);
  });

  it("拒绝越界缩放、非有限偏移与超过一圈的角度", () => {
    expect(validTransform({ zoom: 0, offset: [0, 0], rotation: 0 })).toBe(false);
    expect(validTransform({ zoom: Number.NaN, offset: [0, 0], rotation: 0 })).toBe(false);
    expect(validTransform({ zoom: 33, offset: [0, 0], rotation: 0 })).toBe(false);
    expect(validTransform({ zoom: 1, offset: [Number.POSITIVE_INFINITY, 0], rotation: 0 })).toBe(false);
    expect(validTransform({ zoom: 1, offset: [0, 0], rotation: 361 })).toBe(false);
    expect(validTransform({ zoom: 4, offset: [10, 20], rotation: -90 })).toBe(true);
  });
});

describe("参考线命中、拖动与标尺读数都在源坐标里判定", () => {
  const identity: ViewTransformState = { zoom: 1, offset: [0, 0], rotation: 0 };

  it("按客户指针命中最近的参考线，容差换算成源像素", () => {
    const guides = { vertical: [100], horizontal: [50] };
    // 容差 6px、缩放 1 → 源容差 6。
    expect(hitGuide([104, 10], identity, DOC, guides, 6)).toMatchObject({ vertical: true, index: 0, position: 100, distance: 4 });
    expect(hitGuide([120, 10], identity, DOC, guides, 6)).toBeNull();
    // 缩放 4 倍时 6 屏幕像素只等于 1.5 源像素。
    const zoomed: ViewTransformState = { zoom: 4, offset: [0, 0], rotation: 0 };
    // 源 x=100 → 客户 x=400；偏 4 源像素 = 16 客户像素，超出 6 屏幕像素。
    expect(hitGuide([416, 40], zoomed, DOC, guides, 6)).toBeNull();
    expect(hitGuide([404, 40], zoomed, DOC, guides, 6)).toMatchObject({ position: 100 });
  });

  it("旋转后仍按源坐标命中，且重叠时取最近的一条", () => {
    const transform: ViewTransformState = { zoom: 1, offset: [0, 0], rotation: 90 };
    const guides = { vertical: [100, 100], horizontal: [50] };
    // 90° 后源竖线 x=100 落在屏幕 y=0 这条线上（客户坐标 (50,0)）。
    const hit = hitGuide(documentToView([100, 20], transform, DOC), transform, DOC, guides, 6);
    expect(hit?.vertical).toBe(true);
    expect(hit?.index).toBe(0);
    // 两条重合的竖线：distance 相同，保留索引 0 而不是随机跳动。
    expect(hit?.distance).toBeCloseTo(0, 6);
  });

  it("拖动位置夹取在画布内并保留两位小数", () => {
    expect(guideDragPosition(true, [12.3456, 20], identity, DOC)).toBe(12.35);
    expect(guideDragPosition(true, [-40, 20], identity, DOC)).toBe(0);
    expect(guideDragPosition(false, [10, 999], identity, DOC)).toBe(100);
    expect(guideDragPosition(true, [Number.NaN, 0], identity, DOC)).toBeNull();
  });

  it("原点拖动取指针处的源坐标，标尺读数从原点起算", () => {
    expect(rulerOriginAt([30, 40], identity, DOC)).toEqual([30, 40]);
    expect(rulerOriginAt([30, 40], { ...identity, rotation: 90 }, DOC)).toEqual([90, 120]);
    expect(rulerOriginAt([Number.POSITIVE_INFINITY, 0], identity, DOC)).toBeNull();
    const reading = rulerReading([130, 90], [30, 40], (px) => `${px} px`);
    expect(reading).toEqual({ x: 100, y: 50, xText: "100 px", yText: "50 px" });
  });

  it("未布局或零缩放的画布不产生命中与拖动", () => {
    expect(hitGuide([0, 0], { ...identity, zoom: 0 }, DOC, { vertical: [0] }, 6)).toBeNull();
    expect(guideDragPosition(true, [0, 0], { ...identity, zoom: Number.NaN }, DOC)).toBeNull();
  });
});
