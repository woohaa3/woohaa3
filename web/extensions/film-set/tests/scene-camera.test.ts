import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { createEmptyWoohaa3ServerCanvas, readFilmSetAnimationProjection } from "@woohaa3/contracts";
import { describe, expect, it, vi } from "vitest";
import { canonicalFilmSetFields, createFilmSetSnapshot, createMotionSnapshot, type FilmSetAnimationClip } from "@woohaa3/contracts";
import { ModelEditorSession } from "@woohaa3/frontend/extension-api";
import { filmSetEditorCameras, sceneCameraWriter } from "../src/authoring/browser/scene-camera.js";
import type { FilmSetHostContext } from "../src/state/browser/host-ports.js";

function shot(id: string, distance: number): FilmSetAnimationClip {
  return { id, name: id, kind: "static", timeline: { duration: 0, loop: false },
    initialCamera: { azimuth: 0.3, elevation: 0.4, distance, aspect: "4:3", focusOffset: { x: 2, y: 3, z: 4 } },
    cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }), bindings: [] };
}

function harness(writable = true) {
  const clips = [shot("a", 6), shot("b", 12)];
  const legacy = canonicalFilmSetFields({ ...createFilmSetSnapshot({ title: "片场", model: { modelScript: 'scene.box({ id: "body" });', modelScriptVersion: "woohaa-model-js-v2" }, timeline: { duration: 0, loop: false } }),
    filmSetAnimations: { schemaVersion: 3, defaultClipId: "a", clips } });
  const original = createEmptyWoohaa3ServerCanvas("c");
  original.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
  original.nodeData.film = legacy as never;
  const canvas = migrateFilmSetFixture(original, "film");
  const data = canvas.nodeData.film;
  let chosen: string | null = null;
  const submit = vi.fn(() => ({ ok: true })) as unknown as ReturnType<typeof vi.fn<FilmSetHostContext["canvasSession"]["submitCommands"]>>;
  const write = sceneCameraWriter(submit, () => data, id => readFilmSetAnimationProjection(canvas, id));
  const session = new ModelEditorSession({ readCameras: () => filmSetEditorCameras(data, chosen), isWritable: () => writable, submitCameras: write });
  session.enter("film");
  return { data, clips, submit, write, session, select: (id: string) => { chosen = id; session.enter("film"); } };
}

describe("镜头相机自动保存", () => {
  it("小预览直接读取默认/选中镜头的构图，切换不产生写入", () => {
    const h = harness();
    expect(h.session.selectedCamera()).toMatchObject({ id: "clip:a", ...h.clips[0]!.initialCamera });
    h.select("b");
    expect(h.session.selectedCamera()).toMatchObject({ id: "clip:b", ...h.clips[1]!.initialCamera });
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("每次结束拖动就原子更新当前镜头和场景相机，不需手动应用", () => {
    const h = harness();
    h.select("b");
    h.session.beginPose();
    h.session.updatePose({ azimuth: 0.8, elevation: 0.6, distance: 20, aspect: "16:9" });
    expect(h.submit).not.toHaveBeenCalled();
    h.session.endPose();
    const camera = { azimuth: 0.8, elevation: 0.6, distance: 20, aspect: "16:9", focusOffset: { x: 2, y: 3, z: 4 } };
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ type: "extension.command", extensionId: "film-set", kind: "clip.patch", nodeId: "film", payload: { clipId: "b", expectedHash: expect.any(String), op: { kind: "camera", initialCamera: camera } } })
    ]);
    expect(h.clips[0]!.initialCamera.distance).toBe(6);
  });

  it("注视点和画幅的直接修改同样自动同步", () => {
    const h = harness();
    h.session.commitAspect("1:1");
    h.session.beginFocus();
    h.session.updateFocus({ x: 8, y: 9, z: 10 });
    h.session.endFocus();
    expect(h.submit).toHaveBeenCalledTimes(2);
    expect(h.submit.mock.calls[1]![0]).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ clipId: "a", op: { kind: "camera", initialCamera: expect.objectContaining({ aspect: "1:1", focusOffset: { x: 8, y: 9, z: 10 } }) } }) }));
  });

  it("被删除镜头的迟到写入不会改到其他镜头，且只读编辑不提交", () => {
    const h = harness(false);
    h.session.commitDistance(30);
    expect(h.write("film", [{ ...h.session.selectedCamera()!, id: "clip:removed" }])).toBe(false);
    expect(h.submit).not.toHaveBeenCalled();
  });
});
