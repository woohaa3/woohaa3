/**
 * 模型镜头子资源契约测试
 * （change: add-model-editor-gizmo-shot-capture，任务 1.1 / 1.3）。
 *
 * 覆盖：规范化（丢弃未知字段/稳定排序/整条拒绝）、稳定 ID 与默认名称、基于最新 working
 * 列表的变更合并与重排、clipboard 安全收敛、runtime allowlist、命令边界校验。
 */
import { describe, expect, it } from "vitest";
import {
  applyModelCameraMutation,
  applyModelCameraMutationBatch,
  applyModelCameraMutationCommand,
  clampCameraElevation,
  createDefaultModelCamera,
  createModelCameraId,
  decodeModelCameras,
  defaultModelCameraName,
  MAX_MODEL_CAMERAS,
  MODEL_CAMERA_ASPECTS,
  MODEL_CAMERA_MAX_CAPTURE_DIMENSION,
  modelCameraAspectRatio,
  modelCameraAspectSize,
  modelCameraElevation,
  modelCameraFocusOffset,
  readModelCameras,
  renameModelCamera,
  renumberModelCameras,
  resetModelCamera,
  setModelCameraAspect,
  setModelCameraElevation,
  SHOT_CAMERA_DEFAULT_ELEVATION,
  SHOT_CAMERA_MAX_ELEVATION,
  SHOT_CAMERA_MIN_ELEVATION,
  type ModelCamera
} from "./model-cameras.js";
import { sanitizeNodeDataForClipboard, sanitizeRuntimeNodeConfigPatch } from "./domain/runtime-node-data.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { createEmptyWoohaa3ServerCanvas } from "./domain/aggregate.js";

const NOW = "2026-09-27T00:00:00.000Z";

function camera(overrides: Partial<ModelCamera> = {}): ModelCamera {
  return { id: "cam-a", name: "镜头 1", order: 0, azimuth: 0.5, elevation: SHOT_CAMERA_DEFAULT_ELEVATION, distance: 3, aspect: "16:9", ...overrides };
}

describe("decodeModelCameras", () => {
  it("规范化合法镜头：丢弃未知字段、稳定排序", () => {
    const decoded = decodeModelCameras([
      { id: "cam-b", name: "B", order: 1, azimuth: 1, elevation: 0, distance: 2, aspect: "16:9", evil: "x", url: "http://e" },
      { id: "cam-a", name: "A", order: 0, azimuth: 0, elevation: 0, distance: 1, aspect: "16:9" }
    ]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.map((camera) => camera.id)).toEqual(["cam-a", "cam-b"]);
    // 未知字段被剥离；输出的规范字段集合固定。
    expect(Object.keys(decoded.value[0]!).sort()).toEqual(["aspect", "azimuth", "distance", "elevation", "id", "name", "order"]);
    expect(decoded.value[0]!.aspect).toBe("16:9");
  });

  it("缺失 aspect / elevation 整条拒绝；已知画幅保留，未知画幅整条拒绝（design D8）", () => {
    // change: 2026-10-07-remove-residual-compatibility —— 不再兼容读取缺失字段。
    expect(decodeModelCameras([{ id: "cam-a", name: "A", order: 0, azimuth: 0, elevation: 0, distance: 1 }]).ok).toBe(false);
    expect(decodeModelCameras([{ id: "cam-a", name: "A", order: 0, azimuth: 0, distance: 1, aspect: "16:9" }]).ok).toBe(false);

    for (const aspect of MODEL_CAMERA_ASPECTS) {
      const decoded = decodeModelCameras([camera({ aspect })]);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.value[0]!.aspect).toBe(aspect);
    }

    expect(decodeModelCameras([{ ...camera(), aspect: "7:3" }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), aspect: 16 / 9 }]).ok).toBe(false);
  });

  it("整体拒绝重复 ID、非法类型、非有限数值、非正 distance、Blob/URL 对象", () => {
    expect(decodeModelCameras("nope").ok).toBe(false);
    expect(decodeModelCameras([camera(), camera()]).ok).toBe(false); // 重复 id
    expect(decodeModelCameras([{ ...camera(), azimuth: Number.NaN }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), distance: 0 }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), distance: Number.POSITIVE_INFINITY }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), order: 1.5 }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), name: "" }]).ok).toBe(false);
    expect(decodeModelCameras([{ id: "", name: "x", order: 0, azimuth: 0, elevation: 0, distance: 1, aspect: "16:9" }]).ok).toBe(false);
    // 超数量上限。
    const many = Array.from({ length: MAX_MODEL_CAMERAS + 1 }, (_, index) =>
      camera({ id: `cam-${index}`, order: index })
    );
    expect(decodeModelCameras(many).ok).toBe(false);
  });

  it("空数组是合法集合（表示删除所有镜头）", () => {
    const decoded = decodeModelCameras([]);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual([]);
  });

  it("focusOffset：缺省不携带，合法三分量规范化保留，非法整条拒绝", () => {
    const absent = decodeModelCameras([camera()]);
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.value[0]).not.toHaveProperty("focusOffset");

    const withOffset = decodeModelCameras([camera({ focusOffset: { x: 1, y: -2, z: 0.5 } })]);
    expect(withOffset.ok).toBe(true);
    if (withOffset.ok) expect(withOffset.value[0]!.focusOffset).toEqual({ x: 1, y: -2, z: 0.5 });

    // 未知字段被剥离，只保留 x/y/z。
    const stripped = decodeModelCameras([{ ...camera(), focusOffset: { x: 1, y: 2, z: 3, evil: 9 } }]);
    expect(stripped.ok).toBe(true);
    if (stripped.ok) expect(Object.keys(stripped.value[0]!.focusOffset!).sort()).toEqual(["x", "y", "z"]);

    // 非对象 / 非有限 / 缺分量 → 整条拒绝。
    expect(decodeModelCameras([{ ...camera(), focusOffset: "no" }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), focusOffset: { x: Number.NaN, y: 0, z: 0 } }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), focusOffset: { x: 1, y: 2 } }]).ok).toBe(false);
  });

  it("readModelCameras 对缺失/非法返回空数组", () => {
    expect(readModelCameras(undefined)).toEqual([]);
    expect(readModelCameras({})).toEqual([]);
    expect(readModelCameras({ modelCameras: [{ bad: true }] })).toEqual([]);
    expect(readModelCameras({ modelCameras: [camera()] })).toHaveLength(1);
  });

  it("elevation：合法半圆值保留，越界/非有限/缺失整条拒绝（change: add-shot-camera-elevation-control）", () => {
    // change: 2026-10-07-remove-residual-compatibility —— elevation 必填。
    expect(decodeModelCameras([{ ...camera(), elevation: undefined }]).ok).toBe(false);

    for (const elevation of [0, Math.PI / 4, -Math.PI / 2, Math.PI / 2]) {
      const decoded = decodeModelCameras([camera({ elevation })]);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.value[0]!.elevation).toBeCloseTo(elevation, 9);
    }

    expect(decodeModelCameras([{ ...camera(), elevation: SHOT_CAMERA_MAX_ELEVATION + 0.01 }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), elevation: SHOT_CAMERA_MIN_ELEVATION - 0.01 }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), elevation: Number.NaN }]).ok).toBe(false);
    expect(decodeModelCameras([{ ...camera(), elevation: "0.5" }]).ok).toBe(false);
  });

  it("modelCameraAspectSize 由画幅派生非零像素尺寸", () => {
    expect(modelCameraAspectRatio("16:9")).toBeCloseTo(16 / 9, 9);
    expect(modelCameraAspectRatio("9:16")).toBeCloseTo(9 / 16, 9);
    expect(modelCameraAspectRatio("21:9")).toBeCloseTo(21 / 9, 9);
    expect(modelCameraAspectSize("16:9", 1280)).toEqual({ width: 1280, height: 720 });
    expect(modelCameraAspectSize("1:1", 1280)).toEqual({ width: 1280, height: 1280 });
    expect(modelCameraAspectSize("4:5", 1280)).toEqual({ width: 1280, height: 1600 });
  });

  it("每个受支持画幅都有正比例且尺寸在长边上限内（change: expand-shot-camera-aspects）", () => {
    for (const aspect of MODEL_CAMERA_ASPECTS) {
      const ratio = modelCameraAspectRatio(aspect);
      expect(ratio).toBeGreaterThan(0);
      const size = modelCameraAspectSize(aspect, 1280);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MODEL_CAMERA_MAX_CAPTURE_DIMENSION);
      // 极端画幅等比收缩后仍保持画幅比例（四舍五入容差）。
      expect(size.width / size.height).toBeCloseTo(ratio, 1);
    }
  });
});

describe("镜头 ID / 默认名称 / 变更合并", () => {
  it("稳定 ID 由 (nodeId, 熵) 派生且不同熵不同 id", () => {
    const a = createModelCameraId({ nodeId: "n1", seed: "s" });
    const b = createModelCameraId({ nodeId: "n1", seed: "s" });
    const c = createModelCameraId({ nodeId: "n1", seed: "t" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("cam-")).toBe(true);
  });

  it("默认名称按序号生成“镜头 N”", () => {
    expect(defaultModelCameraName(0)).toBe("镜头 1");
    expect(defaultModelCameraName(4)).toBe("镜头 5");
  });

  it("createDefaultModelCamera 追加并承载 pose", () => {
    const created = createDefaultModelCamera({
      existing: [camera({ id: "cam-a", order: 0 })],
      azimuth: 1.2,
      distance: 5,
      nodeId: "n1",
      seed: "s"
    });
    expect(created.order).toBe(1);
    expect(created.name).toBe("镜头 2");
    expect(created.azimuth).toBe(1.2);
    expect(created.distance).toBe(5);
  });

  it("upsert 追加/替换并重排；remove 删除并重排", () => {
    const base = [camera({ id: "cam-a", order: 0 }), camera({ id: "cam-b", order: 1 })];
    const updated = applyModelCameraMutation(base, {
      kind: "upsert",
      camera: camera({ id: "cam-b", name: "B+", order: 99, azimuth: 2 })
    });
    expect(updated.map((camera) => camera.id)).toEqual(["cam-a", "cam-b"]);
    expect(updated.map((camera) => camera.order)).toEqual([0, 1]);
    expect(updated[1]!.name).toBe("B+");

    const added = applyModelCameraMutation(base, { kind: "upsert", camera: camera({ id: "cam-c", order: 42 }) });
    expect(added.map((camera) => camera.order)).toEqual([0, 1, 2]);

    const removed = applyModelCameraMutation(base, { kind: "remove", id: "cam-a" });
    expect(removed.map((camera) => camera.id)).toEqual(["cam-b"]);
    expect(removed[0]!.order).toBe(0);
  });

  it("upsert 在超上限时保留原列表", () => {
    const full = Array.from({ length: MAX_MODEL_CAMERAS }, (_, index) =>
      camera({ id: `cam-${index}`, order: index })
    );
    expect(applyModelCameraMutation(full, { kind: "upsert", camera: camera({ id: "cam-new" }) })).toHaveLength(
      MAX_MODEL_CAMERAS
    );
  });

  it("renumberModelCameras 分配连续 order", () => {
    expect(renumberModelCameras([camera({ order: 9 }), camera({ id: "cam-b", order: 3 })])).toEqual([
      camera({ order: 0 }),
      camera({ id: "cam-b", order: 1 })
    ]);
  });
});

describe("重命名 / 重置 / focusOffset（change: 模型编辑 gizmo 焦点）", () => {
  it("renameModelCamera 只改名称并裁剪空白/限长，非法名保留原名", () => {
    const base = [camera({ id: "cam-a", name: "A" }), camera({ id: "cam-b", name: "B" })];
    const renamed = renameModelCamera(base, "cam-a", "  正面  ");
    expect(renamed.find((c) => c.id === "cam-a")!.name).toBe("正面");
    expect(renamed.find((c) => c.id === "cam-b")!.name).toBe("B");
    // 空名称保留原名；未知名返回原副本。
    expect(renameModelCamera(base, "cam-a", "   ").find((c) => c.id === "cam-a")!.name).toBe("A");
    expect(renameModelCamera(base, "missing", "X")).toEqual(base);
    // 超长截断。
    expect(renameModelCamera(base, "cam-a", "x".repeat(200))[0]!.name.length).toBeLessThanOrEqual(80);
  });

  it("resetModelCamera 清空 focusOffset 并回到默认 pose，保留 id/name/order/aspect", () => {
    const base = [
      camera({ id: "cam-a", name: "A", order: 0, azimuth: 3, distance: 9, aspect: "1:1", elevation: 1.1, focusOffset: { x: 5, y: 6, z: 7 } })
    ];
    const reset = resetModelCamera(base, "cam-a", { azimuth: 0, distance: 2 });
    expect(reset[0]).toEqual({ id: "cam-a", name: "A", order: 0, azimuth: 0, elevation: SHOT_CAMERA_DEFAULT_ELEVATION, distance: 2, aspect: "1:1" });
    expect(reset[0]).not.toHaveProperty("focusOffset");
    // 显式默认仰角被采用并钳制。
    const withEl = resetModelCamera(base, "cam-a", { azimuth: 0, distance: 2, elevation: 9 });
    expect(withEl[0]!.elevation).toBeCloseTo(SHOT_CAMERA_MAX_ELEVATION, 9);
    expect(resetModelCamera(base, "missing", { azimuth: 0, distance: 2 })).toEqual(base);
  });

  it("setModelCameraAspect 只改画幅；未知 id/非法画幅返回原副本", () => {
    const base = [camera({ id: "cam-a", aspect: "16:9" }), camera({ id: "cam-b", order: 1, aspect: "1:1" })];
    const next = setModelCameraAspect(base, "cam-a", "4:5");
    expect(next.find((c) => c.id === "cam-a")!.aspect).toBe("4:5");
    expect(next.find((c) => c.id === "cam-b")!.aspect).toBe("1:1");
    expect(setModelCameraAspect(base, "missing", "4:5")).toEqual(base);
    expect(setModelCameraAspect(base, "cam-a", "7:3" as never)).toEqual(base);
  });

  it("modelCameraFocusOffset 缺省返回零偏移", () => {
    expect(modelCameraFocusOffset(camera())).toEqual({ x: 0, y: 0, z: 0 });
    expect(modelCameraFocusOffset(camera({ focusOffset: { x: 1, y: 2, z: 3 } }))).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("modelCameraElevation 缺省返回 45°，clampCameraElevation 钳制半圆并回退非法值", () => {
    expect(modelCameraElevation(camera())).toBeCloseTo(SHOT_CAMERA_DEFAULT_ELEVATION, 9);
    expect(modelCameraElevation(camera({ elevation: 0.2 }))).toBeCloseTo(0.2, 9);
    expect(clampCameraElevation(9)).toBeCloseTo(SHOT_CAMERA_MAX_ELEVATION, 9);
    expect(clampCameraElevation(-9)).toBeCloseTo(SHOT_CAMERA_MIN_ELEVATION, 9);
    expect(clampCameraElevation(Number.NaN)).toBeCloseTo(SHOT_CAMERA_DEFAULT_ELEVATION, 9);
  });

  it("setModelCameraElevation 只改仰角并钳制；未知 id 返回原副本", () => {
    const base = [camera({ id: "cam-a", elevation: 0.2 }), camera({ id: "cam-b", order: 1, elevation: 0.3 })];
    const next = setModelCameraElevation(base, "cam-a", 1.0);
    expect(next.find((c) => c.id === "cam-a")!.elevation).toBeCloseTo(1.0, 9);
    expect(next.find((c) => c.id === "cam-b")!.elevation).toBeCloseTo(0.3, 9);
    expect(setModelCameraElevation(base, "cam-a", 9).find((c) => c.id === "cam-a")!.elevation).toBeCloseTo(
      SHOT_CAMERA_MAX_ELEVATION,
      9
    );
    expect(setModelCameraElevation(base, "missing", 1)).toEqual(base);
  });

  it("createDefaultModelCamera 承载仰角并默认 45°", () => {
    const created = createDefaultModelCamera({ existing: [], azimuth: 0, distance: 5, nodeId: "n1", seed: "s" });
    expect(created.elevation).toBeCloseTo(SHOT_CAMERA_DEFAULT_ELEVATION, 9);
    const custom = createDefaultModelCamera({ existing: [], azimuth: 0, distance: 5, elevation: 0.3, nodeId: "n1", seed: "s" });
    expect(custom.elevation).toBeCloseTo(0.3, 9);
  });
});

describe("runtime allowlist 与 clipboard", () => {
  it("sanitizeRuntimeNodeConfigPatch 接受合法镜头并保留空数组", () => {
    const ok = sanitizeRuntimeNodeConfigPatch({ modelCameras: [camera()] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.value as { modelCameras: unknown[] }).modelCameras).toHaveLength(1);

    const cleared = sanitizeRuntimeNodeConfigPatch({ modelCameras: [] });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect((cleared.value as { modelCameras: unknown[] }).modelCameras).toEqual([]);

    const bad = sanitizeRuntimeNodeConfigPatch({ modelCameras: [{ id: "x" }] });
    expect(bad.ok).toBe(false);
  });

  it("clipboard 只复制规范化镜头，丢弃 selection/preview/URL", () => {
    const cleaned = sanitizeNodeDataForClipboard({
      title: "M",
      selectedCameraId: "cam-a",
      cameraPreviewUrl: "blob:xyz",
      modelCameras: [
        { id: "cam-a", name: "A", order: 0, azimuth: 0, distance: 1, previewUrl: "http://e" },
        { id: "cam-a", name: "dup", order: 1, azimuth: 0, distance: 1 }
      ]
    });
    // 非法（重复 id）→ 整个 modelCameras 被丢弃；session/URL 字段本就不在白名单。
    expect(cleaned).not.toHaveProperty("modelCameras");
    expect(cleaned).not.toHaveProperty("cameraPreviewUrl");
    expect(cleaned).not.toHaveProperty("selectedCameraId");

    const valid = sanitizeNodeDataForClipboard({ modelCameras: [camera()] });
    expect((valid as { modelCameras: ModelCamera[] }).modelCameras).toHaveLength(1);
  });
});

describe("命令边界校验（nodeData.patch）", () => {
  function canvasWithModel() {
    const base = createEmptyWoohaa3ServerCanvas("c1", NOW);
    return {
      ...base,
      revision: 1,
      document: { ...base.document, nodes: [{ id: "m1", type: "model3d", position: { x: 0, y: 0 } }] },
      nodeData: {
        m1: {
          title: "M",
          modelScript: "scene.box({ id: 'body' });",
          modelScriptLanguage: "javascript",
          modelScriptVersion: "woohaa-model-js-v2",
          modelContentVersion: { revision: 1, sourceHash: "s", contentHash: "c" },
          modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }
        }
      }
    };
  }

  it("合法镜头 patch 写回规范化排序值", () => {
    const outcome = applyCanvasCommands(
      canvasWithModel(),
      [
        {
          type: "nodeData.patch",
          nodeId: "m1",
          value: {
            modelCameras: [
              { id: "cam-b", name: "B", order: 1, azimuth: 1, elevation: 0, distance: 2, aspect: "16:9" },
              { id: "cam-a", name: "A", order: 0, azimuth: 0, elevation: 0, distance: 1, aspect: "16:9" }
            ]
          } as never
        }
      ],
      { now: NOW }
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const cameras = (outcome.canvas.nodeData.m1 as { modelCameras: ModelCamera[] }).modelCameras;
    expect(cameras.map((camera) => camera.id)).toEqual(["cam-a", "cam-b"]);
  });

  it("非法镜头 patch 整批拒绝", () => {
    const outcome = applyCanvasCommands(
      canvasWithModel(),
      [{ type: "nodeData.patch", nodeId: "m1", value: { modelCameras: [{ id: "x" }] } as never }],
      { now: NOW }
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("invalid-model-cameras");
  });
});

describe("applyModelCameraMutationCommand（change: add-model-camera-mcp-crud）", () => {
  const base: ModelCamera[] = [
    { id: "cam-a", name: "正面", order: 0, azimuth: 0, elevation: 0.5, distance: 3, aspect: "16:9" }
  ];

  it("create 保留 elevation/aspect/focusOffset", () => {
    const result = applyModelCameraMutationCommand(
      base,
      { kind: "create", azimuth: 1, distance: 4, elevation: -0.25, aspect: "4:5", focusOffset: { x: 0, y: 1, z: 0 } },
      { nodeId: "m1", seed: "s" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cameras).toHaveLength(2);
    expect(result.cameras[1]).toMatchObject({
      elevation: -0.25,
      aspect: "4:5",
      focusOffset: { x: 0, y: 1, z: 0 }
    });
  });

  it("create 越界 elevation 被钳制进 [-90°, +90°]", () => {
    const result = applyModelCameraMutationCommand(
      base,
      { kind: "create", azimuth: 0, distance: 2, elevation: 10 },
      { nodeId: "m1", seed: "s" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cameras[1]!.elevation).toBeCloseTo(SHOT_CAMERA_MAX_ELEVATION, 9);
  });

  it("update 只改 elevation 且保留其它字段", () => {
    const result = applyModelCameraMutationCommand(base, { kind: "update", id: "cam-a", elevation: 0.9 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cameras[0]!.elevation).toBe(0.9);
    expect(result.cameras[0]!.azimuth).toBe(0);
    expect(result.cameras[0]!.aspect).toBe("16:9");
  });

  it("reset 清 focusOffset 并采用给定 elevation（含默认）", () => {
    const withFocus: ModelCamera[] = [{ ...base[0]!, focusOffset: { x: 9, y: 9, z: 9 } }];
    const explicit = applyModelCameraMutationCommand(withFocus, { kind: "reset", id: "cam-a", azimuth: 0, distance: 2, elevation: 0.1 });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.cameras[0]!.elevation).toBe(0.1);
    expect(explicit.cameras[0]!.focusOffset).toBeUndefined();

    const fallback = applyModelCameraMutationCommand(withFocus, { kind: "reset", id: "cam-a", azimuth: 0, distance: 2 });
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect(fallback.cameras[0]!.elevation).toBeCloseTo(SHOT_CAMERA_DEFAULT_ELEVATION, 9);
  });
});

describe("applyModelCameraMutationBatch（change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.4）", () => {
  it("顺序重放整批变更并返回最终规范化集合", () => {
    const current: ModelCamera[] = [
      camera({ id: "cam-a", name: "正面", order: 0 }),
      camera({ id: "cam-b", name: "右侧", order: 1, azimuth: 1 })
    ];
    const result = applyModelCameraMutationBatch(current, [
      { kind: "update", id: "cam-a", distance: 9 },
      { kind: "rename", id: "cam-b", name: "主视角" },
      { kind: "remove", id: "cam-a" }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cameras).toHaveLength(1);
    expect(result.cameras[0]!.name).toBe("主视角");
  });

  it("任一条非法即整批拒绝并报告失败下标", () => {
    const current: ModelCamera[] = [camera({ id: "cam-a" })];
    const result = applyModelCameraMutationBatch(current, [
      { kind: "update", id: "cam-a", distance: 4 },
      { kind: "remove", id: "missing" }
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedIndex).toBe(1);
    expect(result.code).toBe("unknown-camera");
  });

  it("空列表或超上限拒绝", () => {
    expect(applyModelCameraMutationBatch([], []).ok).toBe(false);
    const tooMany = Array.from({ length: 100 }, () => ({ kind: "create" as const, azimuth: 0, distance: 1 }));
    const result = applyModelCameraMutationBatch([], tooMany);
    expect(result.ok).toBe(false);
  });
});
