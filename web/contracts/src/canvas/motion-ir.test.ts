/**
 * `woohaa-motion-ir-v1` validator 与确定性求值器测试
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.4/1.5）。
 */
import { describe, expect, it } from "vitest";
import { executeMotionScript, MotionRecorder } from "./motion-executor.js";
import {
  evaluateMotionIr,
  identityModelDelta,
  MOTION_IR_VERSION,
  validateMotionIr,
  type InitialCameraState,
  type MotionIr
} from "./motion-ir.js";

const CAMERA: InitialCameraState = {
  azimuth: 0,
  elevation: Math.PI / 4,
  distance: 8,
  focusOffset: { x: 0, y: 0, z: 0 }
};

const PARTS = new Set(["body", "left-hand"]);

function validate(input: unknown, duration = 4, partIds: ReadonlySet<string> = PARTS) {
  return validateMotionIr(input, { duration, partIds });
}

describe("Motion IR validator（任务 1.5）", () => {
  it("接受设计示例并补齐默认值", () => {
    const result = validate({
      version: MOTION_IR_VERSION,
      cameraMotion: [
        { id: "camera-orbit", property: "azimuth", startTime: 0, endTime: 4, from: 0, to: 1.57, easing: "smoothstep" }
      ],
      modelMotion: [
        { id: "body-turn", targetId: "body", startTime: 0, endTime: 4, motion: { kind: "rotate", axis: "y", speed: 0.5 } },
        {
          id: "hand-wave",
          targetId: "left-hand",
          startTime: 1,
          endTime: 4,
          motion: { kind: "oscillate", axis: "z", mode: "rotation", speed: 6, amplitude: 0.4 }
        }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.cameraMotion[0]!.easing).toBe("smoothstep");
    const hand = result.ir.modelMotion.find((track) => track.targetId === "left-hand");
    expect(hand?.motion.kind).toBe("oscillate");
    if (hand?.motion.kind === "oscillate") expect(hand.motion.phase).toBe(0);
  });

  it("默认 axis=y、mode=position、easing=linear、endTime=duration", () => {
    const result = validate({
      version: MOTION_IR_VERSION,
      modelMotion: [{ id: "m", targetId: "body", motion: { kind: "oscillate", speed: 2, amplitude: 1 } }]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const motion = result.ir.modelMotion[0]!.motion;
    expect(result.ir.modelMotion[0]!.startTime).toBe(0);
    expect(result.ir.modelMotion[0]!.endTime).toBe(4);
    if (motion.kind === "oscillate") {
      expect(motion.axis).toBe("y");
      expect(motion.mode).toBe("position");
    }
  });

  it("拒绝未知版本、越界时间、start>=end", () => {
    expect(validate({ version: "other" }).ok).toBe(false);
    expect(
      validate({ version: MOTION_IR_VERSION, modelMotion: [{ id: "m", targetId: "body", startTime: 3, endTime: 3, motion: { kind: "rotate", speed: 1 } }] }).ok
    ).toBe(false);
    expect(
      validate({ version: MOTION_IR_VERSION, modelMotion: [{ id: "m", targetId: "body", startTime: 0, endTime: 9, motion: { kind: "rotate", speed: 1 } }] }).ok
    ).toBe(false);
  });

  it("拒绝同属性重叠镜头轨道，允许相接", () => {
    const overlapping = validate({
      version: MOTION_IR_VERSION,
      cameraMotion: [
        { id: "a", property: "azimuth", startTime: 0, endTime: 3, from: 0, to: 1 },
        { id: "b", property: "azimuth", startTime: 2, endTime: 4, from: 1, to: 2 }
      ]
    });
    expect(overlapping.ok).toBe(false);
    const adjacent = validate({
      version: MOTION_IR_VERSION,
      cameraMotion: [
        { id: "a", property: "azimuth", startTime: 0, endTime: 2, from: 0, to: 1 },
        { id: "b", property: "azimuth", startTime: 2, endTime: 4, from: 1, to: 2 }
      ]
    });
    expect(adjacent.ok).toBe(true);
  });

  it("拒绝同一部件多条轨道与未知部件", () => {
    expect(
      validate({
        version: MOTION_IR_VERSION,
        modelMotion: [
          { id: "a", targetId: "body", motion: { kind: "rotate", speed: 1 } },
          { id: "b", targetId: "body", motion: { kind: "rotate", speed: 1 } }
        ]
      }).ok
    ).toBe(false);
    expect(
      validate({
        version: MOTION_IR_VERSION,
        modelMotion: [{ id: "a", targetId: "missing", motion: { kind: "rotate", speed: 1 } }]
      }).ok
    ).toBe(false);
  });

  it("强制必填 speed / range / amplitude", () => {
    expect(validate({ version: MOTION_IR_VERSION, modelMotion: [{ id: "m", targetId: "body", motion: { kind: "rotate" } }] }).ok).toBe(false);
    expect(validate({ version: MOTION_IR_VERSION, modelMotion: [{ id: "m", targetId: "body", motion: { kind: "move", speed: 1 } }] }).ok).toBe(false);
    expect(validate({ version: MOTION_IR_VERSION, modelMotion: [{ id: "m", targetId: "body", motion: { kind: "oscillate", speed: 1 } }] }).ok).toBe(false);
  });
});

describe("运动求值（任务 1.5）", () => {
  const ir: MotionIr = {
    version: MOTION_IR_VERSION,
    cameraMotion: [
      { id: "camera-orbit", property: "azimuth", startTime: 0, endTime: 4, from: 0, to: 4, easing: "linear" }
    ],
    modelMotion: [
      { id: "body-turn", targetId: "body", startTime: 0, endTime: 4, motion: { kind: "rotate", axis: "y", speed: 0.5 } },
      {
        id: "hand-wave",
        targetId: "left-hand",
        startTime: 1,
        endTime: 4,
        motion: { kind: "oscillate", axis: "z", mode: "rotation", speed: 6, amplitude: 0.4, phase: 0 }
      }
    ]
  };

  it("第 2 秒身体转 2 秒、左手摆动 1 秒、镜头按同一时间线", () => {
    const result = evaluateMotionIr(ir, 2, { duration: 4, initialCamera: CAMERA, partIds: PARTS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.camera.azimuth).toBeCloseTo(2, 6);
    const body = result.model.get("body")!;
    // rotate 2s * 0.5 rad/s, around Y.
    const expectedHalf = 1 / 2;
    expect(body.rotation[1]).toBeCloseTo(Math.sin(expectedHalf), 6);
    expect(body.rotation[3]).toBeCloseTo(Math.cos(expectedHalf), 6);
    const hand = result.model.get("left-hand")!;
    const wave = Math.sin((2 - 1) * 6) * 0.4;
    expect(hand.rotation[2]).toBeCloseTo(Math.sin(wave / 2), 6);
  });

  it("未开始轨道不生效，结束后保持末态", () => {
    const before = evaluateMotionIr(ir, 0.5, { duration: 4, initialCamera: CAMERA, partIds: PARTS });
    expect(before.ok && !before.model.has("left-hand")).toBe(true);
    const after = evaluateMotionIr(ir, 4, { duration: 4, initialCamera: CAMERA, partIds: PARTS });
    if (!after.ok) return;
    expect(after.camera.azimuth).toBeCloseTo(4, 6);
  });

  it("相机从初始参数开始，未声明属性保持初始值", () => {
    const result = evaluateMotionIr(
      { version: MOTION_IR_VERSION, cameraMotion: [], modelMotion: [] },
      3,
      { duration: 4, initialCamera: CAMERA, partIds: PARTS }
    );
    expect(result.ok && result.camera.distance).toBe(8);
    expect(result.ok && result.camera.focusOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("identityModelDelta 是单位姿态", () => {
    expect(identityModelDelta()).toEqual({ rotation: [0, 0, 0, 1], translation: [0, 0, 0], scale: [1, 1, 1] });
  });
});

describe("MotionRecorder / 执行器（任务 1.4）", () => {
  it("recorder 生成稳定 id 并保留作者参数", () => {
    const recorder = new MotionRecorder();
    const id = recorder.model.rotate("body", { speed: 0.5 });
    expect(id).toBe("rotate_1");
    expect(recorder.raw().modelMotion[0]!.targetId).toBe("body");
  });

  it("执行设计示例脚本得到合法 IR", () => {
    const script = `
      motion.camera.tween({ id: "camera-orbit", property: "azimuth", startTime: 0, endTime: 4, from: 0, to: 1.57, easing: "smoothstep" });
      motion.model.rotate("body", { id: "body-turn", axis: "y", speed: 0.5, startTime: 0, endTime: 4 });
      motion.model.oscillate("left-hand", { id: "hand-wave", axis: "z", mode: "rotation", speed: 6, amplitude: 0.4, startTime: 1, endTime: 4 });
    `;
    const result = executeMotionScript(script, { duration: 4, partIds: PARTS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.modelMotion).toHaveLength(2);
  });

  it("确定性重跑：随机脚本被拒绝", () => {
    const result = executeMotionScript(
      `motion.model.rotate("body", { speed: Math.random() });`,
      { duration: 4, partIds: PARTS }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("determinism");
  });

  it("语法/引用失败返回结构化诊断", () => {
    const syntax = executeMotionScript(`motion.model.rotate(`, { duration: 4, partIds: PARTS });
    expect(!syntax.ok && syntax.stage).toBe("compile");
    const unknown = executeMotionScript(`motion.model.rotate("ghost", { speed: 1 });`, { duration: 4, partIds: PARTS });
    expect(!unknown.ok && unknown.code).toBe("unknown-target");
  });

  it("无运动脚本合法（静态节点）", () => {
    const result = executeMotionScript("", { duration: 0 });
    expect(result.ok).toBe(true);
  });
});
