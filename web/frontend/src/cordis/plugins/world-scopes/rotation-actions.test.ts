import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, prepareModelResource, modelGroundAnchorLocal, worldModelGroundAnchor,
  createWorldAnimationScript, executeWorldAnimationScript, sampleWorldAnimationInArea, quatMul,
  type ServerCanvas, type WorldPreparedAuthoritySnapshot } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { projectWorldRotationPreview, setWorldRotationPreview } from "../../services/world-rotation-preview.js";
import { createWorldRotationActions, rotatedAreaData, type WorldRotationActions } from "./rotation-actions.js";

let actions: WorldRotationActions | undefined;
afterEach(() => { actions?.dispose(); actions = undefined; setWorldRotationPreview(null); });

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("rotation-test");
  canvas.document.nodes.push({ id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "model", type: "model3d", position: { x: 0, y: 0 } });
  canvas.nodeData.area = { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "s",
    bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 6 } } } };
  canvas.nodeData.model = { sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: "i",
    transform: { version: "shared-world-v1", position: { u: 3, v: 2, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } } };
  return canvas;
}

function prepared(canvas: ServerCanvas): WorldPreparedAuthoritySnapshot {
  const area = canvas.nodeData.area!.sceneArea as unknown as Record<string, unknown>;
  const instance = canvas.nodeData.model!.sharedWorldInstance as unknown as { transform: unknown };
  return { canvasId: canvas.id, areaNodeId: "area", area: { areaId: "a", scopeVersion: area.scopeVersion, bounds: area.bounds },
    writable: [{ kind: "instance", instanceId: "i", version: "v" }],
    members: { instances: [{ identity: { kind: "instance", instanceId: "i" }, version: "v", transform: instance.transform }], cameras: [] },
    occupancy: { state: "idle", locks: [] } } as unknown as WorldPreparedAuthoritySnapshot;
}

function harness() {
  let canvas = fixture();
  const apply = (next: ServerCanvas) => { canvas = next; woohaa3CanvasStore.getState().applyRemoteCanvas(canvas); };
  apply(canvas);
  const recordExternal = vi.fn((_entry: { undo(): Promise<unknown>; redo(): Promise<unknown> }) => ({ ok: true, entry: {} }));
  const execute = vi.fn(async () => {
    const data = rotatedAreaData(canvas, "area", prepared(canvas), 1);
    apply({ ...canvas, revision: canvas.revision + 1, nodeData: { ...canvas.nodeData, ...Object.fromEntries(data) } });
    return { ok: true, revision: canvas.revision };
  });
  const submitCommands = vi.fn((commands: Array<{ nodeId: string; value: object }>) => {
    const next = { ...canvas, revision: canvas.revision + 1, nodeData: { ...canvas.nodeData } };
    for (const command of commands) next.nodeData[command.nodeId] = { ...next.nodeData[command.nodeId], ...command.value };
    apply(next);
    return { ok: true, handle: { settled: Promise.resolve({ state: "committed" }) } };
  });
  const resource = prepareModelResource({ sceneVersion: "scene-ir-v2", ops: [{ t: "box", id: "body", parent: null,
    position: [2, 1, 3], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: null, size: [2, 2, 2] }] });
  const ctx = {
    canvasRuntime: { controller: () => ({ invalidate: vi.fn() }), worldAnimationPlayheads: () => new Map([["area", 2]]),
      worldAnimationState: () => ({ playing: false, nodeId: "area" }) },
    canvasSession: { isWritable: () => true, submitCommands }, canvasEdit: { recordExternal },
    canvasRemote: { prepareSceneArea: vi.fn(async () => ({ ok: true, snapshot: prepared(canvas) })), executeSceneArea: execute,
      historySceneArea: vi.fn(async () => ({ ok: true, revision: canvas.revision })) },
    get: () => ({ getResources: () => new Map([["model", resource]]) })
  };
  actions = createWorldRotationActions(ctx as never, canvas.id);
  return { read: () => canvas, apply, execute, recordExternal, submitCommands, ctx, resource, actions };
}

it("serializes repeated area clicks and records each committed quarter turn separately", async () => {
  const h = harness();
  h.actions.rotate("area"); h.actions.rotate("area"); h.actions.rotate("area");
  await vi.waitFor(() => expect(h.actions.getSnapshot().pending).toBe(0));
  expect(h.actions.getSnapshot().error).toBeNull();
  expect(h.execute).toHaveBeenCalledTimes(3);
  expect(h.recordExternal).toHaveBeenCalledTimes(3);
  expect(h.read().nodeData.area!.sceneArea).toMatchObject({ animationQuarterTurns: 3 });
  const requests = h.execute.mock.calls.map(call => (call as unknown as [{ request: { operationId: string } }])[0].request.operationId);
  expect(new Set(requests).size).toBe(3);
});

it("previews the entire queued rotation and rolls back all uncommitted turns on failure", async () => {
  const h = harness();
  let reject!: (cause: Error) => void;
  h.execute.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const original = h.read();
  h.actions.rotate("area"); h.actions.rotate("area");
  await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
  const preview = projectWorldRotationPreview(original)!;
  expect(preview.nodeData.model!.sharedWorldInstance).toMatchObject({ transform: { position: { u: 7, v: 4 } } });
  expect(h.read()).toBe(original);
  reject(new Error("任务已占用模型"));
  await vi.waitFor(() => expect(h.actions.getSnapshot().pending).toBe(0));
  expect(h.actions.getSnapshot().error).toBe("任务已占用模型");
  expect(projectWorldRotationPreview(original)).toBe(original);
  expect(h.recordExternal).not.toHaveBeenCalled();
  expect(h.execute).toHaveBeenCalledTimes(1);
});

it("turns a model around its geometry ground anchor and uses guarded commands for undo/redo", async () => {
  const h = harness();
  const before = h.read().nodeData.model!.sharedWorldInstance as unknown as { transform: Parameters<typeof worldModelGroundAnchor>[1] };
  const local = modelGroundAnchorLocal(h.resource.ops, null)!;
  const anchor = worldModelGroundAnchor(local, before.transform);
  h.actions.rotate("model");
  await vi.waitFor(() => expect(h.actions.getSnapshot().pending).toBe(0));
  const after = h.read().nodeData.model!.sharedWorldInstance as unknown as typeof before;
  expect(worldModelGroundAnchor(local, after.transform).u).toBeCloseTo(anchor.u);
  expect(worldModelGroundAnchor(local, after.transform).v).toBeCloseTo(anchor.v);
  expect(h.recordExternal).toHaveBeenCalledTimes(1);
  const entry = h.recordExternal.mock.calls[0]![0] as unknown as { undo(): Promise<unknown>; redo(): Promise<unknown> };
  await entry.undo();
  expect(h.read().nodeData.model!.sharedWorldInstance).toEqual(before);
  await entry.redo();
  expect(h.read().nodeData.model!.sharedWorldInstance).toEqual(after);
  expect(h.submitCommands.mock.calls[0]![0][0]).toHaveProperty("expectedNodeData");
});

it("cancels a pending prepare when its page is released", async () => {
  const h = harness();
  let finish!: (value: unknown) => void;
  h.ctx.canvasRemote.prepareSceneArea.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
  h.actions.rotate("area");
  h.actions.dispose();
  finish({ ok: true, snapshot: prepared(h.read()) });
  await vi.waitFor(() => expect(h.actions.getSnapshot().pending).toBe(0));
  expect(h.execute).not.toHaveBeenCalled();
});

it("keeps the visible anchor of an animated model fixed and undoes its track compensation atomically", async () => {
  const h = harness();
  const canvas = h.read();
  (canvas.nodeData.area!.sceneArea as any).animationQuarterTurns = 1;
  (canvas.nodeData.area!.sceneArea as any).animationScript = createWorldAnimationScript({ duration: 4, loop: false, script: `
    motion.instance.tween("i", { property: "position", startTime: 0, endTime: 4, from: [1, 2, 0], to: [3, 4, 0] });
    motion.instance.tween("i", { property: "rotation", startTime: 0, endTime: 4, from: [0, 0, 0], to: [0, 0, 60] });
  ` });
  h.apply(canvas);
  const beforeArea = structuredClone(canvas.nodeData.area);
  const anchorAt = () => {
    const current = h.read();
    const area = current.nodeData.area!.sceneArea as any;
    const compiled = executeWorldAnimationScript(area.animationScript.script, area.animationScript);
    if (!compiled.ok) throw new Error(compiled.message);
    const sample = sampleWorldAnimationInArea(compiled.ir, 2, { u: 0, v: 0 }, area.animationQuarterTurns).instances.get("i")!;
    const base = (current.nodeData.model!.sharedWorldInstance as any).transform;
    return worldModelGroundAnchor(modelGroundAnchorLocal(h.resource.ops, null)!, {
      ...base, ...sample, rotation: quatMul(base.rotation, [...sample.rotation!])
    });
  };
  const before = anchorAt();
  h.actions.rotate("model");
  await vi.waitFor(() => expect(h.actions.getSnapshot().pending).toBe(0));
  expect(h.actions.getSnapshot().error).toBeNull();
  expect(anchorAt().u).toBeCloseTo(before.u, 10);
  expect(anchorAt().v).toBeCloseTo(before.v, 10);
  expect(h.submitCommands.mock.calls[0]![0]).toHaveLength(2);
  await h.recordExternal.mock.calls[0]![0].undo();
  expect(h.read().nodeData.area).toEqual(beforeArea);
  expect(anchorAt()).toEqual(before);
});
