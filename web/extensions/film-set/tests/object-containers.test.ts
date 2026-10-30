import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { applyCanvasCommands, planCanvasEdit } from "../../../test-support/managed-shot-commands.js";
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { decodeFilmSetNodeData, canonicalFilmSetFields, createFilmSetSnapshot, createEmptyWoohaa3ServerCanvas, createModel3DNodeData, model3DNodeDataFields, filmSetAnimationsOf, shotPreviewNodeId } from "@woohaa3/contracts";
import { installFilmSetObjectContainers } from "../src/authoring/browser/object-containers.js";
import { setFilmSetObjectContainerVisible } from "../src/authoring/browser/object-container-commands.js";
import { createFilmSetModelAdapter } from "../src/preview/browser/model-adapter.js";
import type { FilmSetContext } from "../src/integration/browser/context.js";

function harness() {
  let canvas = createEmptyWoohaa3ServerCanvas("objects");
  canvas.document.nodes = [
    { id: "film", type: "composite-asset", position: { x: 0, y: 0 } },
    { id: "model", type: "model3d", position: { x: 400, y: 0 } },
    { id: "image", type: "image", position: { x: 700, y: 0 } }
  ];
  canvas.nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "片场", modelItemId: "actor", model: { modelScript: "scene.box({id:'body',size:[1,1,1]});", modelScriptVersion: "woohaa-model-js-v2" }, timeline: { duration: 0, loop: false } })) as never;
  canvas.nodeData.model = model3DNodeDataFields(createModel3DNodeData({ title: "替换模型", model: { modelScript: "scene.sphere({id:'new',radius:1});", modelScriptVersion: "woohaa-model-js-v2" } })) as never;
  const contributions = new Map<string, any>();
  let writable = true;
  const locate = vi.fn();
  const stateListeners = new Set<() => void>();
  const sessionListeners = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const submitCommands = vi.fn((commands: Parameters<typeof applyCanvasCommands>[1]) => {
    const result = applyCanvasCommands(canvas, commands);
    if (!result.ok) return { ok: false };
    canvas = result.canvas;
    for (const listener of stateListeners) listener();
    return { ok: true, handle: { settled: Promise.resolve() } };
  });
  const record = vi.fn(async (commands: Parameters<typeof applyCanvasCommands>[1]) => {
    const plan = planCanvasEdit(canvas, commands);
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const result = applyCanvasCommands(canvas, [{ type: "edit.apply", ...plan.forward }]);
    if (!result.ok) return { ok: false, reason: result.rejection.message };
    canvas = result.canvas;
    return { ok: true };
  });
  const ctx = {
    compositeAssets: { invalidate: vi.fn() },
    slots: { register: (slot: string, contribution: any) => { contributions.set(slot, contribution); return () => contributions.delete(slot); } },
    canvasState: { getCanvas: () => canvas, getWorkingCanvas: () => canvas, subscribe: subscribe(stateListeners) },
    canvasSession: { isWritable: () => writable, subscribe: subscribe(sessionListeners), submitCommands }, canvasEdit: { record }, canvasLocate: { locateNodes: locate }
  } as unknown as FilmSetContext;
  return { ctx, contributions, record, locate, submitCommands, notify: () => { for (const listener of stateListeners) listener(); }, canvas: () => canvas, readonly: () => { writable = false; }, writeable: () => { writable = true; for (const listener of sessionListeners) listener(); } };
}

describe("对象容器迁移兼容入口", () => {
  it("打开旧片场不会派生对象节点、注册 drop target 或写入画布", () => {
    const h = harness();
    const before = JSON.stringify(h.canvas());
    const dispose = installFilmSetObjectContainers(h.ctx);
    h.notify(); h.readonly(); h.writeable();
    expect(JSON.stringify(h.canvas())).toBe(before);
    expect(h.submitCommands).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.contributions.size).toBe(0);
    expect(createFilmSetModelAdapter(undefined, h.canvas).children!(h.canvas(), "film").filter(child => child.kind === "container")).toEqual([]);
    dispose();
  });

  it("显示/关闭旧对象容器入口均拒绝，且不会生成命令", async () => {
    const h = harness();
    for (const visible of [true, false]) {
      expect((await setFilmSetObjectContainerVisible(h.ctx, "film", "actor", visible)).ok).toBe(false);
    }
    expect(h.record).not.toHaveBeenCalled();
    expect(h.submitCommands).not.toHaveBeenCalled();
  });
});


it("镜头始终外显，忽略旧隐藏设置，不再外显对象容器", () => {
  const h = harness();
  h.canvas().nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "片场", model: { modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" }, motionScript: "motion.model.rotate('body', { speed: 1 });", timeline: { duration: 5, loop: false } })) as never;
  const decoded = decodeFilmSetNodeData(h.canvas().nodeData.film);
  if (!decoded.ok) throw new Error(decoded.reason);
  const clip = filmSetAnimationsOf(decoded.value).clips[0];
  const id = shotPreviewNodeId("film", clip.id);
  h.canvas().nodeData.film.filmSetShotPreviewsHidden = [clip.id];
  h.submitCommands([]);
  const migrated = migrateFilmSetFixture(h.canvas(), "film");
  const children = createFilmSetModelAdapter().children!(migrated, "film");
  expect(children.find(child => child.nodeId === id)).toMatchObject({ kind: "entity" });
  expect(children.find(child => child.nodeId === id)?.closable).not.toBe(true);
  expect(children.filter(child => child.kind === "container")).toEqual([]);
  expect(decodeFilmSetNodeData(h.canvas().nodeData.film)).toEqual(decoded);
});
