import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, DIRECTOR_CHARACTER_SCRIPTS, type ServerCanvas } from "@woohaa3/contracts";
import { createWorldAuthoringAuthority } from "./authority.js";
function setup() {
  const before = createEmptyWoohaa3ServerCanvas("c", "2026-11-12T00:00:00Z");
  before.document.nodes.push({ id: "a", type: "scene-area", position: { x: 0, y: 0 } });
  before.nodeData.a = { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "v1", bounds: { min: { u: -2, v: -2 }, max: { u: 2, v: 2 } } } };
  const after = structuredClone(before);
  add(after, "character", 0);
  return { before, after, authority: createWorldAuthoringAuthority() };
}
function add(canvas: ServerCanvas, id: string, u: number) {
  canvas.document.nodes.push({ id, type: "model3d", position: { x: 0, y: 0 } });
  canvas.nodeData[id] = { directorCharacterCreation: { areaId: "a", scopeVersion: "v1", kind: "capsule" }, modelScript: DIRECTOR_CHARACTER_SCRIPTS.capsule, modelScriptVersion: "woohaa-model-js-v2", modelScriptLanguage: "javascript",
    sharedWorldInstance: { kind: "world-instance", version: "shared-world-v1", instanceId: id, transform: { version: "shared-world-v1", position: { u, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } } };
}
describe("atomic director character guard", () => {
  it("requires prepared canonical scope and checks actual bounds", async () => {
    const { before, after, authority } = setup();
    expect(() => authority.userCreateTargets!(before, after)).toThrow();
    await authority.prepareCanvas(before, { kind: "scene-area", areaId: "a" });
    expect(authority.userCreateTargets!(before, after)).toEqual([]);
    after.nodeData.character.sharedWorldInstance = { ...(after.nodeData.character.sharedWorldInstance as object), transform: { version: "shared-world-v1", position: { u: 2, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
    expect(() => authority.userCreateTargets!(before, after)).toThrow();
  });
  it("returns existing scope members for atomic lease validation and rejects overlap", async () => {
    const { before, after, authority } = setup(); add(before, "existing", 1); add(after, "existing", 1);
    await authority.prepareCanvas(before, { kind: "scene-area", areaId: "a" });
    expect(authority.userCreateTargets!(before, after)).toContainEqual({ kind: "instance", instanceId: "existing" });
    add(after, "second", 0);
    expect(() => authority.userCreateTargets!(before, after)).toThrow();
  });
  it("rejects substituted scripts and changed director bounds", async () => {
    const { before, after, authority } = setup(); await authority.prepareCanvas(before, { kind: "scene-area", areaId: "a" });
    after.nodeData.character.modelScript = "scene.box({});";
    expect(() => authority.userCreateTargets!(before, after)).toThrow();
    after.nodeData.character.modelScript = DIRECTOR_CHARACTER_SCRIPTS.capsule;
    after.nodeData.a.sceneArea = { ...(after.nodeData.a.sceneArea as object), scopeVersion: "v2" };
    expect(() => authority.userCreateTargets!(before, after)).toThrow();
  });
});

it.each([undefined,"two-heads","soma-body-v1/female-10-fat","soma-body-v1/baby","soma-body-v1/male-child","soma-body-v1/female-child","soma-body-v1/male-teen","soma-body-v1/female-teen"] as const)("atomically creates/retries and reopens %s without half writes", async (bodyPreset) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SqliteYjsRepository } = await import("../storage/sqlite/yjs.js");
  const { SqliteSpatialLeaseStore } = await import("../storage/sqlite/spatial-leases.js");
  const { loadNodeSqlite } = await import("../storage/sqlite/sqlite-loader.js");
  const { CanvasRoom } = await import("../sync/room.js");
  const { YJS_SYNC_PROTOCOL_VERSION } = await import("@woohaa3/contracts/canvas-yjs");
  const { before, after, authority } = setup();
  if(bodyPreset==='two-heads'){
    const {directorCharacterScript}=await import('@woohaa3/contracts');
    after.nodeData.character.directorCharacterCreation={areaId:'a',scopeVersion:'v1',kind:'capsule',capsulePreset:bodyPreset};
    after.nodeData.character.modelScript=directorCharacterScript('capsule',undefined,bodyPreset);
  }else if(bodyPreset){
    const {directorCharacterScript}=await import('@woohaa3/contracts');
    after.nodeData.character.directorCharacterCreation={areaId:'a',scopeVersion:'v1',kind:'humanoid',bodyPreset};
    after.nodeData.character.modelScript=directorCharacterScript('humanoid',bodyPreset);
  }
  await authority.prepareCanvas(before, { kind: "scene-area", areaId: "a" });
  const dir = mkdtempSync(join(tmpdir(), "director-create-"));
  const file = join(dir, "canvas.sqlite");
  const db = new (loadNodeSqlite().DatabaseSync)(file);
  const leases = new SqliteSpatialLeaseStore(db, { eligible: () => true, stopped: () => true });
  const repository = new SqliteYjsRepository({ path: file, spatialAuthority: authority });
  try {
    const room = new CanvasRoom({ canvasId: before.id, repository });
    await room.initialize({ canvas: before, roomEpoch: "e" });
    leases.acquire({ canvasId: before.id, requestId: "r", runId: "run", epoch: 1, executionId: "exec", scope: { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "v1" }, writable: [], readOnly: [] });
    const request = { protocolVersion: YJS_SYNC_PROTOCOL_VERSION, canvasId: before.id, commandId: "create", actorId: "user", baseRevision: 0, commands: [{ type: "node.add", node: after.document.nodes.find(n => n.id === "character")!, nodeData: after.nodeData.character }] } as never;
    const result = await room.submit(request);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: "lease-conflict" });
    expect((await repository.loadYjsState(before.id))?.projection?.document.nodes).toHaveLength(1);
    expect(await repository.getCommandRecord(before.id, "create")).toBeNull();
    leases.cancel(before.id, "r");
    expect(await room.submit(request)).toMatchObject({ ok: false, code: "lease-conflict" });
    leases.confirmStopped(before.id, "r", "run", 1, "exec", {});
    expect(await room.submit(request)).toMatchObject({ ok: true });
    expect((await repository.loadYjsState(before.id))?.projection?.document.nodes).toHaveLength(2);
    const persisted = (await repository.loadYjsState(before.id))!.projection!;
    const prepared = await authority.prepareCanvas(persisted, { kind: "scene-area", areaId: "a" });
    expect(prepared.ok && prepared.snapshot.objects.find(object => object.nodeId === "character")?.containment).toBe("writable");
    expect(await room.submit(request)).toMatchObject({ ok: true });
    expect((await repository.loadYjsState(before.id))?.projection?.document.nodes).toHaveLength(2);
    const savedFields=structuredClone(persisted.nodeData.character);
    const savedNode=structuredClone(persisted.document.nodes.find(node=>node.id==='character')!);
    const apply=async(commandId:string,commands:unknown[])=>{
      const latest=(await repository.loadYjsState(before.id))!.projection!;
      await authority.prepareCanvas(latest,{kind:'scene-area',areaId:'a'});
      return room.submit({protocolVersion:YJS_SYNC_PROTOCOL_VERSION,canvasId:before.id,actorId:'user',commandId,baseRevision:latest.revision,commands} as never);
    };
    expect(await apply('undo-create',[{type:'node.remove',nodeIds:['character']}])).toMatchObject({ok:true});
    expect((await repository.loadYjsState(before.id))!.projection!.nodeData.character).toBeUndefined();
    expect(await apply('redo-create',[{type:'node.add',node:savedNode,nodeData:savedFields}])).toMatchObject({ok:true});
    const copy=structuredClone(savedFields),instance=copy.sharedWorldInstance as any;
    instance.instanceId='copy';instance.transform.position.v+=1;
    expect(await apply('copy-body',[{type:'node.add',node:{...savedNode,id:'copy'},nodeData:copy}])).toMatchObject({ok:true});
    const copied=(await repository.loadYjsState(before.id))!.projection!;
    expect(copied.nodeData.copy.modelScript).toBe(savedFields.modelScript);
    expect(copied.document.nodes).toHaveLength(3);
    const reopened = new CanvasRoom({ canvasId: before.id, repository });
    expect(await reopened.load()).toMatchObject({ok:true});
    expect((await repository.loadYjsState(before.id))!.projection!.nodeData.character.modelScript).toBe(after.nodeData.character.modelScript);
    if(bodyPreset==='two-heads')expect((await repository.loadYjsState(before.id))!.projection!.nodeData.character.directorCharacterCreation).toMatchObject({capsulePreset:bodyPreset});
    else if(bodyPreset)expect((await repository.loadYjsState(before.id))!.projection!.nodeData.character.directorCharacterCreation).toMatchObject({bodyPreset});
  } finally { repository.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('accepts all catalog factories and rejects substituted preset identities or forged geometry',async()=>{
 const {SOMA_BODY_PRESETS,directorCharacterScript}=await import('@woohaa3/contracts');
 const {before,after,authority}=setup();await authority.prepareCanvas(before,{kind:'scene-area',areaId:'a'});
 for(const preset of SOMA_BODY_PRESETS){
  const fields=after.nodeData.character;
  fields.directorCharacterCreation={areaId:'a',scopeVersion:'v1',kind:'humanoid',bodyPreset:preset.id};
  fields.modelScript=directorCharacterScript('humanoid',preset.id);
  expect(authority.userCreateTargets!(before,after)).toEqual([]);
  fields.directorCharacterCreation={areaId:'a',scopeVersion:'v1',kind:'humanoid',bodyPreset:'soma-body-v1/unknown'};
  expect(()=>authority.userCreateTargets!(before,after)).toThrow();
  fields.directorCharacterCreation={areaId:'a',scopeVersion:'v1',kind:'humanoid',bodyPreset:preset.id};
  fields.modelScript+='scene.box({id:"extra",size:[10,10,10]});';
  expect(()=>authority.userCreateTargets!(before,after)).toThrow();
 }
},30000);

it('guards the two-head capsule identity and exact geometry',async()=>{
 const {directorCharacterScript}=await import('@woohaa3/contracts');
 const {before,after,authority}=setup();await authority.prepareCanvas(before,{kind:'scene-area',areaId:'a'});
 const fields=after.nodeData.character;
 fields.directorCharacterCreation={areaId:'a',scopeVersion:'v1',kind:'capsule',capsulePreset:'two-heads'};
 fields.modelScript=directorCharacterScript('capsule',undefined,'two-heads');
 expect(authority.userCreateTargets!(before,after)).toEqual([]);
 fields.modelScript=DIRECTOR_CHARACTER_SCRIPTS.capsule;expect(()=>authority.userCreateTargets!(before,after)).toThrow();
 fields.modelScript=directorCharacterScript('capsule',undefined,'two-heads');
 fields.directorCharacterCreation={areaId:'a',scopeVersion:'v1',kind:'humanoid',capsulePreset:'two-heads'};
 expect(()=>authority.userCreateTargets!(before,after)).toThrow();
});
