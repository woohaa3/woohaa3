/**
 * 模型聚焦数学测试（change: add-model-focus-viewing，任务 1.2）。
 *
 * 覆盖：world AABB（view rotation + unit + placement）、ray unproject（正交/透视）、
 * ray-AABB（含负交点）、auto-frame、相机 pose 与锚点；全部断言有限值与确定性。
 */
import { describe, expect, it } from "vitest";
import {
  aabbCenterRadius,
  autoFrameDistance,
  canvasCameraRotation,
  canvasPointToWorld,
  CANVAS_CAMERA_PITCH,
  CANVAS_UNITS_PER_METER,
  clampDistance,
  clampFlySpeed,
  clampPitch,
  focusCameraPosition,
  focusCameraRotation,
  focusRay,
  focusTargetFor,
  filmSetFitFactor,
  modelAnchor,
  modelLocalAabb,
  modelUnit,
  modelWorldAabbRelative,
  normalizeYaw,
  orthoRay,
  rayHitPoint,
  rayIntersectsAabb,
  screenPointFromWorld,
  screenPointToWorld,
  viewRotation,
  worldToCanvasPoint,
  MODEL_FOCUS_FOV,
  MODEL_FOCUS_MIN_DISTANCE,
  MODEL_FOCUS_MAX_DISTANCE,
  MODEL_FOCUS_PITCH_LIMIT
} from "./model-focus.js";
import { eulerXyz } from "./model-focus/math.js";
import { quatRotate, type Vec3 } from "./model-transform.js";
import type { SceneV2Op } from "./scene-ir-v2.js";
import type { BevyModelPlacement } from "./render-scene.js";

const V2 = "woohaa-model-scene-ir-v2";

const boxV2 = (size: Vec3, position: Vec3, parent: string | null = null): SceneV2Op =>
  ({ t: "box", id: `b-${size.join()}-${position.join()}`, parent, position, rotation: [0, 0, 0], scale: [1, 1, 1], size, color: "#ffffff" }) as SceneV2Op;

describe("canvasPointToWorld", () => {
  it("固定嵌入 R × (cx, -cy, depth)：不读取 viewport/surface", () => {
    const world = canvasPointToWorld(100, 200, 5);
    const expected = quatRotate(canvasCameraRotation(), [100, -200, 5]);
    expect(world[0]).toBeCloseTo(expected[0], 9);
    expect(world[1]).toBeCloseTo(expected[1], 9);
    expect(world[2]).toBeCloseTo(expected[2], 9);
  });
});

describe("screenPointFromWorld / screenPointToWorld", () => {
  it("往返一致（固定观察深度）", () => {
    const viewport = { x: 40, y: -25, zoom: 2 };
    const depth = 12;
    const screen = { x: 300, y: 180 };
    const world = screenPointToWorld(screen, depth, viewport);
    const back = screenPointFromWorld(world, viewport);
    expect(back.x).toBeCloseTo(screen.x, 6);
    expect(back.y).toBeCloseTo(screen.y, 6);
  });
});

describe("viewRotation", () => {
  it("与 Bevy EulerRot::XYZ(CANVAS_CAMERA_PITCH, -PI/4, 0) 一致", () => {
    const q = viewRotation();
    const expected = eulerXyz(CANVAS_CAMERA_PITCH, -Math.PI / 4, 0);
    expect(q[0]).toBeCloseTo(expected[0], 9);
    expect(q[1]).toBeCloseTo(expected[1], 9);
    expect(q[2]).toBeCloseTo(expected[2], 9);
    expect(q[3]).toBeCloseTo(expected[3], 9);
  });
});

describe("modelWorldAabbRelative", () => {
  it("V2 单位立方体经 view rotation + unit 得到有限 AABB", () => {
    const input = {
      sceneVersion: V2,
      ops: [boxV2([1, 1, 1], [0, 0, 0])],
      extent: 2,
      placement: null
    };
    const aabb = modelWorldAabbRelative(input)!;
    expect(aabb).not.toBeNull();
    expect([...aabb.min, ...aabb.max].every(Number.isFinite)).toBe(true);
    // 绝对米制：unit = 1 × 64；1 m 立方体旋转后的轴对齐包围盒半径约 √3/2 × 64 ≈ 55。
    const { radius } = aabbCenterRadius(aabb);
    expect(radius).toBeGreaterThan(40);
    expect(radius).toBeLessThan(80);
  });

  it("placement scale 与 yaw 参与 world AABB", () => {
    const base = { sceneVersion: V2, ops: [boxV2([2, 1, 1], [0, 0, 0])], extent: 2 } as const;
    const noPlacement = modelWorldAabbRelative({ ...base, placement: null })!;
    const scaled = modelWorldAabbRelative({ ...base, placement: { offset: { x: 0, y: 0, z: 0 }, scale: 2, yaw: 0 } })!;
    const radiusNo = aabbCenterRadius(noPlacement).radius;
    const radiusScaled = aabbCenterRadius(scaled).radius;
    expect(radiusScaled).toBeCloseTo(radiusNo * 2, 3);
  });

  it("V2 局部 AABB（box）", () => {
    const ops: SceneV2Op[] = [
      boxV2([1, 1, 1], [0, 0, 0])
    ];
    const aabb = modelLocalAabb({ sceneVersion: V2, ops, extent: 2, placement: null })!;
    expect(aabb.min).toEqual([-0.5, -0.5, -0.5]);
    expect(aabb.max).toEqual([0.5, 0.5, 0.5]);
  });

  it("空模型返回 null", () => {
    expect(modelLocalAabb({ sceneVersion: V2, ops: [], extent: 1, placement: null })).toBeNull();
  });
});

describe("focusTargetFor", () => {
  it("锚点平移 world AABB 且中心/半径有限", () => {
    const target = focusTargetFor({
      sceneVersion: V2,
      ops: [boxV2([1, 2, 1], [0, 1, 0])],
      extent: 2,
      placement: null,
      anchor: [10, 20, 0]
    })!;
    expect(target).not.toBeNull();
    expect([...target.aabb.min, ...target.aabb.max].every(Number.isFinite)).toBe(true);
    // 锚点 y=20 抬升中心。
    expect(target.center[1]).toBeGreaterThan(20);
    expect(target.radius).toBeGreaterThan(0);
  });
});

describe("autoFrameDistance", () => {
  it("半径越大距离越大，且在距离范围内", () => {
    const near = autoFrameDistance(1, MODEL_FOCUS_FOV, 1.5);
    const far = autoFrameDistance(5, MODEL_FOCUS_FOV, 1.5);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(MODEL_FOCUS_MAX_DISTANCE);
    expect(near).toBeGreaterThanOrEqual(MODEL_FOCUS_MIN_DISTANCE);
  });

  it("竖屏 aspect（<1）比横屏需要更大距离", () => {
    const wide = autoFrameDistance(2, MODEL_FOCUS_FOV, 2);
    const tall = autoFrameDistance(2, MODEL_FOCUS_FOV, 0.5);
    expect(tall).toBeGreaterThan(wide);
  });

  it("大半径自动取景拉远，且下限不再强制停在包围球外", () => {
    const radius = 500;
    const distance = autoFrameDistance(radius, MODEL_FOCUS_FOV, 16 / 9);
    expect(distance).toBeGreaterThan(radius);
    // 允许拉近到包围球内部：下限为半径的固定比例（且不低于近裁剪余量）。
    expect(clampDistance(0.4, radius)).toBeLessThan(radius);
    expect(clampDistance(0.4, radius)).toBeGreaterThanOrEqual(radius * 0.5 - 1e-9);
  });

  it("非法输入回退而非 NaN", () => {
    const value = autoFrameDistance(Number.NaN, Number.NaN, Number.NaN);
    expect(Number.isFinite(value)).toBe(true);
  });
});

describe("相机 pose", () => {
  it("位置在 target + distance 处，朝向指向 target", () => {
    const camera = { target: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, distance: 5, flySpeed: 6 };
    const position = focusCameraPosition(camera);
    expect(position[2]).toBeCloseTo(5, 6);
    // 朝向四元数应把 -Z 转到从 position 指向 target 的方向。
    const rotation = focusCameraRotation(camera);
    const forward = quatRotate(rotation, [0, 0, -1]);
    expect(forward[2]).toBeCloseTo(-1, 6);
  });
});

describe("clamp / normalize", () => {
  it("pitch 限制在奇点以内", () => {
    expect(clampPitch(10)).toBeCloseTo(MODEL_FOCUS_PITCH_LIMIT, 6);
    expect(clampPitch(-10)).toBeCloseTo(-MODEL_FOCUS_PITCH_LIMIT, 6);
  });
  it("dolly 与 flySpeed 限制范围", () => {
    expect(clampDistance(0.01)).toBe(MODEL_FOCUS_MIN_DISTANCE);
    expect(clampDistance(1e9)).toBe(MODEL_FOCUS_MAX_DISTANCE);
    expect(clampFlySpeed(0)).toBe(0.4);
    expect(clampFlySpeed(1000)).toBe(80);
  });
  it("yaw 归一化到 [-PI, PI]", () => {
    expect(normalizeYaw(3 * Math.PI)).toBeCloseTo(Math.PI, 6);
    expect(normalizeYaw(-3 * Math.PI)).toBeCloseTo(-Math.PI, 6);
  });
});

describe("ray 命中", () => {
  const box = { min: [1, -1, -1] as Vec3, max: [3, 1, 1] as Vec3 };

  it("轴向射线命中并返回最近交点", () => {
    const t = rayIntersectsAabb({ origin: [0, 0, 0], direction: [1, 0, 0] }, box);
    expect(t).toBeCloseTo(1, 6);
  });

  it("负交点（AABB 在背后）视为未命中", () => {
    expect(rayIntersectsAabb({ origin: [0, 0, 0], direction: [-1, 0, 0] }, box)).toBeNull();
  });

  it("错过时返回 null", () => {
    expect(rayIntersectsAabb({ origin: [0, 2, 0], direction: [1, 0, 0] }, box)).toBeNull();
  });

  it("rayHitPoint 返回命中点", () => {
    const point = rayHitPoint({ origin: [0, 0, 0], direction: [1, 0, 0] }, box)!;
    expect(point[0]).toBeCloseTo(1, 6);
  });

  it("正交相机中心射线命中相机前方模型", () => {
    // 相机在 z=100 看向 -Z；正交半高 50。模型中心在原点。
    const ray = orthoRay({
      point: { x: 500, y: 400 },
      size: { width: 1000, height: 800 },
      cameraPosition: [0, 0, 100],
      cameraRotation: [0, 0, 0, 1],
      orthoHeight: 400
    });
    expect(ray.direction[2]).toBeCloseTo(-1, 6);
    const t = rayIntersectsAabb(ray, { min: [-1, -1, -1], max: [1, 1, 1] });
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(90);
  });

  it("透视聚焦射线从相机指向 target", () => {
    const camera = { target: [0, 0, 0] as Vec3, yaw: 0, pitch: 0, distance: 10, flySpeed: 6 };
    const ray = focusRay({ point: { x: 500, y: 400 }, size: { width: 1000, height: 800 }, camera, fov: MODEL_FOCUS_FOV });
    expect(ray.origin[2]).toBeCloseTo(10, 6);
    expect(ray.direction[2]).toBeCloseTo(-1, 6);
  });

  it("非法 AABB 不进入空白聚焦场景（focusTargetFor 返回 null）", () => {
    const result = focusTargetFor({
      sceneVersion: V2,
      ops: [],
      extent: Number.NaN,
      placement: null,
      anchor: [0, 0, 0]
    });
    expect(result).toBeNull();
  });
});

describe("modelAnchor", () => {
  it("固定画布坐标：卡片底部 + gap + 模型顶部高度决定锚点（与 Rust 同式）", () => {
    const relative = { min: [-1, 0, -1] as Vec3, max: [1, 4, 1] as Vec3 };
    const anchor = modelAnchor({
      nodeX: 100,
      nodeY: 200,
      nodeWidth: 260,
      nodeHeight: 195,
      relativeAabb: relative,
      offset: { x: 0, y: 0, z: 0 }
    });
    // 固定画布点：cx = 230，cy = 395 + 40 + 4 = 439；世界 = R × (230, -439, 0)。
    const expected = canvasPointToWorld(230, 439, 0);
    expect(anchor[0]).toBeCloseTo(expected[0], 6);
    expect(anchor[1]).toBeCloseTo(expected[1], 6);
    expect(anchor[2]).toBeCloseTo(expected[2], 6);
  });

  it("placement offset 使用固定 64 单位", () => {
    const relative = { min: [-1, 0, -1] as Vec3, max: [1, 4, 1] as Vec3 };
    const anchor = modelAnchor({
      nodeX: 100,
      nodeY: 200,
      nodeWidth: 260,
      nodeHeight: 195,
      relativeAabb: relative,
      offset: { x: 1, y: 0, z: 0 }
    });
    const expected = canvasPointToWorld(230 + 64, 439, 0);
    expect(anchor[0]).toBeCloseTo(expected[0], 6);
    expect(anchor[1]).toBeCloseTo(expected[1], 6);
  });

  it("片场（centered）：把模型投影中心对齐节点矩形中心，无朝下偏移", () => {
    const relative = { min: [-1, 0, -1] as Vec3, max: [1, 4, 1] as Vec3 };
    const anchor = modelAnchor({
      nodeX: 100,
      nodeY: 200,
      nodeWidth: 260,
      nodeHeight: 195,
      relativeAabb: relative,
      offset: { x: 0, y: 0, z: 0 },
      centered: true
    });
    // 投影中心：cx = 230 - 0 = 230；cy = 297.5 + (0+4)/2 = 299.5（y 向下）。
    const expected = canvasPointToWorld(230, 299.5, 0);
    expect(anchor[0]).toBeCloseTo(expected[0], 6);
    expect(anchor[1]).toBeCloseTo(expected[1], 6);
    expect(anchor[2]).toBeCloseTo(expected[2], 6);
  });
});

describe("filmSetFitFactor", () => {
  it("受限维度时按比例缩小（框越小缩放越小）", () => {
    const input = {
      sceneVersion: "v2",
      ops: [],
      extent: 4,
      aabb: { min: [-1, 0, -1] as Vec3, max: [1, 4, 1] as Vec3 },
      placement: null
    };
    const roomy = filmSetFitFactor(input, { width: 1000, height: 1000 });
    const tight = filmSetFitFactor(input, { width: 100, height: 100 });
    expect(roomy).toBeGreaterThan(0);
    expect(tight).toBeGreaterThan(0);
    expect(tight).toBeLessThan(roomy);
  });
});

describe("modelUnit", () => {
  it("绝对米制：placement scale 参与单位缩放，extent 不再参与", () => {
    const placement: BevyModelPlacement = { offset: { x: 0, y: 0, z: 0 }, scale: 2, yaw: 0 };
    expect(modelUnit(placement, 4)).toBeCloseTo(2 * CANVAS_UNITS_PER_METER, 6);
    // 同一个 placement 在任意 extent 下得到同一单位：不再按包围盒归一化。
    expect(modelUnit(placement, 40)).toBeCloseTo(modelUnit(placement, 1.5), 9);
    expect(modelUnit(null, 0)).toBeCloseTo(CANVAS_UNITS_PER_METER, 6);
  });
});

describe("canvas/world/screen 映射", () => {
  it("canvasPointToWorld 与 worldToCanvasPoint 互逆", () => {
    const world = canvasPointToWorld(123, 456, -7);
    const back = worldToCanvasPoint(world);
    expect(back.x).toBeCloseTo(123, 6);
    expect(back.y).toBeCloseTo(456, 6);
    expect(back.depth).toBeCloseTo(-7, 6);
  });

  it("screenPointFromWorld 满足 screen = canvas × zoom + pan，且与逆映射互逆", () => {
    const viewport = { x: 40, y: -25, zoom: 2 };
    const screen = { x: 300, y: 180 };
    const world = screenPointToWorld(screen, 0, viewport);
    const back = screenPointFromWorld(world, viewport);
    expect(back.x).toBeCloseTo(screen.x, 6);
    expect(back.y).toBeCloseTo(screen.y, 6);
  });

  it("同一世界点在任意 viewport 下按 canvas×zoom+pan 投影", () => {
    const world = canvasPointToWorld(230, 439, 12);
    for (const viewport of [
      { x: 0, y: 0, zoom: 1 },
      { x: 137, y: -83, zoom: 0.5 },
      { x: -400, y: 250, zoom: 12 }
    ]) {
      const projected = screenPointFromWorld(world, viewport);
      const canvas = worldToCanvasPoint(world);
      // screen = canvas × zoom + pan（y 轴同号）。
      expect(projected.x).toBeCloseTo(viewport.x + viewport.zoom * canvas.x, 5);
      expect(projected.y).toBeCloseTo(viewport.y + viewport.zoom * canvas.y, 5);
    }
  });
});
