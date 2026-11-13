import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyCanvasCommands } from "../command-reducer.js";
import { createEmptyWoohaa3ServerCanvas, normalizeCanvas, parseCanvasAggregate } from "../domain/index.js";
import { HUMANOID_REFERENCE_PARAMETERS } from "../humanoid-rig.js";
import { serverCanvasToYDoc, yDocToServerCanvas } from "../yjs/mapping.js";

const now = "2026-11-01T00:00:00.000Z";
const group = { kind: "workflow-group-2d", version: "shared-world-v1", groupId: "g", scopeVersion: "1", memberNodeIds: ["model"] };
const area = { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "1", bounds: { min: { u: 0, v: 0 }, max: { u: 2, v: 2 } } };
const camera = { kind: "world-camera", version: "shared-world-v1", cameraId: "c", settingsVersion: "1", position: { u: 0, v: 0, h: 1 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 }, captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: "missing" };
const node = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 } });

describe("world identities", () => {
  it("keeps connected structural nodes valid through reconciliation and reload", () => {
    const base = createEmptyWoohaa3ServerCanvas("x", now);
    for (const [type, data] of [
      ["workflow-group-2d", { workflowGroup2d: { ...group, memberNodeIds: [] } }],
      ["scene-area", { sceneArea: area }],
      ["world-camera", { worldCamera: camera }]
    ] as const) {
      const result = applyCanvasCommands(base, [
        { type: "node.add", node: node("image", "image") },
        { type: "node.add", node: node("target", type), nodeData: data as never, connect: { fromNodeId: "image", edgeId: "edge" } }
      ], { now });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      expect(result.canvas.nodeData.target.inputMapping).toHaveLength(1);
      expect(parseCanvasAggregate(result.canvas).ok).toBe(true);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(serverCanvasToYDoc(result.canvas)));
      expect(yDocToServerCanvas(doc, { now }).ok).toBe(true);
      expect(applyCanvasCommands(result.canvas, [{ type: "node.update", nodeId: "target", position: { x: 10, y: 20 } }], { now }).ok).toBe(true);
      expect(applyCanvasCommands(result.canvas, [{ type: "nodeData.patch", nodeId: "target", value: { inputMapping: [{ sourceNodeId: "image", role: "input", gpuResource: {} }] } as never }], { now }).ok).toBe(false);
    }
  });

  it("stores no card layout for scene areas or shared world models", () => {
    const instance = {
      kind: "world-instance",
      version: "shared-world-v1",
      instanceId: "instance",
      transform: { version: "shared-world-v1", position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 1 }
    };
    const created = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("x", now), [
      { type: "node.add", node: { id: "area", type: "scene-area" }, nodeData: { sceneArea: area } },
      { type: "node.add", node: { id: "model", type: "model3d", position: { x: 10, y: 20 } }, nodeData: { sharedWorldInstance: instance } }
    ], { now });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    for (const nodeId of ["area", "model"]) {
      const node = created.canvas.document.nodes.find(entry => entry.id === nodeId)!;
      expect(node.position).toBeUndefined();
      expect(node.width).toBeUndefined();
      expect(node.height).toBeUndefined();
    }
    // 旧文档里的遗留卡片坐标在读取时被丢弃，而不是继续作为 3D 元素的锚点。
    const legacy = {
      ...created.canvas,
      document: {
        ...created.canvas.document,
        nodes: created.canvas.document.nodes.map(node => ({ ...node, position: { x: 7, y: 8 }, width: 100, height: 50 }))
      }
    };
    const normalized = normalizeCanvas(legacy);
    for (const node of normalized.document.nodes) {
      expect(node.position).toBeUndefined();
      expect(node.width).toBeUndefined();
      expect(node.height).toBeUndefined();
    }
  });

  it("survives reducer, aggregate parsing and encoded Yjs reload", () => {
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "model-instance", transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    const result = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("x", now), [
      { type: "node.add", node: { ...node("model", "model3d"), position: undefined }, nodeData: { sharedWorldInstance: instance } },
      { type: "node.add", node: node("group", "workflow-group-2d"), nodeData: { workflowGroup2d: group } },
      { type: "node.add", node: node("area", "scene-area"), nodeData: { sceneArea: area } },
      { type: "node.add", node: node("camera", "world-camera"), nodeData: { worldCamera: camera } }
    ], { now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseCanvasAggregate(result.canvas).ok).toBe(true);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(serverCanvasToYDoc(result.canvas)));
    const reloaded = yDocToServerCanvas(doc, { now });
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.canvas.nodeData.camera.worldCamera).toEqual(camera);
    const moved = applyCanvasCommands(result.canvas, [{ type: "node.update", nodeId: "camera", position: { x: 100, y: 50 } }], { now });
    expect(moved.ok && moved.canvas.nodeData.camera.worldCamera).toEqual(camera);
    expect(parseCanvasAggregate({ ...result.canvas, nodeData: { ...result.canvas.nodeData, area: { sceneArea: { ...area, version: "future" } } } }).ok).toBe(false);
    const duplicate = applyCanvasCommands(result.canvas, [{ type: "node.add", node: node("other", "scene-area"), nodeData: { sceneArea: area } }], { now });
    expect(duplicate.ok).toBe(false);
    expect(result.canvas.document.nodes).toHaveLength(4);
  });

  it("rejects invalid, mixed and dangling identities without modifying the input", () => {
    const base = createEmptyWoohaa3ServerCanvas("x", now);
    for (const [type, data] of [
      ["scene-area", { sceneArea: { ...area, version: "future" } }],
      ["scene-area", { worldCamera: camera }],
      ["workflow-group-2d", { workflowGroup2d: group }],
      ["world-camera", { worldCamera: { ...camera, gpuHandle: 1 } }]
    ] as const) {
      expect(applyCanvasCommands(base, [{ type: "node.add", node: node("n", type), nodeData: data }], { now }).ok).toBe(false);
      expect(base.document.nodes).toEqual([]);
    }
  });

  it("rejects unknown top-level runtime fields and invalid group members", () => {
    const base = createEmptyWoohaa3ServerCanvas("x", now);
    for (const field of ["writeLease", "gpuResource"]) {
      const result = applyCanvasCommands(base, [{ type: "node.add", node: node("camera", "world-camera"), nodeData: { worldCamera: camera, [field]: { id: 1 } } }], { now });
      expect(result.ok).toBe(false);
      expect(base.document.nodes).toEqual([]);
    }
    const added = applyCanvasCommands(base, [{ type: "node.add", node: node("camera", "world-camera"), nodeData: { worldCamera: camera } }], { now });
    expect(added.ok).toBe(true);
    if (added.ok) {
      expect(applyCanvasCommands(added.canvas, [{ type: "nodeData.patch", nodeId: "camera", value: { writeLease: { owner: "run" } } }], { now }).ok).toBe(false);
      expect(applyCanvasCommands(added.canvas, [{ type: "nodeData.patch", nodeId: "camera", value: { title: { writeLease: { owner: "run" } } as unknown as string } }], { now }).ok).toBe(false);
      expect(added.canvas.nodeData.camera.worldCamera).toEqual(camera);
    }
    expect(applyCanvasCommands(base, [{ type: "node.add", node: node("next", "text") }], { now }).ok).toBe(true);
  });

  it("preserves existing shot pose on a world model", () => {
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    const shotPose = { azimuth: 1, distance: 2, target: [0, 0, 0] };
    const result = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("x", now), [{ type: "node.add", node: node("model", "model3d"), nodeData: { shotPose, sharedWorldInstance: instance } }], { now });
    expect(result.ok).toBe(true);
    if (result.ok) expect(parseCanvasAggregate(result.canvas).ok).toBe(true);
  });

  it("rejects malformed and transient nested model configuration on add, patch and parse", () => {
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    const base = createEmptyWoohaa3ServerCanvas("x", now);
    const modelDefinition = { modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } };
    const added = applyCanvasCommands(base, [{ type: "node.add", node: node("model", "model3d"), nodeData: { ...modelDefinition, sharedWorldInstance: instance, shotPose: { distance: 2 } } }], { now });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    for (const config of [
      { shotPose: { distance: "bad" } },
      { shotPose: { distance: 2, gpuTexture: { id: 1 } } },
      { parameters: { invalid: Infinity } },
      { parameters: { invalid: new Date() } },
      ...["status", "progress", "activeRunId", "modelScriptError"].map(key => ({ [key]: { entityHandle: { id: 42 } } })),
      { progress: "invalid-number" },
      { modelPlacement: { offset: { x: 1 }, entityHandle: { id: 42 } } },
      { result: { kind: "image", url: "asset", entityHandle: {} } },
      { inputMapping: [{ sourceNodeId: "x", role: "input", entityHandle: {} }] },
      { modelPlacement: { offset: { x: 1, runtime: {} } } },
      { modelCameras: [{ id: "c", name: "C", order: 0, azimuth: 0, elevation: 0, distance: 2, aspect: "16:9", gpuTexture: {} }] }
    ]) {
      expect(parseCanvasAggregate({ ...added.canvas, nodeData: { model: { sharedWorldInstance: instance, ...config } } }).ok).toBe(false);
      expect(applyCanvasCommands(base, [{ type: "node.add", node: node("model", "model3d"), nodeData: { sharedWorldInstance: instance, ...config } as never }], { now }).ok).toBe(false);
      const patched = applyCanvasCommands(added.canvas, [{ type: "nodeData.patch", nodeId: "model", value: config as never }], { now });
      expect(patched.ok, JSON.stringify(config)).toBe(false);
      expect(added.canvas.nodeData.model.shotPose).toEqual({ distance: 2 });
    }
  });

  it("accepts valid model task state and provider parameters", () => {
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    const parameters = { matrix: [[1, 0], [0, 1]], lease: "commercial", gpuCount: 2, nested: { writeLease: null, values: [true, "text", 3, { gpuResource: "ordinary" }] } };
    const data = { sharedWorldInstance: instance, modelScript: "scene.box({ id: 'body' });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, status: "running", taskStatus: "processing", progress: 0.5, activeRunId: "run", modelScriptError: null, parameters };
    const result = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("x", now), [{ type: "node.add", node: node("model", "model3d"), nodeData: data as never }], { now });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = parseCanvasAggregate(result.canvas);
      expect(parsed.ok && parsed.canvas.nodeData.model.parameters).toEqual(parameters);
      const patched = applyCanvasCommands(result.canvas, [{ type: "nodeData.patch", nodeId: "model", value: { parameters } }], { now });
      expect(patched.ok, JSON.stringify(patched)).toBe(true);
      if (patched.ok) {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(serverCanvasToYDoc(patched.canvas)));
        const reloaded = yDocToServerCanvas(doc, { now });
        expect(reloaded.ok && reloaded.canvas.nodeData.model.parameters).toEqual(parameters);
      }
    }
  });

  it("keeps a humanoid rig on a shared world model and rejects a malformed one", () => {
    const instance = { kind: "world-instance", version: "shared-world-v1", instanceId: "i", transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    const modelRig = { profile: "humanoid", templateId: "humanoid", templateVersion: 1, parameters: HUMANOID_REFERENCE_PARAMETERS };
    const definition = { modelScript: "scene.box({ id: 'body', parent: rig.joint('Hips') });", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", modelContentVersion: { revision: 1, sourceHash: "source", contentHash: "content" }, modelPlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, modelRig };
    const result = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("x", now), [{ type: "node.add", node: node("model", "model3d"), nodeData: { sharedWorldInstance: instance, ...definition } as never }], { now });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.nodeData.model.modelRig).toEqual(modelRig);
    const parsed = parseCanvasAggregate(result.canvas);
    expect(parsed.ok && parsed.canvas.nodeData.model.modelRig).toEqual(modelRig);
    const patched = applyCanvasCommands(result.canvas, [{ type: "nodeData.patch", nodeId: "model", value: { modelRig } }], { now });
    expect(patched.ok, JSON.stringify(patched)).toBe(true);
    if (patched.ok) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(serverCanvasToYDoc(patched.canvas)));
      const reloaded = yDocToServerCanvas(doc, { now });
      expect(reloaded.ok && reloaded.canvas.nodeData.model.modelRig).toEqual(modelRig);
    }
    const malformed = { modelRig: { profile: "rigid", templateId: "humanoid", templateVersion: 1, parameters: HUMANOID_REFERENCE_PARAMETERS } };
    expect(applyCanvasCommands(result.canvas, [{ type: "nodeData.patch", nodeId: "model", value: malformed as never }], { now }).ok).toBe(false);
    expect(result.canvas.nodeData.model.modelRig).toEqual(modelRig);
  });
});
