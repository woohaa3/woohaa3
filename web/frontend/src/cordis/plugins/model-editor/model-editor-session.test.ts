/**
 * 模型编辑会话测试
 * （change: add-model-editor-gizmo-shot-capture，任务 2.2 / 2.3 / 3.4）。
 */
import { describe, expect, it } from "vitest";
import { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import type { ModelCamera } from "@woohaa3/contracts";

function camera(overrides: Partial<ModelCamera> = {}): ModelCamera {
  return { id: "cam-a", name: "镜头 1", order: 0, azimuth: 0.2, elevation: Math.PI / 4, distance: 5, aspect: "16:9", ...overrides };
}

function harness(initial: ModelCamera[] = [], writable = true) {
  let cameras = [...initial];
  const submitted: Array<{ nodeId: string; cameras: ModelCamera[] }> = [];
  const revoked: string[] = [];
  const session = new ModelEditorSession({
    readCameras: () => cameras,
    isWritable: () => writable,
    submitCameras: (nodeId, next) => {
      submitted.push({ nodeId, cameras: [...next] });
      cameras = [...next];
      return true;
    },
    revokeObjectUrl: (url) => revoked.push(url)
  });
  return { session, submitted, revoked, setCameras: (next: ModelCamera[]) => { cameras = [...next]; } };
}

describe("ModelEditorSession", () => {
  it("enter 默认镜头模式并自动选中第一条镜头", () => {
    const h = harness([camera({ id: "cam-a" })]);
    h.session.enter("m1");
    const state = h.session.getState();
    expect(state.nodeId).toBe("m1");
    expect(state.toolMode).toBe("camera");
    // 已有镜头时自动选中，使场景 gizmo 立即出现。
    expect(state.selectedCameraId).toBe("cam-a");
  });

  it("无镜头时 enter 选中为 null", () => {
    const h = harness([]);
    h.session.enter("m1");
    expect(h.session.getState().toolMode).toBe("camera");
    expect(h.session.getState().selectedCameraId).toBeNull();
  });

  it("selectCamera 进入镜头模式并选中", () => {
    const h = harness([camera({ id: "cam-a" }), camera({ id: "cam-b", order: 1 })]);
    h.session.enter("m1");
    h.session.selectCamera("cam-b");
    expect(h.session.getState().selectedCameraId).toBe("cam-b");
    expect(h.session.getState().toolMode).toBe("camera");
  });

  it("添加镜头：稳定 ID/默认名称/默认 pose，选中并提交一次", () => {
    const h = harness([]);
    h.session.enter("m1");
    const created = h.session.addCamera({ azimuth: 0.5, distance: 4, seed: "s" });
    expect(created).not.toBeNull();
    expect(created!.name).toBe("镜头 1");
    expect(h.session.getState().selectedCameraId).toBe(created!.id);
    expect(h.session.getState().toolMode).toBe("camera");
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.cameras).toHaveLength(1);
  });

  it("只读时不提交，但仍更新本地选择", () => {
    const h = harness([], false);
    h.session.enter("m1");
    h.session.addCamera({ azimuth: 0, distance: 3, seed: "s" });
    expect(h.submitted).toHaveLength(0);
    expect(h.session.getState().selectedCameraId).not.toBeNull();
  });

  it("删除选中镜头后选中回退到第一条剩余镜头", () => {
    const h = harness([camera({ id: "cam-a" }), camera({ id: "cam-b", order: 1 })]);
    h.session.enter("m1");
    h.session.selectCamera("cam-b");
    h.session.removeCamera("cam-b");
    expect(h.session.getState().selectedCameraId).toBe("cam-a");
    expect(h.submitted.at(-1)!.cameras.map((camera) => camera.id)).toEqual(["cam-a"]);
  });

  it("pose 手势：preview 不提交，结束有净变化才提交一次并从最新列表重放", () => {
    const h = harness([camera({ id: "cam-a" }), camera({ id: "cam-b", order: 1, azimuth: 1, distance: 8 })]);
    h.session.enter("m1");
    h.session.selectCamera("cam-a");
    h.session.beginPose();
    h.session.updatePose({ azimuth: 0.9, distance: 4 });
    expect(h.submitted).toHaveLength(0); // preview 期间不写
    h.session.endPose();
    expect(h.submitted).toHaveLength(1);
    const next = h.submitted[0]!.cameras;
    // cam-b 未被覆盖。
    expect(next.find((camera) => camera.id === "cam-b")).toMatchObject({ azimuth: 1, distance: 8 });
    expect(next.find((camera) => camera.id === "cam-a")).toMatchObject({ azimuth: 0.9, distance: 4 });
  });

  it("截图前把预览中的方位写入镜头", () => {
    const h = harness([camera({ id: "cam-a", azimuth: 0.2, distance: 5 })]);
    h.session.enter("m1");
    h.session.beginPose();
    h.session.updatePose({ azimuth: 1.4, distance: 6 });
    expect(h.submitted).toHaveLength(0);
    h.session.commitForCapture();
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.cameras[0]).toMatchObject({ azimuth: 1.4, distance: 6 });
    expect(h.session.getState().posePreview).toBeNull();
  });

  it("pose 无净变化不提交", () => {
    const h = harness([camera({ azimuth: 0.2, distance: 5 })]);
    h.session.enter("m1");
    h.session.selectCamera("cam-a");
    h.session.beginPose();
    h.session.updatePose({ azimuth: 0.2, distance: 5 });
    h.session.endPose();
    expect(h.submitted).toHaveLength(0);
  });

  it("截图 preview URL 在 exit/替换时被撤销", () => {
    const h = harness();
    h.session.enter("m1");
    h.session.setCapturePreview("blob:one");
    h.session.setCapturePreview("blob:two");
    expect(h.revoked).toEqual(["blob:one"]);
    h.session.exit();
    expect(h.revoked).toContain("blob:two");
    expect(h.session.getState().previewUrl).toBeNull();
  });

  it("captureBusy 覆盖 rendering/uploading/submitting", () => {
    const h = harness();
    h.session.enter("m1");
    expect(h.session.captureBusy).toBe(false);
    h.session.setCapturePhase("uploading");
    expect(h.session.captureBusy).toBe(true);
    h.session.setCapturePhase("failed", "boom");
    expect(h.session.captureBusy).toBe(false);
    expect(h.session.getState().captureError).toBe("boom");
  });
});

describe("焦点手势 / 重命名 / 重置（change: 模型编辑 gizmo 焦点）", () => {
  it("焦点手势：preview 不提交，结束有净变化才提交一次且保留其它镜头", () => {
    const h = harness([
      camera({ id: "cam-a" }),
      camera({ id: "cam-b", order: 1, focusOffset: { x: 9, y: 9, z: 9 } })
    ]);
    h.session.enter("m1");
    h.session.selectCamera("cam-a");
    expect(h.session.beginFocus()).toBe(true);
    h.session.updateFocus({ x: 1, y: 2, z: 3 });
    expect(h.submitted).toHaveLength(0);
    h.session.endFocus();
    expect(h.submitted).toHaveLength(1);
    const next = h.submitted[0]!.cameras;
    expect(next.find((camera) => camera.id === "cam-a")!.focusOffset).toEqual({ x: 1, y: 2, z: 3 });
    expect(next.find((camera) => camera.id === "cam-b")!.focusOffset).toEqual({ x: 9, y: 9, z: 9 });
    expect(h.session.getState().focusPreview).toBeNull();
  });

  it("焦点无净变化不提交", () => {
    const h = harness([camera()]);
    h.session.enter("m1");
    // enter 自动选中第一条镜头，因此 beginFocus 可进入。
    expect(h.session.getState().selectedCameraId).toBe("cam-a");
    h.session.beginFocus();
    h.session.updateFocus({ x: 0, y: 0, z: 0 });
    h.session.endFocus();
    expect(h.submitted).toHaveLength(0);
  });

  it("无选中镜头时不进入焦点手势", () => {
    const h = harness([]);
    h.session.enter("m1");
    expect(h.session.getState().selectedCameraId).toBeNull();
    expect(h.session.beginFocus()).toBe(false);
  });

  it("重命名选中镜头提交一次；空名不动", () => {
    const h = harness([camera({ id: "cam-a", name: "旧名" })]);
    h.session.enter("m1");
    h.session.selectCamera("cam-a");
    h.session.renameSelectedCamera("新名");
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.cameras[0]!.name).toBe("新名");
    h.session.renameSelectedCamera("   ");
    expect(h.submitted).toHaveLength(1); // 空名不提交
  });

  it("重置镜头清空 focusOffset 并回到默认 pose，保留画幅", () => {
    const h = harness([camera({ id: "cam-a", azimuth: 3, elevation: 1.1, distance: 9, aspect: "1:1", focusOffset: { x: 1, y: 2, z: 3 } })]);
    h.session.enter("m1");
    h.session.selectCamera("cam-a");
    h.session.resetSelectedCamera({ azimuth: 0, distance: 2 });
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.cameras[0]).toEqual({
      id: "cam-a",
      name: "镜头 1",
      order: 0,
      azimuth: 0,
      elevation: Math.PI / 4,
      distance: 2,
      aspect: "1:1"
    });
  });

  it("仰角直接字段提交一次 patch 并钳制（change: add-shot-camera-elevation-control）", () => {
    const h = harness([camera({ id: "cam-a" })]);
    h.session.enter("m1");
    h.session.selectCamera("cam-a");
    h.session.commitElevation(0.3);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.cameras[0]!.elevation).toBeCloseTo(0.3, 9);
    // 越界被钳到半圆端点。
    h.session.commitElevation(10);
    expect(h.submitted[1]!.cameras[0]!.elevation).toBeCloseTo(Math.PI / 2, 9);
    // 相同仰角无净变化不提交。
    h.session.commitElevation(Math.PI / 2);
    expect(h.submitted).toHaveLength(2);
  });

  it("画幅直接字段提交一次 patch（change: fix-model-focus-navigation-and-camera-parity D8）", () => {
    const h = harness([camera({ id: "cam-a", aspect: "16:9" })]);
    h.session.enter("m1");
    h.session.commitAspect("4:5");
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.cameras[0]!.aspect).toBe("4:5");
    // 相同画幅无净变化不提交。
    h.session.commitAspect("4:5");
    expect(h.submitted).toHaveLength(1);
  });

  it("方位/距离直接字段与 pose 手势等价，单次提交", () => {
    const h = harness([camera({ id: "cam-a", azimuth: 0.2, distance: 5 })]);
    h.session.enter("m1");
    h.session.commitAzimuth(Math.PI / 2);
    h.session.commitDistance(7);
    expect(h.submitted).toHaveLength(2);
    const last = h.submitted.at(-1)!.cameras[0]!;
    expect(last.azimuth).toBeCloseTo(Math.PI / 2, 9);
    expect(last.distance).toBe(7);
  });

  it("只读时焦点/重命名/重置不提交", () => {
    const h = harness([camera({ id: "cam-a" })], false);
    h.session.enter("m1");
    h.session.selectCamera("cam-a");
    h.session.beginFocus();
    h.session.updateFocus({ x: 1, y: 0, z: 0 });
    h.session.endFocus();
    h.session.renameSelectedCamera("X");
    h.session.resetSelectedCamera({ azimuth: 0, distance: 1 });
    expect(h.submitted).toHaveLength(0);
  });

  it("effectiveFocus 优先 preview，否则镜头值", () => {
    const h = harness([camera({ id: "cam-a", focusOffset: { x: 5, y: 0, z: 0 } })]);
    h.session.enter("m1");
    h.session.selectCamera("cam-a");
    expect(h.session.effectiveFocus(h.session.selectedCamera()!)).toEqual({ x: 5, y: 0, z: 0 });
    h.session.beginFocus();
    h.session.updateFocus({ x: -1, y: -2, z: -3 });
    expect(h.session.effectiveFocus(h.session.selectedCamera()!)).toEqual({ x: -1, y: -2, z: -3 });
  });
});
