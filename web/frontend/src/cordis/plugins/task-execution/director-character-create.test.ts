import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, decodeModel3DNodeData, normalizeModelDefinition, executeModelScriptVersioned, type WorldAuthoringPrepareOutcome } from "@woohaa3/contracts";
import { characterSpawn, createDirectorCharacter, DIRECTOR_CHARACTER_SCRIPTS } from "./director-character-create.js";
const bounds = { min: { u: -2, v: -2 }, max: { u: 2, v: 2 } };
const local = { min: [-0.22, 0, -0.22] as [number, number, number], max: [0.22, 1.7, 0.22] as [number, number, number] };
function setup() {
  const canvas = createEmptyWoohaa3ServerCanvas("c", "2026-11-12T00:00:00Z");
  canvas.document.nodes.push({ id: "area", type: "scene-area", position: { x: 0, y: 0 } });
  canvas.nodeData.area = { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "v1", bounds } };
  const snapshot = { version: "world-authoring-v1", canvasId: "c", revision: 0, areaNodeId: "area", area: { areaId: "a", scopeVersion: "v1", bounds }, bounds,
    scope: { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "v1" }, writable: [], readOnly: [], members: { instances: [], cameras: [] }, objects: [],
    occupancy: { version: "world-scope-occupancy-v1", scope: { scope: { kind: "scene-area", areaId: "a" }, scopeVersion: "v1" }, state: "idle", locks: [] } } as const;
  const remote = { prepareSceneArea: vi.fn(async () => ({ ok: true, snapshot }) as unknown as WorldAuthoringPrepareOutcome) };
  const edit = { record: vi.fn(async () => ({ ok: true, entry: {} }) as never) };
  return { canvas, remote, edit, input: { canvasId: "c", nodeId: "area", areaId: "a", kind: "capsule" as const, writable: () => true, getCanvas: () => canvas, remote, edit } };
}
describe("director character creation", () => {
  it("places center first and finds a free contained position", () => {
    expect(characterSpawn(bounds, local, [])).toEqual({ u: 0, v: 0 });
    const occupied = { min: { u: -0.3, v: -0.3 }, max: { u: 0.3, v: 0.3 } };
    const p = characterSpawn(bounds, local, [occupied]);
    expect(Math.hypot(p.u, p.v)).toBeGreaterThan(0.5);
    expect(p.u - 0.22).toBeGreaterThanOrEqual(-2); expect(p.v + 0.22).toBeLessThanOrEqual(2);
  });
  it("never falls back outside a small or full area", () => {
    expect(() => characterSpawn({ min: { u: 0, v: 0 }, max: { u: 0.2, v: 0.2 } }, local, [])).toThrow("空间");
    expect(() => characterSpawn(bounds, local, [bounds])).toThrow("空位");
  });
  it("creates exactly one model through shared user edit history without an AI port", async () => {
    const { input, edit } = setup(); await createDirectorCharacter(input);
    expect(edit.record).toHaveBeenCalledTimes(1);
    const commands = edit.record.mock.calls[0] as unknown as [Array<{ nodeData: { modelScript: string; sharedWorldInstance: { transform: { position: unknown } } } }>];
    expect(commands[0]).toHaveLength(1);
    const fields = commands[0][0].nodeData as unknown as Record<string, unknown>;
    expect(fields.modelScriptLanguage).toBe("javascript");
    const stored = decodeModel3DNodeData(fields);
    expect(stored.ok).toBe(true);
    expect(normalizeModelDefinition({ modelScript: fields.modelScript as string, modelScriptLanguage: fields.modelScriptLanguage, modelScriptVersion: fields.modelScriptVersion, placement: fields.modelPlacement, rig: fields.modelRig }).ok).toBe(true);

    expect(commands[0][0].nodeData.sharedWorldInstance.transform.position).toEqual({ u: 0, v: 0, h: 0 });
    const result = executeModelScriptVersioned(commands[0][0].nodeData.modelScript, "woohaa-model-js-v2");
    expect(result.ok).toBe(true);
    expect(DIRECTOR_CHARACTER_SCRIPTS.humanoid).toBe('scene.somaHumanoid({ style: "humanoid" });');
  });
  it("stores a canonical ordinary humanoid definition with its embedded skeleton", async () => {
    const { input, edit } = setup(); await createDirectorCharacter({ ...input, kind: "humanoid" });
    const commands = edit.record.mock.calls[0] as unknown as [Array<{ nodeData: Record<string, unknown> }>];
    const fields = commands[0][0].nodeData;
    expect(fields.modelScriptLanguage).toBe("javascript");
    expect(fields.modelContentVersion).toBeDefined(); expect(fields.modelPlacement).toBeDefined();
    const compiled = executeModelScriptVersioned(fields.modelScript as string, fields.modelScriptVersion);
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      const skin = compiled.scene.ops.find(op => op.t === "mesh" && op.id === "humanoid.skin");
      expect(skin?.t === "mesh" ? skin.skin?.jointIds.length : 0).toBe(77);
    }
    expect(decodeModel3DNodeData(fields).ok).toBe(true);
    expect(normalizeModelDefinition({ modelScript: fields.modelScript, modelScriptLanguage: fields.modelScriptLanguage, modelScriptVersion: fields.modelScriptVersion, placement: fields.modelPlacement, rig: fields.modelRig }).ok).toBe(true);
  });
  it("rejects read-only before requests and occupied/unknown before writes", async () => {
    const { input, edit, remote } = setup();
    await expect(createDirectorCharacter({ ...input, writable: () => false })).rejects.toThrow("只读");
    expect(remote.prepareSceneArea).not.toHaveBeenCalled();
    for (const state of ["occupied", "unknown"] as const) {
      const response = await remote.prepareSceneArea();
      if (response.ok) remote.prepareSceneArea.mockResolvedValueOnce({ ...response, snapshot: { ...response.snapshot, occupancy: { ...response.snapshot.occupancy, state } } });
      await expect(createDirectorCharacter(input)).rejects.toThrow("正在使用中");
    }
    expect(edit.record).not.toHaveBeenCalled();
  });
});

it('creates every body with its canonical script, durable marker and combination name',async()=>{
 const {SOMA_BODY_PRESETS,somaBodyPresetName,directorCharacterScript}=await import('@woohaa3/contracts');
 const {input,edit}=setup();
 for(const preset of SOMA_BODY_PRESETS){
  edit.record.mockClear();await createDirectorCharacter({...input,kind:'humanoid',bodyPreset:preset.id});
  const fields=(edit.record.mock.calls[0] as unknown as [Array<{nodeData:Record<string,unknown>}>])[0][0].nodeData;
  expect(fields.modelScript).toBe(directorCharacterScript('humanoid',preset.id));
  expect(fields.directorCharacterCreation).toMatchObject({bodyPreset:preset.id});expect(fields.title).toBe(somaBodyPresetName(preset.id));
 }
},30000);

it('persists the short capsule marker, title and canonical factory',async()=>{
 const {input,edit}=setup();await createDirectorCharacter({...input,kind:'capsule',capsulePreset:'two-heads'});
 const fields=(edit.record.mock.calls[0] as unknown as [Array<{nodeData:Record<string,unknown>}>])[0][0].nodeData;
 expect(fields.directorCharacterCreation).toMatchObject({kind:'capsule',capsulePreset:'two-heads'});
 expect(fields.title).toBe('胶囊人 · 2头身');
 const {directorCharacterScript}=await import('@woohaa3/contracts');
 expect(fields.modelScript).toBe(directorCharacterScript('capsule',undefined,'two-heads'));
 expect(decodeModel3DNodeData(fields).ok).toBe(true);
});
