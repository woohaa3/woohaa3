import { afterEach, expect, it, vi } from "vitest";
import {
  applyCanvasCommands,
  createEmptyWoohaa3ServerCanvas,
  createFilmSetGroupMarker,
  createModel3DNodeData,
  filmSetAnimationsOf,
  model3DNodeDataFields,
  planCanvasEdit,
  readFilmSetAnimationProjection,
  staticShotCameraMotion,
  type ServerCanvas
} from "@woohaa3/contracts";
import { createDragGestureFamily } from "./drag-gesture.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

const MODEL_SCRIPT = `scene.box({ id: "root" });`;

function motionScript() {
  return {
    motionScript: "motion.model.rotate('root', { speed: 1 });",
    motionScriptLanguage: "javascript" as const,
    motionScriptVersion: "woohaa-motion-js-v1" as const,
    revision: 1,
    sourceHash: "motion-v1",
    basedOnModelVersion: { revision: 1, contentHash: "model-v1" }
  };
}

function filmSetCanvas(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("film-drag");
  canvas.document.nodes = [
    { id: "film", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
    { id: "model", type: "model3d", parentId: "film", position: { x: 20, y: 20 }, width: 180, height: 64 }
  ];
  const motion = motionScript();
  const playback = { startTime: 0, duration: 2, timeScale: 1, loop: false };
  canvas.nodeData.model = model3DNodeDataFields(createModel3DNodeData({
    title: "模型",
    model: { modelScript: MODEL_SCRIPT, modelScriptVersion: "woohaa-model-js-v2" }
  })) as never;
  canvas.nodeData.film = {
    filmSetGroup: createFilmSetGroupMarker({
      sceneBindings: [{
        bindingId: "binding", sourceNodeId: "model", kind: "model3d",
        transform: { x: 0, y: 0, z: 0, yaw: 0, scale: 1 }, visibility: true,
        contentKey: "model3d:v1", animation: { motion, playback }
      }],
      clips: [{
        id: "shot", name: "镜头", duration: 2, cameraMotion: staticShotCameraMotion(),
        bindings: [{ itemId: "binding", motion, playback }]
      }]
    })
  };
  return canvas;
}

function dragCommands(source: ServerCanvas, id: string, from: { x: number; y: number }, at: { x: number; y: number }) {
  woohaa3CanvasStore.getState().applyRemoteCanvas(source);
  const family = createDragGestureFamily({ state: {}, submit: vi.fn(), buildScene: () => null,
    schedule: vi.fn(), clearHeldKeys: vi.fn() } as unknown as Parameters<typeof createDragGestureFamily>[0]);
  return family.dragDropCommands(new Map([[id, from]]), new Map([[id, at]]));
}

function release(source: ServerCanvas, id: string, from: { x: number; y: number }, at: { x: number; y: number }) {
  return applyCanvasCommands(source, dragCommands(source, id, from, at));
}

afterEach(() => woohaa3CanvasStore.getState().applyWorkingCanvas(null));

it("dragging a film-set model out soft-detaches the binding and dragging it back restores the animation", () => {
  const source = filmSetCanvas();
  const out = release(source, "model", { x: 20, y: 20 }, { x: 900, y: 600 });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.canvas.document.nodes.find(node => node.id === "model")?.parentId).toBeUndefined();
  const detached = out.canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!;
  expect(detached.detached).toBe(true);
  expect(detached.animation?.motion.motionScript).toBe(motionScript().motionScript);
  expect(readFilmSetAnimationProjection(out.canvas, "film")?.filmSetContent.items).toHaveLength(0);

  const back = release(out.canvas, "model", { x: 900, y: 600 }, { x: 20, y: 20 });
  expect(back.ok).toBe(true);
  if (!back.ok) return;
  expect(back.canvas.document.nodes.find(node => node.id === "model")?.parentId).toBe("film");
  const restored = back.canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!;
  expect(restored.detached).toBeUndefined();
  expect(restored.animation?.motion.motionScript).toBe(motionScript().motionScript);
  const animation = readFilmSetAnimationProjection(back.canvas, "film");
  expect(animation && filmSetAnimationsOf(animation).clips[0]?.bindings?.[0]?.motion?.motionScript).toBe(motionScript().motionScript);
});

it("records the soft detach in the protected edit plan so undo restores the binding", () => {
  const source = filmSetCanvas();
  const plan = planCanvasEdit(source, dragCommands(source, "model", { x: 20, y: 20 }, { x: 900, y: 600 }));
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  const out = applyCanvasCommands(source, [{ type: "edit.apply", ...plan.forward }]);
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.detached).toBe(true);
  const undo = applyCanvasCommands(out.canvas, [{ type: "edit.apply", ...plan.inverse }]);
  expect(undo.ok).toBe(true);
  if (!undo.ok) return;
  expect(undo.canvas.document.nodes.find(node => node.id === "model")?.parentId).toBe("film");
  expect(undo.canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.detached).toBeUndefined();
  expect(undo.canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.animation?.motion.motionScript).toBe(motionScript().motionScript);
});
