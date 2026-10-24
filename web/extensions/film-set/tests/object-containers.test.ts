/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { applyCanvasCommands, canonicalFilmSetFields, createFilmSetSnapshot, createEmptyWoohaa3ServerCanvas, createModel3DNodeData, model3DNodeDataFields, filmSetObjectContainerId, resolveFilmSetObject, planCanvasEdit } from "@woohaa3/contracts";
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

describe("对象容器公开交互", () => {
  it("打开已有片场自动补齐所有对象，不需要手动引出且不进入用户历史", async () => {
    const h = harness(), dispose = installFilmSetObjectContainers(h.ctx);
    const id = filmSetObjectContainerId("film", "actor");
    expect(resolveFilmSetObject(h.canvas(), id)?.item.id).toBe("actor");
    expect(h.submitCommands).toHaveBeenCalledTimes(1);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.contributions.has("canvas.node-action")).toBe(false);
    expect(h.contributions.has("canvas.context-menu")).toBe(false);
    await Promise.resolve(); h.notify();
    expect(h.submitCommands).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("关闭容器保留对象，重开插件不补回；显示后重建；只读不提交", async () => {
    const h = harness();
    let dispose = installFilmSetObjectContainers(h.ctx);
    const id = filmSetObjectContainerId("film", "actor");
    expect((await setFilmSetObjectContainerVisible(h.ctx, "film", "actor", false)).ok).toBe(true);
    expect(h.canvas().document.nodes.some(node => node.id === id)).toBe(false);
    expect(h.canvas().nodeData.film.filmSetContent).toBeDefined();
    dispose(); dispose = installFilmSetObjectContainers(h.ctx);
    expect(h.canvas().document.nodes.some(node => node.id === id)).toBe(false);
    expect((await setFilmSetObjectContainerVisible(h.ctx, "film", "actor", true)).ok).toBe(true);
    expect(resolveFilmSetObject(h.canvas(), id)?.item.id).toBe("actor");
    h.readonly();
    expect((await setFilmSetObjectContainerVisible(h.ctx, "film", "actor", false)).ok).toBe(false);
    dispose();
  });

  it("只读打开不写入，恢复写权限后自动补齐", () => {
    const h = harness(); h.readonly();
    const dispose = installFilmSetObjectContainers(h.ctx);
    expect(h.submitCommands).not.toHaveBeenCalled();
    h.writeable();
    expect(resolveFilmSetObject(h.canvas(), filmSetObjectContainerId("film", "actor"))).not.toBeNull();
    dispose();
  });

  it("只接收一个普通模型；替换更新容器资源且来源不移动；释放清理所有贡献", async () => {
    const h = harness();
    const dispose = installFilmSetObjectContainers(h.ctx);
    const drop = h.contributions.get("canvas.node-drop");
    const id = filmSetObjectContainerId("film", "actor");
    const input = () => ({ canvas: h.canvas(), targetNodeId: id, sourceNodeIds: ["model"] });
    expect(drop.matchesTarget(input())).toBe(true);
    expect(drop.acceptsSources(input())).toBe(true);
    expect(drop.acceptsSources({ ...input(), sourceNodeIds: ["image"] })).toBe(false);
    expect(drop.acceptsSources({ ...input(), sourceNodeIds: ["model", "image"] })).toBe(false);
    const adapter = createFilmSetModelAdapter(undefined, h.canvas);
    expect(adapter.scopeShapeForNode?.(id, h.canvas().nodeData[id])).toBe("rect");
    const key = adapter.executionKey(h.canvas().nodeData[id], id);
    expect(adapter.prepare(id, h.canvas().nodeData[id])).not.toBeNull();
    expect(drop.onDrop(input())).toBe(true);
    await vi.waitFor(() => expect(resolveFilmSetObject(h.canvas(), id)?.item).toMatchObject({ kind: "model", model: { modelScript: "scene.sphere({id:'new',radius:1});" } }));
    expect(adapter.executionKey(h.canvas().nodeData[id], id)).not.toBe(key);
    expect(h.canvas().document.nodes.find(node => node.id === "model")?.position).toEqual({ x: 400, y: 0 });
    h.readonly();
    const count = h.record.mock.calls.length;
    drop.onDrop(input());
    expect(h.record).toHaveBeenCalledTimes(count);
    dispose();
    expect(h.contributions.size).toBe(0);
  });
});
