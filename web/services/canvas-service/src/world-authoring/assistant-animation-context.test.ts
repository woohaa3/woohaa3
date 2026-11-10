import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyWoohaa3ServerCanvas,
  decodeSceneAreaData,
  executeWorldAnimationScript,
  referenceHumanoidRig,
  HUMANOID_REFERENCE_PARAMETERS,
  normalizeModelDefinition,
  type WorldAnimationScript,
  type WorldToolContext
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import { CanvasRoom } from "../sync/room.js";
import { InMemoryYjsDocumentRepository } from "../sync/in-memory-yjs-repository.js";
import { worldObjectVersion } from "./authority.js";
import { createAssistantWorldService } from "./assistant-service.js";

const NOW = "2026-11-04T00:00:00.000Z";
const bounds = { min: { u: -3, v: -3 }, max: { u: 3, v: 3 } };
const scope = { scope: { kind: "scene-area" as const, areaId: "area-1" }, scopeVersion: "scope-1" };
const query = { canvasId: "canvas-1", contextId: "context-1" };
const original: WorldAnimationScript = {
  script: [
    'motion.instance.tween("actor", { property: "position", startTime: 0, endTime: 5, from: [-1.5, 0, 0], to: [1.5, 0, 0], easing: "easeOut" });',
    'motion.instance.tween("actor", { property: "rotation", startTime: 0, endTime: 5, from: [0, 0, 0], to: [0, 0, 90], easing: "easeInOut" });',
    'motion.instance.tween("prop", { property: "scale", startTime: 0, endTime: 5, from: [1], to: [2], easing: "linear" });'
  ].join("\n"),
  scriptLanguage: "javascript",
  scriptVersion: "woohaa-world-animation-js-v2",
  revision: 1,
  sourceHash: "hash-original",
  duration: 5,
  loop: true
};

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

async function fixture(options: { animationScript?: WorldAnimationScript | null; readOnlyProp?: boolean; modelScript?: string; empty?: boolean; modelRig?: unknown } = {}) {
  const animationScript = options.animationScript === undefined ? structuredClone(original) : options.animationScript;
  const canvas = createEmptyWoohaa3ServerCanvas(query.canvasId, NOW);
  canvas.document.nodes = [
    { id: "area-node", type: "scene-area", position: { x: 0, y: 0 } },
    ...["actor", "prop"].map(id => ({ id, type: "model3d", position: { x: 0, y: 0 } }))
  ];
  canvas.nodeData["area-node"] = { sceneArea: {
    kind: "scene-area", version: "shared-world-v1", areaId: "area-1", scopeVersion: "scope-1", bounds,
    ...(animationScript ? { animationScript } : {})
  } };
  for (const id of ["actor", "prop"]) canvas.nodeData[id] = {
    modelScript: options.modelScript ?? "scene.box({});", modelScriptLanguage: "javascript", modelScriptVersion: "woohaa-model-js-v2",
    sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: id,
      transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } }
  };
  if (options.modelRig) canvas.nodeData.actor!.modelRig = options.modelRig;
  if (options.empty) {
    canvas.document.nodes = canvas.document.nodes.filter(node => node.type === "scene-area");
    delete canvas.nodeData.actor; delete canvas.nodeData.prop;
  }
  const repository = new InMemoryYjsDocumentRepository();
  const room = new CanvasRoom({ canvasId: canvas.id, repository, now: () => NOW });
  await room.initialize({ canvas, roomEpoch: "epoch-1", createdAt: NOW });
  closers.push(() => room.dispose());
  const selectedScope = scope;
  const targets = ["actor", "prop"].map(instanceId => ({ kind: "instance" as const, instanceId, version: `version-${instanceId}` }));
  const writable = targets.filter(target => !options.readOnlyProp || target.instanceId !== "prop");
  const context: WorldToolContext = {
    contextId: query.contextId, canvasId: canvas.id, runId: "run-1", epoch: 0, scope: selectedScope,
    writableTargets: writable.map(target => ({ target, lease: {
      canvasId: canvas.id, runId: "run-1", epoch: 0, target: { kind: "instance", instanceId: target.instanceId }
    } })),
    readOnlyReferences: options.readOnlyProp ? [targets[1]!] : []
  };
  let revoked = false;
  const service = createAssistantWorldService({
    authority: {
      async prepareCanvas() { return { ok: true, snapshot: {} } as never; },
      async prepareContent() { return { contentVersion: "test-content", localAabb: { min: [0, 0, 0], max: [1, 1, 1] } }; },
      // Deliberately stale: reading animation must use the current published room.
      cacheFor() {
        return {
          kind: "scene-area",
          area: canvas.nodeData["area-node"]!.sceneArea,
          instances: new Map(targets.map((target) => [target.instanceId, {
            identity: { kind: "instance", instanceId: target.instanceId },
            nodeId: target.instanceId,
            version: target.version,
            data: { transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } },
            localAabb: { min: [0, 0, 0], max: [1, 1, 1] }
          }])) as never
        } as never;
      }
    },
    worldAuthoring: {
      async issueContext() { return { ok: true, context, run: {
        canvasId: canvas.id, requestId: "request-1", runId: "run-1", epoch: 0, executionId: "execution-1", state: "active"
      }, retry: false }; },
      async revokeContext() { revoked = true; },
      resolveCapability() { return revoked
        ? { ok: false, code: "stale-epoch", message: "revoked" }
        : { context, capability: {} }; },
      refreshContextVersions() {},
      refreshContextScope() {}
    },
    cameraSettings: { async save() { throw new Error("not used"); }, async complete() { throw new Error("not used"); } },
    async resolveRoom() { return room; },
    async cancel() {}, async confirmStopped() {}, async pending() { return []; }
  });
  closers.push(() => service.close());
  await service.issue({ canvasId: canvas.id, requestId: "request-1", runId: "run-1", epoch: 0,
    executionId: "execution-1", scope: selectedScope.scope });
  const patchArea = async (changes: Record<string, string>) => {
    const snapshot = room.exportCanvas();
    if (!snapshot.ok) throw new Error(snapshot.message);
    return room.submit({ protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: canvas.id,
      commandId: `change-area-${room.currentRevision}`, baseRevision: room.currentRevision, actorId: "test",
      commands: [{ type: "nodeData.patch", nodeId: "area-node", value: {
        sceneArea: { ...snapshot.canvas.nodeData["area-node"]!.sceneArea as object, ...changes }
      } }] });
  };
  return { service, room, repository, patchArea, revoke: () => { revoked = true; } };
}

describe("current director animation in assistant context", () => {
  it("reads the animation script, revises it, and reads the committed script with the same context", async () => {
    const { service, room, repository } = await fixture();
    const first = await service.read(query);
    expect(first).toMatchObject({ ok: true, view: { bounds, sceneArea: { nodeId: "area-node", revision: 0, animationScript: original } } });
    expect(first.ok && first.view.sceneModels?.map((model) => model.instanceId).sort()).toEqual(["actor", "prop"]);
    expect(first.ok && first.view.sceneModels?.[0]?.localBounds).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    if (!first.ok || !first.view.sceneArea?.animationScript) throw new Error("Expected the current animation script");
    const revisedScript = first.view.sceneArea.animationScript.script.replace("to: [1.5, 0, 0]", "to: [1.5, 1, 0]");
    const write = await service.write({ contextId: query.contextId,
      operation: { kind: "set-scene-animation-script", operationId: "animation-revision", script: revisedScript, duration: original.duration, loop: original.loop } });
    expect(write).toMatchObject({ ok: true, revision: 1, noop: false });
    const second = await service.read(query);
    if (!second.ok || !second.view.sceneArea?.animationScript) throw new Error("Expected the revised animation script");
    expect(second.view.sceneArea.animationScript.script).toBe(revisedScript);
    expect(second.view.sceneArea.animationScript.revision).toBe(2);
    expect(first.view.sceneArea.animationScript.script).toBe(original.script);
    expect(room.currentRevision).toBe(1);
    const reopened = new CanvasRoom({ canvasId: query.canvasId, repository, now: () => NOW });
    closers.push(() => reopened.dispose());
    await reopened.load();
    const persisted = reopened.exportCanvas();
    const area = persisted.ok ? decodeSceneAreaData(persisted.canvas.nodeData["area-node"]!.sceneArea) : null;
    expect(area?.ok && area.value.animationScript?.script).toBe(revisedScript);
  });

  it("distinguishes a director without animation from an older response", async () => {
    const { service, room } = await fixture({ animationScript: null });
    expect(await service.read(query)).toMatchObject({ ok: true, view: { sceneArea: { nodeId: "area-node", revision: 0, animationScript: null } } });
    expect(room.currentRevision).toBe(0);
  });

  it("rejects a different canvas and an unissued context", async () => {
    const { service } = await fixture();
    expect(await service.read({ ...query, canvasId: "another-canvas" })).toMatchObject({ ok: false, code: "stale-epoch" });
    expect(await service.read({ ...query, contextId: "unissued" })).toMatchObject({ ok: false, code: "not-issued" });
  });

  it.each(["cancel", "revoke"])("rechecks %s while waiting for a published read", async action => {
    const { service, room, revoke } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const queued = room.inspectPublished(async () => { entered(); await gate; });
    await started;
    const pending = service.read(query);
    if (action === "cancel") await service.cancel(query);
    else revoke();
    release();
    await queued;
    expect(await pending).toMatchObject({ ok: false, code: action === "cancel" ? "cancelled" : "stale-epoch" });
  });

  it.each(["areaId", "scopeVersion"])("rejects changed %s without returning stale animation", async field => {
    const { service, patchArea } = await fixture();
    expect((await patchArea({ [field]: "changed" })).ok).toBe(true);
    expect(await service.read(query)).toMatchObject({ ok: false, code: field === "areaId" ? "outside-scope" : "version-conflict" });
  });

  it("rejects the whole animation script if it targets a read-only part without exposing or filtering it", async () => {
    const { service, room } = await fixture({ readOnlyProp: true });
    const result = await service.read(query);
    expect(result).toMatchObject({ ok: false, code: "outside-scope", message: expect.stringContaining("原动画未修改") });
    expect(result).not.toHaveProperty("view");
    const published = room.exportCanvas();
    const area = published.ok ? decodeSceneAreaData(published.canvas.nodeData["area-node"]!.sceneArea) : null;
    expect(area?.ok && area.value.animationScript?.script).toBe(original.script);
    expect(room.currentRevision).toBe(0);
  });

  it("drops tracks whose target was deleted instead of locking the whole director area", async () => {
    const deletedCamera: WorldAnimationScript = {
      ...original,
      script: [
        'motion.instance.tween("actor", { property: "position", startTime: 0, endTime: 5, from: [-1.5, 0, 0], to: [1.5, 0, 0], easing: "easeOut" });',
        'motion.camera.tween({ cameraId: "deleted-camera", property: "position", startTime: 0, endTime: 5, from: [0, 0, 1.5], to: [2, 2, 1.5], easing: "linear" });'
      ].join("\n"),
      sourceHash: "hash-deleted-camera"
    };
    const { service, room } = await fixture({ animationScript: deletedCamera });
    const result = await service.read(query);
    if (!result.ok || !result.view.sceneArea) throw new Error(result.ok ? "Expected sceneArea" : result.message);
    expect(result.view.sceneArea.animationScript?.script).not.toContain("deleted-camera");
    const compiled = result.view.sceneArea.animationScript
      ? executeWorldAnimationScript(result.view.sceneArea.animationScript.script, {
          duration: result.view.sceneArea.animationScript.duration,
          loop: result.view.sceneArea.animationScript.loop
        })
      : null;
    expect(compiled?.ok && compiled.ir.cameraTracks).toEqual([]);
    expect(compiled?.ok && compiled.ir.instanceTracks.map(track => track.targetId)).toEqual(["actor"]);
    // Reading is pure: the dead track stays in the canonical script until a write replaces it.
    const published = room.exportCanvas();
    const area = published.ok ? decodeSceneAreaData(published.canvas.nodeData["area-node"]!.sceneArea) : null;
    expect(area?.ok && area.value.animationScript?.script).toContain("deleted-camera");
    expect(room.currentRevision).toBe(0);
  });

  it("reports no animation when every track references a deleted target", async () => {
    const deadOnly: WorldAnimationScript = {
      ...original,
      script: 'motion.camera.tween({ cameraId: "deleted-camera", property: "zoom", startTime: 0, endTime: 5, from: [1.2], to: [0.8], easing: "linear" });',
      sourceHash: "hash-dead-only"
    };
    const { service } = await fixture({ animationScript: deadOnly });
    expect(await service.read(query)).toMatchObject({ ok: true, view: { sceneArea: { animationScript: null } } });
  });

  it("keeps reading after an animated model node is deleted", async () => {
    const { service, room } = await fixture();
    const removed = await room.submit({
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId: query.canvasId,
      commandId: "delete-prop",
      baseRevision: room.currentRevision,
      actorId: "test",
      commands: [{ type: "node.remove", nodeIds: ["prop"] }]
    });
    expect(removed.ok).toBe(true);
    const result = await service.read(query);
    if (!result.ok || !result.view.sceneArea?.animationScript) throw new Error(result.ok ? "Expected script" : result.message);
    expect(result.view.sceneArea.animationScript.script).not.toContain('"prop"');
    expect(result.view.sceneArea.animationScript.script).toContain('"actor"');
  });
});

 it("rejects phantom parts and readonly part targets before publishing animation", async () => {
   const { service } = await fixture({ animationScript: null, readOnlyProp: true });
   const write = (target: string, part: string) => service.write({ contextId: query.contextId, operation: {
     kind: "set-scene-animation-script", operationId: `part-${target}`, duration: 2, loop: false,
     script: `motion.part.tween("${target}", "${part}", {property:"rotation",startTime:0,endTime:2,from:[0,0,0],to:[30,0,0],easing:"linear"});`
   } });
   expect(await write("actor", "phantom")).toMatchObject({ ok: false, code: "invalid-data" });
   expect(await write("prop", "phantom")).toMatchObject({ ok: false, code: "outside-scope" });
 });

it("publishes actual group bind hierarchy and accepts only emitted IDs", async () => {
 const { service } = await fixture({ animationScript: null, modelScript: 'scene.group({id:"hip", position:[0,1,0]}); scene.box({id:"leg",parent:"hip"});' });
 const read = await service.read(query);
 expect(read).toMatchObject({ok:true,view:{sceneModels:[{instanceId:"actor",animationRig:{groups:[{id:"hip",parent:null,position:[0,1,0]}],rig:null}}, {instanceId:"prop"}]}});
 const result = await service.write({contextId:query.contextId,operation:{kind:"set-scene-animation-script",operationId:"valid-part",duration:2,loop:false,
 script:'motion.part.tween("actor","hip",{property:"rotation",startTime:0,endTime:2,from:[0,0,0],to:[30,0,0],easing:"linear"});'}});
 expect(result).toMatchObject({ok:true});
});

it("persists reusable cycles without expanding them and reads them back unchanged", async () => {
  const {service} = await fixture({animationScript:null,modelScript:'scene.group({id:"hip"});scene.box({id:"body",parent:"hip"});'});
  const script='motion.part.cycle("actor","hip",{property:"rotation",startTime:0,endTime:18,period:1,keyframes:[{time:0,value:[-20,0,0]},{time:0.5,value:[20,0,0]},{time:1,value:[-20,0,0]}]});';
  expect(await service.write({contextId:query.contextId,operation:{kind:"set-scene-animation-script",operationId:"cycle",duration:18,loop:true,script}})).toMatchObject({ok:true});
  const read=await service.read(query);
  expect(read.ok && read.view.sceneArea?.animationScript?.script).toBe(script);
});

const humanoidSource = [
  'scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.1});',
  ...["Left", "Right"].flatMap(side => [
    `scene.segment({id:"${side}upper",parent:rig.joint("${side}UpperArm"),from:[0,0,0],to:[${side === "Left" ? 0.3 : -0.28},0,0],width:0.05});`,
    `scene.segment({id:"${side}lower",parent:rig.joint("${side}LowerArm"),from:[0,0,0],to:[${side === "Left" ? 0.25 : -0.24},0,0],width:0.04});`
  ])
].join("\n");

it("persists the rig of a newly created director actor and exposes its motion reference", async () => {
  const { service, room } = await fixture({ empty: true, animationScript: null });
  const result = await service.write({ contextId: query.contextId, operation: {
    kind: "create-model", operationId: "fresh-actor", nodeId: "actor", instanceId: "actor",
    content: { modelScript: humanoidSource },
    transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
  } });
  expect(result).toMatchObject({ ok: true });
  const published = room.exportCanvas();
  if (!published.ok) throw new Error(published.message);
  const fields = published.canvas.nodeData.actor!;
  expect(fields.modelRig).toBeDefined();
  const normalized = normalizeModelDefinition({ modelScript: fields.modelScript, modelScriptLanguage: fields.modelScriptLanguage,
    modelScriptVersion: fields.modelScriptVersion, placement: fields.modelPlacement, rig: fields.modelRig });
  expect(normalized.ok && normalized.value.contentVersion.contentHash).toBe((fields.modelContentVersion as { contentHash: string }).contentHash);
  const read = await service.read(query);
  expect(read.ok && read.view.sceneModels?.[0]?.animationRig?.motionReference).toBeDefined();
});

it("resolves the effective rig for legacy rig.joint scripts without mutating the model", async () => {
  const { service, room } = await fixture({ animationScript: null, modelScript: humanoidSource });
  const read = await service.read(query);
  expect(read.ok && read.view.sceneModels?.[0]?.animationRig?.motionReference).toBeDefined();
  const published = room.exportCanvas();
  expect(published.ok && published.canvas.nodeData.actor?.modelRig).toBeUndefined();
});

it("keeps plain geometry without humanoid metadata", async () => {
  const { service } = await fixture({ animationScript: null });
  const read = await service.read(query);
  expect(read.ok && read.view.sceneModels?.[0]?.animationRig?.rig).toBeNull();
  expect(read.ok && read.view.sceneModels?.[0]?.animationRig?.motionReference).toBeUndefined();
});

it("preserves custom rig parameters and content hashes across director replacement, and blocks removal", async () => {
  const custom = referenceHumanoidRig({ ...HUMANOID_REFERENCE_PARAMETERS, leftUpperArm: 0.42 });
  if (!custom.ok) throw new Error("Invalid fixture rig");
  const { service, room } = await fixture({ animationScript: null, modelScript: humanoidSource, modelRig: custom.value });
  const before = room.exportCanvas();
  if (!before.ok) throw new Error(before.message);
  const identity = { kind: "instance" as const, instanceId: "actor" };
  const result = await service.write({ contextId: query.contextId, operation: {
    kind: "replace-model-content", operationId: "custom-replace", instanceId: "actor",
    expectedVersion: worldObjectVersion(before.canvas, identity)!, content: { modelScript: humanoidSource + "\n// revised" }
  } });
  expect(result).toMatchObject({ ok: true });
  const after = room.exportCanvas();
  if (!after.ok) throw new Error(after.message);
  const fields = after.canvas.nodeData.actor!;
  expect(fields.modelRig).toEqual(custom.value);
  const normalized = normalizeModelDefinition({ modelScript: fields.modelScript, modelScriptLanguage: fields.modelScriptLanguage,
    modelScriptVersion: fields.modelScriptVersion, placement: fields.modelPlacement, rig: fields.modelRig });
  expect(normalized.ok && normalized.value.contentVersion.contentHash).toBe((fields.modelContentVersion as { contentHash: string }).contentHash);
  const revision = room.currentRevision;
  expect(await service.write({ contextId: query.contextId, operation: {
    kind: "replace-model-content", operationId: "remove-rig", instanceId: "actor",
    expectedVersion: worldObjectVersion(after.canvas, identity)!, content: { modelScript: "scene.box({});" }
  } })).toMatchObject({ ok: false, code: "invalid-data", message: expect.stringContaining("不能移除已有骨架") });
  expect(room.currentRevision).toBe(revision);
});

it('validates generated walks against actual rig, transform and writable scope',async()=>{
 const modelScript=humanoidSource+'\nfor(const side of ["Left","Right"])scene.box({id:side+"Sole",parent:rig.joint(side+"Foot"),position:[0,-0.04,0.08],size:[0.24,0.14,0.38]});';
 const {service,room}=await fixture({animationScript:null,modelScript});
 const read=await service.read(query);if(!read.ok)throw new Error(read.message);
 const profile=read.view.sceneModels?.find(m=>m.instanceId==='actor')?.animationRig?.walkProfile;
 expect(profile).toBeTruthy();
 const options={startTime:0,endTime:24,path:[[-1,-1],[1,-1],[1,1],[-1,1]],cornerRadius:.5,strideLength:.6,stepHeight:.09,scale:1,baseYawDegrees:0,profile};
 const write=(id:string,target='actor',changes={})=>service.write({contextId:query.contextId,operation:{kind:'set-scene-animation-script',operationId:id,duration:24,loop:true,script:`motion.instance.walk(${JSON.stringify(target)},${JSON.stringify({...options,...changes})});`}});
 expect(await write('walk-good')).toMatchObject({ok:true});
 const revision=room.currentRevision;
 expect(await write('walk-bad-scale','actor',{scale:1.1})).toMatchObject({ok:false,code:'invalid-data'});
 expect(await write('walk-bad-yaw','actor',{baseYawDegrees:30})).toMatchObject({ok:false,code:'invalid-data'});
 expect(await write('walk-bad-profile','actor',{profile:{...profile,armsDownPose:{LeftUpperArm:[0,0,-80],RightUpperArm:[0,0,80]}}})).toMatchObject({ok:false,code:'invalid-data'});
 expect(await write('walk-outside','missing')).toMatchObject({ok:false,code:'outside-scope'});
 expect(room.currentRevision).toBe(revision);
});
