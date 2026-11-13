import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, normalizeModelDefinition, parseGlbModel,
  type WorldPreparedAuthoritySnapshot, type WorldTransform } from "@woohaa3/contracts";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Mesh, Vector3 } from "three";
import { downloadSceneAreaBlob, sceneAreaDownloadModels } from "./scene-area-download.js";
import { NodeDownloadService } from "./node-download.js";
import { downloadModelBlob } from "./model-download.js";

// Three's binary exporter uses this browser adapter; all geometry and GLB
// serialization/parsing in these tests are real and do not require a GPU.
beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("FileReader", class {
    result: ArrayBuffer | null = null;
    onloadend?: () => void;
    readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(bytes => { this.result = bytes; this.onloadend?.(); }); }
  });
});
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("stage-download");
  const definition = normalizeModelDefinition({ modelScript: 'scene.box({id:"body",size:[1,2,3],color:"#ff0000"});',
    modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2",
    placement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 } });
  if (!definition.ok) throw new Error(definition.reason);
  canvas.document.nodes = [{ id: "area", type: "scene-area", position: { x: 0, y: 0 } }];
  canvas.nodeData.area = { title: "我的片场", sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "s",
    bounds: { min: { u: -10, v: -10 }, max: { u: 10, v: 10 } } } };
  const transforms: WorldTransform[] = [
    { version: "shared-world-v1", position: { u: 3, v: 4, h: 2 }, rotation: [0, 0, 0, 1], scale: 2 },
    { version: "shared-world-v1", position: { u: -2, v: 1, h: 0 }, rotation: [0, 0, -Math.SQRT1_2, Math.SQRT1_2], scale: .5 }
  ];
  for (let index = 0; index < 3; index++) {
    const id = `m${index}`;
    canvas.document.nodes.push({ id, type: "model3d", position: { x: 1000, y: 1000 } });
    canvas.nodeData[id] = { ...definition.value, title: id, sharedWorldInstance: {
      kind: "world-instance", version: "shared-world-v1", instanceId: id,
      transform: transforms[index] ?? { ...transforms[0]!, position: { u: 40, v: 40, h: 0 } }
    } } as never;
  }
  const snapshot = { canvasId: canvas.id, revision: canvas.revision, areaNodeId: "area", area: {
    areaId: "a", scopeVersion: "s", bounds: (canvas.nodeData.area.sceneArea as any).bounds },
    members: { instances: transforms.map((transform, index) => ({ identity: { kind: "instance", instanceId: `m${index}` }, version: "v", transform })), cameras: [] }
  } as unknown as WorldPreparedAuthoritySnapshot;
  return { canvas, snapshot };
}

it("exports the area's models as one GLB with meter-based world positions, rotation, scale and materials", async () => {
  const { canvas, snapshot } = fixture();
  const before = structuredClone(canvas);
  const blob = await downloadSceneAreaBlob(canvas, "area", snapshot, new AbortController().signal, vi.fn());
  expect(blob.type).toBe("model/gltf-binary");
  const bytes = await blob.arrayBuffer();
  expect(parseGlbModel(new Uint8Array(bytes))).toMatchObject({ ok: true });
  const loaded = await new GLTFLoader().parseAsync(bytes, "");
  const a = loaded.scene.getObjectByName("m0")!, b = loaded.scene.getObjectByName("m1")!;
  expect(a.position.toArray()).toEqual([3, 2, -4]);
  expect(a.scale.toArray()).toEqual([2, 2, 2]);
  expect(b.position.toArray()).toEqual([-2, 0, -1]);
  expect(new Vector3(1, 0, 0).applyQuaternion(b.quaternion).z).toBeCloseTo(1);
  const meshes: Mesh[] = [];
  loaded.scene.traverse(object => { if (object instanceof Mesh) meshes.push(object); });
  expect(meshes).toHaveLength(2);
  expect(meshes[0]!.material).toMatchObject({ color: { r: 1, g: 0, b: 0 } });
  expect(loaded.scene.getObjectByName("m2")).toBeUndefined();
  expect(canvas).toEqual(before);
});

it("rejects empty and changed snapshots instead of exporting a partial or stale scene", () => {
  const { canvas, snapshot } = fixture();
  expect(() => sceneAreaDownloadModels(canvas, "area", { ...snapshot, members: { instances: [], cameras: [] } })).toThrow("尚无");
  expect(() => sceneAreaDownloadModels(canvas, "area", { ...snapshot, revision: canvas.revision + 1 })).toThrow("等待同步");
  delete canvas.nodeData.m1;
  expect(() => sceneAreaDownloadModels(canvas, "area", snapshot)).toThrow("等待同步");
});

it("combines an imported GLB and an LLM model using the same frozen member transforms", async () => {
  const { canvas, snapshot } = fixture();
  const data = canvas.nodeData.m1!;
  const source = await downloadModelBlob(data.modelScript!, data.modelScriptVersion, new AbortController().signal);
  canvas.nodeData.m1 = { title: "导入模型", sharedWorldInstance: data.sharedWorldInstance, modelSourceKind: "glb", modelAssetId: "glb" };
  canvas.assets.push({ id: "glb", title: "model.glb", source: "uploaded", mediaKind: "file", status: "ready",
    createdAt: "2026-11-10T00:00:00Z", url: "/api/media/model.glb", metadata: { storageKey: "model.glb" } });
  const readMedia = vi.fn(async () => source);
  const blob = await downloadSceneAreaBlob(canvas, "area", snapshot, new AbortController().signal, readMedia);
  const parsed = parseGlbModel(new Uint8Array(await blob.arrayBuffer()));
  expect(parsed).toMatchObject({ ok: true });
  if (parsed.ok) expect(parsed.stats.primitives).toBe(2);
  expect(readMedia).toHaveBeenCalledWith(canvas.assets[0], expect.any(AbortSignal), canvas.id);
});

it("does not save a partially built scene if a member asset fails or the export is cancelled", async () => {
  const { canvas, snapshot } = fixture();
  canvas.nodeData.m1 = { sharedWorldInstance: canvas.nodeData.m1!.sharedWorldInstance, modelSourceKind: "glb", modelAssetId: "missing" };
  const save = vi.fn();
  const service = new NodeDownloadService({ getCanvas: () => canvas, save, prepareSceneArea: async () => ({ ok: true, snapshot }) });
  await service.download("area");
  expect(save).not.toHaveBeenCalled();
  expect(service.getSnapshot()).toMatchObject({ error: true });
  service.dispose();
  const abort = new AbortController();
  abort.abort();
  await expect(downloadSceneAreaBlob(canvas, "area", snapshot, abort.signal, vi.fn())).rejects.toThrow();
});

it("saves a real scene GLB through node download, using the area title without any write operation", async () => {
  const { canvas, snapshot } = fixture();
  const save = vi.fn();
  const prepareSceneArea = vi.fn(async () => ({ ok: true as const, snapshot }));
  const service = new NodeDownloadService({ getCanvas: () => canvas, prepareSceneArea, save });
  await service.download("area");
  expect(service.getSnapshot()).toMatchObject({ error: false, busy: false });
  expect(prepareSceneArea).toHaveBeenCalledWith({ canvasId: canvas.id, areaId: "a" }, expect.any(AbortSignal));
  expect(save).toHaveBeenCalledWith(expect.any(Blob), "我的片场.glb");
  expect(parseGlbModel(new Uint8Array(await (save.mock.calls[0]![0] as Blob).arrayBuffer()))).toMatchObject({ ok: true });
  service.dispose();
});
