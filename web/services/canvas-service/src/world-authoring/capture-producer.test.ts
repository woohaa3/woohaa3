import { describe, expect, it, vi } from "vitest";
import { createWorldAnimationScript, createDefaultWorldCameraData, createEmptyWoohaa3ServerCanvas, HUMANOID_REFERENCE_PARAMETERS, referenceHumanoidRig, normalizeGlbModelReference, normalizeModelDefinition } from "@woohaa3/contracts";
import { buildWorldCameraObservation, buildWorldCaptureObservation } from "./capture-snapshot.js";
import { createWorldCaptureProducer } from "./capture-producer.js";
import type { RendererClient, RendererSceneRequest } from "../model-renderer/client.js";

function fixture(bound: string | null = null) {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-11-03T00:00:00Z");
  canvas.document.nodes.push({ id: "camera", type: "world-camera", position: { x: 0, y: 0 } });
  canvas.nodeData.camera = { worldCamera: JSON.parse(JSON.stringify({ ...createDefaultWorldCameraData("camera", "v1", { u: 2, v: 3 }), boundInstanceId: bound })) };
  for (const [id, u] of [["a", 4], ["b", -7]] as const) {
    const definition = normalizeModelDefinition({ modelScript: `scene.box({ id: 'body', size: [${u === 4 ? 2 : 3}, 2, 2] });`, modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2" });
    if (!definition.ok) throw new Error(definition.reason);
    canvas.document.nodes.push({ id, type: "model3d", position: { x: 0, y: 0 } });
    canvas.nodeData[id] = {
      modelScript: definition.value.modelScript, modelScriptLanguage: definition.value.modelScriptLanguage,
      modelScriptVersion: definition.value.modelScriptVersion, modelContentVersion: definition.value.contentVersion,
      modelPlacement: definition.value.placement,
      sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: id,
        transform: { version: "shared-world-v1", position: { u, v: 8, h: 1 }, rotation: [0, 0, 0, 1], scale: 1.5 } }
    };
  }
  const snapshot = () => {
    const result = buildWorldCaptureObservation({ canvasId: canvas.id, canvas, cameraId: "camera", outputLongEdge: 2048, attemptCounter: 1 });
    if (!result.ok) throw new Error(result.message);
    return result.observation.request;
  };
  return { canvas, snapshot };
}

function renderer() {
  const render = vi.fn(async (_request: RendererSceneRequest) => ({ ok: true as const, png: Buffer.from([1, 2, 3]), renderVersion: "test" }));
  return { render, available: () => true, close: async () => {} } satisfies RendererClient;
}

// A real textured, nonindexed triangle GLB. Rendering remains mocked; no GPU is used.
function texturedGlb() {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", "base64");
  const bin = Buffer.concat([Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer), Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer), png]);
  const document = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }], images: [{ bufferView: 2, mimeType: "image/png" }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: png.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" }] };
  const json = Buffer.from(JSON.stringify(document));
  const jsonSize = Math.ceil(json.length / 4) * 4, binSize = Math.ceil(bin.length / 4) * 4;
  const glb = Buffer.alloc(28 + jsonSize + binSize);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonSize, 12); glb.writeUInt32LE(0x4e4f534a, 16); glb.fill(0x20, 20, 20 + jsonSize); json.copy(glb, 20);
  glb.writeUInt32LE(binSize, 20 + jsonSize); glb.writeUInt32LE(0x004e4942, 24 + jsonSize); bin.copy(glb, 28 + jsonSize);
  return { glb, png };
}

describe("native world capture producer", () => {
  it("uses pinned scripts, perspective pose, output aspect and exact world transforms without fitting", async () => {
    const { canvas, snapshot } = fixture();
    const request = snapshot();
    canvas.nodeData.a.modelScript = "invalid latest script";
    const client = renderer();
    const producer = createWorldCaptureProducer({ renderer: client, resolveRoom: async () => null });
    expect((await producer.capture(request)).status).toBe("image");
    const sent = client.render.mock.calls[0][0];
    expect(sent.world!.camera).toEqual(request.camera);
    expect(sent.world!.camera.projection.kind).toBe("perspective");
    expect(sent.capture).toMatchObject({ width: request.output.width, height: request.output.height });
    expect(sent.world!.instances.map(entry => entry.instance)).toEqual(request.subject.kind === "world" ? request.subject.instances : []);
    expect(sent.world!.instances.every(entry => entry.ops.length > 0)).toBe(true);
    expect(sent.placement).toBeUndefined();
    expect(sent.ops).toEqual([]);
  });

  it("freezes mixed saved rig/ordinary models and executes custom stored dimensions", async () => {
    const { canvas, snapshot } = fixture();
    const saved = referenceHumanoidRig({ ...HUMANOID_REFERENCE_PARAMETERS, torsoHeight: 0.8 });
    if (!saved.ok) throw new Error("expected rig");
    const definition = normalizeModelDefinition({
      modelScript: 'scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.8,0],to:[0,0,0],width:0.32,depth:0.24,shape:"box"});scene.box({id:"headShape",parent:rig.joint("Head"),size:[0.2,0.2,0.2]});',
      modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", rig: saved.value
    });
    if (!definition.ok) throw new Error(definition.reason);
    // Flat authoritative nodeData: modelRig is beside script/version/placement, never nested.
    Object.assign(canvas.nodeData.a, { modelScript: definition.value.modelScript,
      modelContentVersion: definition.value.contentVersion, modelRig: saved.value });
    const secondRig = referenceHumanoidRig();
    if (!secondRig.ok) throw new Error("expected reference rig");
    const second = normalizeModelDefinition({
      modelScript: 'scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.32,depth:0.24,shape:"box"});',
      modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2", rig: secondRig.value
    });
    if (!second.ok) throw new Error(second.reason);
    const secondId = "asset-model3d-1tsjeqy";
    canvas.document.nodes.push({id:secondId,type:"model3d",position:{x:0,y:0}});
    canvas.nodeData[secondId] = {
      modelScript:second.value.modelScript,modelScriptLanguage:second.value.modelScriptLanguage,
      modelScriptVersion:second.value.modelScriptVersion,modelContentVersion:second.value.contentVersion,
      modelPlacement:second.value.placement,modelRig:secondRig.value,
      sharedWorldInstance:{kind:"world-instance",version:"shared-world-v1",instanceId:"instance-assistant-model-1vrznrb6a3p7k",
        transform:{version:"shared-world-v1",position:{u:1,v:1,h:1},rotation:[0,0,0,1],scale:1}}
    };
    const firstId = "asset-model3d-1i09bo7";
    canvas.document.nodes.find(node=>node.id==="a")!.id=firstId;
    canvas.nodeData[firstId]=canvas.nodeData.a;
    delete canvas.nodeData.a;
    Object.assign(canvas.nodeData[firstId], {sharedWorldInstance:{kind:"world-instance",version:"shared-world-v1",instanceId:"instance-assistant-model-uuh985203fkg",
      transform:{version:"shared-world-v1",position:{u:4,v:8,h:1},rotation:[0,0,0,1],scale:1.5}}});
    const before = structuredClone(canvas.nodeData);
    const request = snapshot();
    const client = renderer();
    const producer = createWorldCaptureProducer({ renderer: client, resolveRoom: async () => null });
    expect((await producer.capture(JSON.parse(JSON.stringify(request)))).status).toBe("image");
    const instances = client.render.mock.calls[0][0].world!.instances;
    expect(instances).toHaveLength(3);
    expect(instances[0].ops).toContainEqual(expect.objectContaining({ id: "Spine", position: [0, 0.8, 0] }));
    expect(canvas.nodeData).toEqual(before);
    canvas.document.nodes.push({id:"area",type:"scene-area"});
    canvas.nodeData.area = {sceneArea:{kind:"scene-area",version:"shared-world-v1",areaId:"area",scopeVersion:"scope-1",
      bounds:{min:{u:-30,v:-30},max:{u:30,v:30}},
      animationScript:createWorldAnimationScript({script:'motion.part.tween("instance-assistant-model-uuh985203fkg","LeftUpperArm",{property:"rotation",startTime:0,endTime:2,from:[0,0,-90],to:[30,0,-90]});',duration:2,loop:true})
    }};
    expect(buildWorldCameraObservation({canvasId:canvas.id,canvas,cameraId:"camera",outputLongEdge:2048,attemptCounter:1}))
      .toMatchObject({ok:true,observation:{kind:"dynamic"}});
    canvas.nodeData[firstId].modelRig = { ...saved.value, parameters: { ...saved.value.parameters, torsoHeight: 0.9 } };
    expect(() => snapshot()).toThrow("共享世界模型内容不完整");
  });

  it("renders only the bound instance and never falls back when its target is missing", async () => {
    const client = renderer();
    const producer = createWorldCaptureProducer({ renderer: client, resolveRoom: async () => null });
    expect((await producer.capture(fixture("b").snapshot())).status).toBe("image");
    expect(client.render.mock.calls[0][0].world!.instances.map(entry => entry.instance.instanceId)).toEqual(["b"]);
    expect(await producer.capture(fixture("missing").snapshot())).toMatchObject({ status: "unavailable", reason: "bound-target-missing" });
    expect(client.render).toHaveBeenCalledTimes(1);
  });

  it("reads the pinned GLB asset and forwards its embedded texture bytes", async () => {
    const { canvas, snapshot } = fixture("a");
    const original = canvas.nodeData.a.sharedWorldInstance;
    const reference = normalizeGlbModelReference({ assetId: "pinned-glb" });
    if (!reference.ok) throw new Error(reference.reason);
    canvas.nodeData.a = { sharedWorldInstance: original, modelSourceKind: "glb", modelAssetId: reference.value.assetId,
      modelContentVersion: reference.value.contentVersion, modelPlacement: reference.value.placement };
    canvas.assets.push({ id: "pinned-glb", mediaKind: "model", title: "GLB", status: "ready", source: "uploaded", createdAt: "2026-11-03T00:00:00Z", metadata: { storageKey: "pinned.glb" } } as never);
    const request = snapshot();
    const { glb, png } = texturedGlb();
    const read = vi.fn(async () => ({ bytes: glb, contentType: "model/gltf-binary" }));
    const client = renderer();
    const producer = createWorldCaptureProducer({ renderer: client, resolveRoom: async () => ({ exportCanvas: () => ({ ok: true, canvas }) }) as never, media: { read } as never });
    expect((await producer.capture(request)).status).toBe("image");
    expect(read).toHaveBeenCalledWith("pinned.glb", "canvas");
    expect(client.render.mock.calls[0][0].world!.instances[0].textures).toEqual([
      expect.objectContaining({ mimeType: "image/png", bytesBase64: png.toString("base64") })
    ]);
  });

  it("fails closed for an old worker and discards cancelled output", async () => {
    const request = fixture().snapshot();
    const controller = new AbortController();
    const client = renderer();
    const producer = createWorldCaptureProducer({ renderer: client, resolveRoom: async () => null });
    controller.abort();
    expect((await producer.capture(request, { signal: controller.signal })).status).toBe("cancelled");
    expect(client.render).not.toHaveBeenCalled();
    client.render.mockImplementationOnce(async () => ({ ok: false, code: "unsupported-protocol-version", message: "old worker" }) as never);
    expect(await producer.capture(request)).toMatchObject({ status: "unavailable", reason: "renderer-unavailable" });
  });
});
