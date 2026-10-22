/**
 * 透明度动作、新缓动与材质扩展的契约回归
 * （change: 2026-10-19-extend-film-set-for-motion-graphics，任务 1.1–1.5）。
 */
import { describe, expect, it } from "vitest";
import { executeMotionScript } from "./motion-executor.js";
import { evaluateMotionIr, easingProgress, MOTION_IR_VERSION, type InitialCameraState, type MotionIr } from "./motion-ir.js";
import { isScalarTrackProperty, isMotionEasing, MODEL_TRACK_PROPERTIES } from "./motion-keyframes.js";
import { mergeModelTrackDelta } from "./motion-model-evaluation.js";
import { validateModelSceneIrV2 } from "./scene-ir-v2.js";

const CAMERA: InitialCameraState = { azimuth: 0, elevation: Math.PI / 4, distance: 8, focusOffset: { x: 0, y: 0, z: 0 } };
const PARTS = new Set(["root", "card", "connector"]);
const context = { duration: 4, partIds: PARTS, initialCamera: CAMERA };

function motion(modelMotion: unknown[]): MotionIr {
  const result = executeMotionScript("", context);
  expect(result.ok).toBe(true);
  return {
    version: MOTION_IR_VERSION,
    cameraMotion: [],
    modelMotion: modelMotion as MotionIr["modelMotion"]
  };
}

/** 直接用 IR 求值（绕过脚本），便于逐个属性构造。 */
function sample(ir: MotionIr, time: number) {
  const result = evaluateMotionIr(ir, time, { duration: 4, initialCamera: CAMERA, partIds: PARTS });
  expect(result.ok, result.ok ? "" : result.message).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.model.get("card")!;
}

const opacityTrack = (frames: Array<{ time: number; value: number }>, easing = "linear") => ({
  id: "fade",
  targetId: "card",
  startTime: frames[0]!.time,
  endTime: frames[frames.length - 1]!.time,
  motion: { kind: "keyframes", property: "opacity", frames: frames.map((frame) => ({ ...frame, easing })) }
});

describe("透明度动作（D1）", () => {
  it("accepts opacity as a 0–1 scalar and keeps the end value while seeking back restores 1", () => {
    const ir = motion([opacityTrack([{ time: 0, value: 0 }, { time: 2, value: 1 }])]);
    expect(sample(ir, 0).opacity).toBe(0);
    expect(sample(ir, 1).opacity).toBeCloseTo(0.5, 6);
    expect(sample(ir, 2).opacity).toBe(1);
    // 结束后保持终值。
    expect(sample(ir, 4).opacity).toBe(1);
  });

  it("allows opacity and scale/position on the same target", () => {
    const result = executeMotionScript(
      `motion.model.keyframes("card", { property: "opacity", frames: [
         { time: 0, value: 1, easing: "linear" },
         { time: 2, value: 0.25, easing: "linear" }
       ] });
       motion.model.keyframes("card", { property: "scale", frames: [
         { time: 0, value: [1, 1, 1], easing: "easeOut" },
         { time: 2, value: [1.08, 1.08, 1.08], easing: "easeOut" }
       ] });
       motion.model.tween("card", { property: "position", from: [0, 0, 0], to: [1, 0, 0], easing: "linear" });`,
      context
    );
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (!result.ok) return;
    const delta = sample(result.ir, 2);
    expect(delta.opacity).toBeCloseTo(0.25, 6);
    expect(delta.scale[0]).toBeCloseTo(1.08, 6);
    // tween 未给 endTime 时默认到时间线末尾（4 秒）：第 2 秒是 1 的一半。
    expect(delta.translation[0]).toBeCloseTo(0.5, 6);
  });

  it.each([
    ["1.2", [{ time: 0, value: 1.2 }, { time: 2, value: 1 }]],
    ["negative", [{ time: 0, value: -0.1 }, { time: 2, value: 1 }]],
    ["NaN", [{ time: 0, value: Number.NaN }, { time: 2, value: 1 }]],
    ["vector", [{ time: 0, value: [0, 0, 0] as unknown as number }, { time: 2, value: 1 }]]
  ])("rejects opacity value %s with invalid-motion", (_label, frames) => {
    const result = executeMotionScript(
      `motion.model.keyframes("card", { property: "opacity", frames: ${JSON.stringify(frames)} });`,
      { duration: 2, partIds: PARTS }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid-motion");
      expect(result.message).toContain("opacity");
    }
  });

  it("exposes opacity as a scalar property and merges it without resetting vectors", () => {
    expect(MODEL_TRACK_PROPERTIES).toContain("opacity");
    expect(isScalarTrackProperty("opacity")).toBe(true);
    expect(isScalarTrackProperty("scale")).toBe(false);
    const base = { rotation: [0, 0, 0, 1] as [number, number, number, number], translation: [3, 4, 5] as [number, number, number], scale: [2, 2, 2] as [number, number, number], opacity: 1 };
    const merged = mergeModelTrackDelta(base, { ...base, opacity: 0.4 }, opacityTrack([{ time: 0, value: 1 }, { time: 2, value: 0.4 }]) as never);
    expect(merged.translation).toEqual([3, 4, 5]);
    expect(merged.scale).toEqual([2, 2, 2]);
    expect(merged.opacity).toBe(0.4);
  });
});

describe("三次缓动（D3）", () => {
  it("registers easeIn/easeOut/easeInOut and keeps exact boundaries", () => {
    for (const easing of ["easeIn", "easeOut", "easeInOut"] as const) {
      expect(isMotionEasing(easing)).toBe(true);
      expect(easingProgress(easing, 0)).toBe(0);
      expect(easingProgress(easing, 1)).toBe(1);
      expect(easingProgress(easing, -1)).toBe(0);
      expect(easingProgress(easing, 2)).toBe(1);
    }
  });

  it("matches the cubic formulas at the midpoint", () => {
    expect(easingProgress("easeIn", 0.5)).toBeCloseTo(0.125, 9);
    expect(easingProgress("easeOut", 0.5)).toBeCloseTo(0.875, 9);
    expect(easingProgress("easeInOut", 0.5)).toBeCloseTo(0.5, 9);
    expect(easingProgress("easeInOut", 0.25)).toBeCloseTo(0.0625, 9);
    expect(easingProgress("easeInOut", 0.75)).toBeCloseTo(0.9375, 9);
  });

  it("lets camera tracks and keyframes use the new easings", () => {
    const result = executeMotionScript(
      `motion.camera.tween({ property: "distance", from: 10, to: 20, easing: "easeOut" });
       motion.model.keyframes("card", { property: "scale", easing: "easeInOut", frames: [
         { time: 0, value: [1, 1, 1] },
         { time: 4, value: [2, 2, 2] }
       ] });`,
      context
    );
    expect(result.ok, result.ok ? "" : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.ir.cameraMotion[0]!.easing).toBe("easeOut");
    expect(result.ir.modelMotion[0]!.motion.kind).toBe("keyframes");
    const evaluated = evaluateMotionIr(result.ir, 2, { duration: 4, initialCamera: CAMERA, partIds: PARTS });
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    // easeOut 在 0.5 进度是 0.875 → distance 10+10×0.875 = 18.75；easeInOut 中点是 0.5 → scale 1.5。
    expect(evaluated.camera.distance).toBeCloseTo(18.75, 6);
    expect(evaluated.model.get("card")!.scale[0]).toBeCloseTo(1.5, 6);
  });
});

describe("材质 unlit / opacity（D4）", () => {
  const wrap = (ops: unknown[]) => ({ version: "woohaa-model-scene-ir-v2", ops });
  const material = (overrides: Record<string, unknown> = {}) => ({ t: "material", id: "m", ...overrides });

  it("normalizes unlit and blend opacity; defaults stay absent for old scenes", () => {
    const result = validateModelSceneIrV2(wrap([material({ alphaMode: "blend", unlit: true, opacity: 0.3 })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.ops[0]).toMatchObject({ unlit: true, opacity: 0.3 });
  });

  it("keeps old scenes byte-identical: no unlit/opacity keys without the new fields", () => {
    const result = validateModelSceneIrV2(wrap([material({ alphaMode: "blend" })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const materialOp = result.scene.ops[0] as Record<string, unknown>;
    expect("unlit" in materialOp).toBe(false);
    expect("opacity" in materialOp).toBe(false);
  });

  it("rejects opacity outside 0..1 and opacity on non-blend materials", () => {
    expect(validateModelSceneIrV2(wrap([material({ alphaMode: "blend", opacity: 1.5 })]))).toMatchObject({ ok: false, code: "invalid-material" });
    expect(validateModelSceneIrV2(wrap([material({ alphaMode: "opaque", opacity: 0.4 })]))).toMatchObject({ ok: false, code: "invalid-material" });
    expect(validateModelSceneIrV2(wrap([material({ unlit: "yes" })]))).toMatchObject({ ok: false, code: "invalid-material" });
  });
});
