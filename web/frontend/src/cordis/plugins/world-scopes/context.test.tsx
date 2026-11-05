// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { ScopeContext } from "./plugin.js";

const areaData = (areaId = "a", scopeVersion = "v1") => ({
  kind: "scene-area",
  version: "shared-world-v1",
  areaId,
  scopeVersion,
  bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
});

function applyAreaCanvas(ids: readonly string[] = ["a"]): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const nodes = ids.map(id => ({ id, type: "scene-area", position: { x: 0, y: 0 } }));
  const nodeData = Object.fromEntries(ids.map(id => [id, { sceneArea: areaData(id) }]));
  const canvas = {
    ...base,
    revision: 1,
    document: { ...base.document, nodes },
    nodeData
  } as ServerCanvas;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  return canvas;
}

function select(id: string, valid: readonly string[] = ["a"]): void {
  nodeSelectionStore.setFromRuntime({ nodeIds: [id], primaryNodeId: id, editingFocus: false }, new Set(valid));
}

function prepareOutcome(snapshot: Record<string, unknown>) {
  return { ok: true, snapshot };
}

async function renderWith(outcome: unknown): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const ctx = { canvasRemote: { prepareSceneArea: vi.fn(() => Promise.resolve(outcome)) } };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    select("a");
    root.render(<ScopeContext ctx={ctx as never} canvasId="c1" />);
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
  return { host, root };
}

it("discards late prepare failures on selection change and unmount", async () => {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const data = (id: string) => ({ kind: "scene-area", version: "shared-world-v1", areaId: id, scopeVersion: "v1", bounds: { min: { u: 0, v: 0 }, max: { u: 1, v: 1 } } });
  woohaa3CanvasStore.getState().applyRemoteCanvas({ ...base, revision: 1, document: { ...base.document,
    nodes: ["a", "b"].map(id => ({ id, type: "group", position: { x: 0, y: 0 } })) },
    nodeData: { a: { sceneArea: data("a") }, b: { sceneArea: data("b") } } } as ServerCanvas);
  const pending: Array<{ signal: AbortSignal; resolve: (value: unknown) => void }> = [];
  const ctx = { canvasRemote: { prepareSceneArea: vi.fn((_input, signal: AbortSignal) => new Promise(resolve => pending.push({ signal, resolve }))) } };
  const host = document.createElement("div");
  const root = createRoot(host);
  const selectId = (id: string) => nodeSelectionStore.setFromRuntime({ nodeIds: [id], primaryNodeId: id, editingFocus: false }, new Set(["a", "b"]));
  await act(async () => { selectId("a"); root.render(<ScopeContext ctx={ctx as never} canvasId="c1" />); });
  await act(async () => { selectId("b"); });
  expect(pending[0]!.signal.aborted).toBe(true);
  await act(async () => { pending[0]!.resolve({ ok: false, code: "lease-conflict", message: "old conflict" }); });
  expect(host.textContent).not.toContain("old conflict");
  await act(async () => { pending[1]!.resolve({ ok: false, code: "not-ready", message: "current error" }); });
  expect(host.textContent).toContain("current error");
  await act(async () => { selectId("a"); });
  await act(async () => { root.unmount(); });
  expect(pending[2]!.signal.aborted).toBe(true);
  await act(async () => { pending[2]!.resolve({ ok: false, code: "not-ready", message: "late" }); });
  expect(host.textContent).toBe("");
  nodeSelectionStore.reset();
});

it("ignores a late success after the canvas page changes", async () => {
  applyAreaCanvas(["a"]);
  const pending: Array<{ signal: AbortSignal; resolve: (value: unknown) => void }> = [];
  const ctx = { canvasRemote: { prepareSceneArea: vi.fn((_input, signal: AbortSignal) => new Promise(resolve => pending.push({ signal, resolve }))) } };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    select("a");
    root.render(<ScopeContext ctx={ctx as never} canvasId="c1" />);
  });
  await act(async () => { root.render(<ScopeContext ctx={ctx as never} canvasId="c2" />); });
  expect(pending[0]!.signal.aborted).toBe(true);
  await act(async () => { pending[0]!.resolve(prepareOutcome({ canvasId: "c1", areaNodeId: "a", area: areaData(), objects: [{ containment: "writable", identity: { kind: "instance", instanceId: "old-object" } }] })); });
  expect(host.textContent).not.toContain("old-object");
  await act(async () => { root.unmount(); });
  nodeSelectionStore.reset();
});

it("never renders a previous area result under a newly selected area while the next prepare is pending", async () => {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const data = (id: string) => ({ kind: "scene-area", version: "shared-world-v1", areaId: id, scopeVersion: "v1", bounds: { min: { u: 0, v: 0 }, max: { u: 1, v: 1 } } });
  woohaa3CanvasStore.getState().applyRemoteCanvas({ ...base, revision: 1,
    document: { ...base.document, nodes: ["a", "b"].map(id => ({ id, type: "scene-area", position: { x: 0, y: 0 } })) },
    nodeData: { a: { sceneArea: data("a") }, b: { sceneArea: data("b") } } } as ServerCanvas);
  const pending: Array<(value: unknown) => void> = [];
  const ctx = { canvasRemote: { prepareSceneArea: vi.fn(() => new Promise(resolve => pending.push(resolve as (value: unknown) => void))) } };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    select("a", ["a", "b"]);
    root.render(<ScopeContext ctx={ctx as never} canvasId="c1" />);
  });
  await act(async () => { pending[0]!(prepareOutcome({
    version: "world-authoring-v1", canvasId: "c1", revision: 1,
    scope: { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "v1" },
    areaNodeId: "a", area: data("a"), bounds: data("a").bounds, writable: [], readOnly: [],
    members: { instances: [], cameras: [] },
    objects: [{ identity: { kind: "instance", instanceId: "old-object" }, nodeId: null, version: "v1", containment: "writable" }]
  })); });
  expect(host.textContent).toContain("模型 old-object");
  await act(async () => { select("b", ["a", "b"]); });
  expect(host.textContent).not.toContain("old-object");
  expect(host.textContent).toContain("正在读取场景上下文");
  await act(async () => { root.unmount(); });
  nodeSelectionStore.reset();
});

it("renders writable, reference and unready objects with typed occupancy locks", async () => {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const area = areaData();
  woohaa3CanvasStore.getState().applyRemoteCanvas({
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [
      { id: "a", type: "scene-area", position: { x: 0, y: 0 } },
      { id: "m1", type: "model3d", position: { x: 0, y: 0 } },
      { id: "m2", type: "model3d", position: { x: 0, y: 0 } },
      { id: "cam1", type: "world-camera", position: { x: 0, y: 0 } }
    ] },
    nodeData: {
      a: { sceneArea: area },
      m1: { title: "主模型" },
      m2: { title: "参考模型" },
      cam1: { title: "主机位" }
    }
  } as ServerCanvas);
  const scope = { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "v1" };
  const { host, root } = await renderWith(prepareOutcome({
    version: "world-authoring-v1",
    canvasId: "c1",
    revision: 1,
    scope,
    areaNodeId: "a",
    area,
    bounds: area.bounds,
    writable: [],
    readOnly: [],
    members: { instances: [], cameras: [] },
    objects: [
      { identity: { kind: "instance", instanceId: "i1" }, nodeId: "m1", version: "i1-v1", containment: "writable" },
      { identity: { kind: "instance", instanceId: "i2" }, nodeId: "m2", version: "i2-v1", containment: "read-only" },
      { identity: { kind: "camera", cameraId: "cam" }, nodeId: "cam1", version: "cam-v1", containment: "unknown" }
    ],
    occupancy: {
      version: "world-scope-occupancy-v1",
      scope,
      state: "occupied",
      locks: [
        { target: { kind: "instance", instanceId: "i1" }, runId: "run-alpha-123", epoch: 4, state: "active" },
        { target: { kind: "camera", cameraId: "cam" }, runId: "run-beta-456", epoch: 2, state: "cancelled" }
      ]
    }
  }));
  expect(host.textContent).toContain("完整可写");
  expect(host.textContent).toContain("部分参考");
  expect(host.textContent).toContain("未就绪");
  expect(host.textContent).toContain("主模型");
  expect(host.textContent).toContain("参考模型");
  expect(host.textContent).toContain("主机位");
  expect(host.textContent).toContain("执行中");
  expect(host.textContent).toContain("取消待停止");
  expect(host.textContent).toContain("run-alph");
  expect(host.textContent).toContain("e4");
  expect(host.textContent).toContain("不会获取写授权或占用");
  await act(async () => { root.unmount(); });
  nodeSelectionStore.reset();
});

it("treats a legacy response without occupancy as unknown, never idle", async () => {
  applyAreaCanvas();
  const area = areaData();
  const { host, root } = await renderWith(prepareOutcome({
    version: "world-authoring-v1", canvasId: "c1", revision: 1,
    scope: { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "v1" },
    areaNodeId: "a", area, bounds: area.bounds, writable: [], readOnly: [], members: { instances: [], cameras: [] },
    objects: [{ identity: { kind: "instance", instanceId: "i1" }, nodeId: null, version: "v1", containment: "unknown" }]
  }));
  expect(host.textContent).toContain("占用状态未知");
  expect(host.textContent).toContain("响应未提供");
  expect(host.textContent).not.toContain("当前无运行占用");
  await act(async () => { root.unmount(); });
  nodeSelectionStore.reset();
});

it("shows idle occupancy only when the response explicitly reports it", async () => {
  applyAreaCanvas();
  const area = areaData();
  const scope = { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "v1" };
  const { host, root } = await renderWith(prepareOutcome({
    version: "world-authoring-v1", canvasId: "c1", revision: 1, scope, areaNodeId: "a", area, bounds: area.bounds,
    writable: [], readOnly: [], members: { instances: [], cameras: [] }, objects: [],
    occupancy: { version: "world-scope-occupancy-v1", scope, state: "idle", locks: [] }
  }));
  expect(host.textContent).toContain("当前无运行占用");
  await act(async () => { root.unmount(); });
  nodeSelectionStore.reset();
});

it("re-reads read-only occupancy periodically and stops after unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    applyAreaCanvas();
    const area = areaData();
    const scope = { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "v1" };
    const prepare = vi.fn(() => Promise.resolve(prepareOutcome({
      version: "world-authoring-v1", canvasId: "c1", revision: 1, scope, areaNodeId: "a", area, bounds: area.bounds,
      writable: [], readOnly: [], members: { instances: [], cameras: [] }, objects: [],
      occupancy: { version: "world-scope-occupancy-v1", scope, state: "idle", locks: [] }
    })));
    const ctx = { canvasRemote: { prepareSceneArea: prepare } };
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => {
      select("a");
      root.render(<ScopeContext ctx={ctx as never} canvasId="c1" />);
      await Promise.resolve();
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    // No canvas revision change: a run starting elsewhere is observable only through the
    // read-only prepare refresh, never an acquire/context probe.
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(2);
    await act(async () => { root.unmount(); });
    const afterUnmount = prepare.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(15000);
      await Promise.resolve();
    });
    expect(prepare.mock.calls.length).toBe(afterUnmount);
    nodeSelectionStore.reset();
  } finally {
    vi.useRealTimers();
  }
});

it("does not render a floating panel for a selected 2D group", async () => {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  woohaa3CanvasStore.getState().applyRemoteCanvas({
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [
      { id: "g", type: "workflow-group-2d", position: { x: 0, y: 0 } },
      { id: "m1", type: "model3d", position: { x: 0, y: 0 } }
    ] },
    nodeData: {
      g: { workflowGroup2d: { kind: "workflow-group-2d", version: "shared-world-v1", groupId: "g", scopeVersion: "v1", memberNodeIds: ["m1"] } },
      m1: { title: "组内模型" }
    }
  } as ServerCanvas);
  const ctx = { canvasRemote: { prepareSceneArea: vi.fn() } };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    select("g", ["g", "m1"]);
    root.render(<ScopeContext ctx={ctx as never} canvasId="c1" />);
  });
  expect(host.textContent ?? "").toBe("");
  expect(ctx.canvasRemote.prepareSceneArea).not.toHaveBeenCalled();
  await act(async () => { root.unmount(); });
  nodeSelectionStore.reset();
});
