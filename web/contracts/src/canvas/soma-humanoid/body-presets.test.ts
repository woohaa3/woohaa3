import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SOMA_BODY_PRESETS, somaBodyData, somaBodyPresetId, somaBodyPresetName, resolveSomaBodyPreset } from './body-presets.js';
import { SOMA_BODY_MANIFEST } from './body-manifest.js';
import { SOMA_BODY_MANIFEST_V2 } from './body-manifest-v2.js';
import { executeModelScriptV2 } from '../model-executor-v2.js';
import { directorCharacterScript } from '../director-character.js';
import { validateWorldIdentities } from '../domain/world-identities.js';
import { somaSkeletonIdentity } from './validation.js';
import { composeTransform, transformOf, quatRotate, type Transform, type Vec3 } from '../model-transform.js';
import { v2SceneAabb } from '../scene-ir-v2/bounds.js';

it('keeps the immutable v1 catalog and exposes the Anny-only v2 matrix', () => {
  expect(SOMA_BODY_MANIFEST.entries).toHaveLength(21);
  expect(SOMA_BODY_MANIFEST_V2.entries).toHaveLength(8);
  expect(SOMA_BODY_PRESETS).toHaveLength(29);
  expect(new Set(SOMA_BODY_PRESETS.map(p => p.id)).size).toBe(29);
  expect(SOMA_BODY_MANIFEST_V2.entries.every(p => Object.keys(p.localChanges).length === 0)).toBe(true);
  expect(somaBodyPresetId({ age: 'adult', sex: 'male' })).toBe('soma-body-v2/male');
  expect(somaBodyPresetId({ age: 'adult', sex: 'female' })).toBe('soma-body-v2/female');
  expect(somaBodyPresetId({ age: 'newborn', sex: 'male' })).toBe('soma-body-v2/male-newborn');
  expect(somaBodyPresetId({ age: 'child', sex: 'female' })).toBe('soma-body-v2/female-child');
  expect(somaBodyPresetId({ age: 'old', sex: 'male' })).toBe('soma-body-v2/male-old');
  expect(somaBodyPresetName('soma-body-v2/male')).toBe('男青年');
  for (const preset of SOMA_BODY_PRESETS) {
    expect(preset.parameters.gender).toBe(preset.sex === 'neutral' ? .5 : preset.sex === 'male' ? 0 : 1);
    expect(() => resolveSomaBodyPreset(preset.id)).not.toThrow();
  }
  for (const id of ['male-8-slim', 'soma-body-v2/male-8-slim', 'soma-body-v1/male-6-slim', null, {}]) {
    expect(() => resolveSomaBodyPreset(id)).toThrow();
  }
  expect(executeModelScriptV2('scene.somaHumanoid({style:"humanoid",bodyPreset:"soma-body-v2/male"});').ok).toBe(true);
  expect(executeModelScriptV2('scene.somaHumanoid({style:"humanoid",bodyPreset:"soma-body-v1/male-8-slim"});').ok).toBe(true);
  expect(() => directorCharacterScript('capsule', 'soma-body-v2/male')).toThrow();
});

it('reads retired v2 baby IDs as newborn bodies without exposing aliases', () => {
  for (const [legacy, canonical] of Object.entries({
    'soma-body-v2/male-baby': 'soma-body-v2/male-newborn',
    'soma-body-v2/female-baby': 'soma-body-v2/female-newborn'
  })) {
    expect(SOMA_BODY_PRESETS.some(preset => preset.id === legacy)).toBe(false);
    expect(resolveSomaBodyPreset(legacy).id).toBe(canonical);
    const compiled = executeModelScriptV2(`scene.somaHumanoid({style:"humanoid",bodyPreset:${JSON.stringify(legacy)}});`);
    expect(compiled.ok).toBe(true);
  }
  expect(validateWorldIdentities(
    [{ id: 'character', type: 'model3d' }],
    {
      character: {
        sharedWorldInstance: {
          kind: 'world-instance', version: 'shared-world-v1', instanceId: 'instance-1',
          transform: { version: 'shared-world-v1', position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
        },
        directorCharacterCreation: {
          areaId: 'area-1', scopeVersion: 'scope-1', kind: 'humanoid', bodyPreset: 'soma-body-v2/female-baby'
        }
      }
    }
  )).toBeNull();
});

it('validates every packed body and its versioned skeleton identity', () => {
  for (const entry of SOMA_BODY_PRESETS) {
    const body = somaBodyData(entry.id), skin = body.skin;
    expect(skin.vertices).toHaveLength(18056);
    expect(skin.faces).toHaveLength(36108);
    const ys = skin.vertices.map(v => v[1]);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(entry.measurements.height, 6);
    const maxHead = Math.max(...(entry.id.startsWith('soma-body-v2/') ? SOMA_BODY_MANIFEST_V2 : SOMA_BODY_MANIFEST).measurement.headSurfaceVertices.map(i => skin.vertices[i]![1]));
    const chin = skin.vertices[(entry.id.startsWith('soma-body-v2/') ? SOMA_BODY_MANIFEST_V2 : SOMA_BODY_MANIFEST).measurement.chinVertex]![1];
    if (entry.heads !== null) expect(Math.abs(1.7 / (maxHead - chin) - entry.heads)).toBeLessThan(.05);
    for (let i = 0; i < skin.vertices.length; i++) {
      expect(skin.indices[i]).toHaveLength(10);
      expect(skin.weights[i]!.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    }
    const hash = createHash('sha256');
    for (const [array, integer] of [[skin.vertices, false], [body.joints.flatMap(j => j.bind), false], [skin.inverseBindMatrices, false], [skin.faces, true], [skin.indices, true], [skin.weights, false]] as const) {
      const flat = array.flat(), bytes = new Uint8Array(flat.length * 4), view = new DataView(bytes.buffer);
      flat.forEach((value, i) => integer ? view.setUint32(i * 4, value, true) : view.setFloat32(i * 4, value, true));
      hash.update(bytes);
    }
    expect(hash.digest('hex')).toBe(entry.sha256);
    const compiled = executeModelScriptV2(directorCharacterScript('humanoid', entry.id));
    expect(compiled.ok).toBe(true); if (!compiled.ok) return;
    const groups = compiled.scene.ops.filter(op => op.t === 'group');
    const identity = somaSkeletonIdentity(groups);
    expect(identity?.prefix).toBe('humanoid');
    expect(identity?.bodyPreset).toBe(entry.id);
    const world: Transform[] = [];
    for (const joint of body.joints) {
      const op = groups.find(group => group.id === `humanoid.${joint.name}`)!;
      const local = transformOf(op), transform = joint.parent < 0 ? local : composeTransform(world[joint.parent]!, local);
      world.push(transform);
      transform.translation.forEach((value, row) => expect(value).toBeCloseTo(joint.bind[row]![3]!, 5));
      for (let axis = 0; axis < 3; axis++) {
        const basis: Vec3 = [0, 0, 0]; basis[axis] = 1;
        quatRotate(transform.rotation, basis).forEach((value, row) => expect(value).toBeCloseTo(joint.bind[row]![axis]!, 5));
      }
    }
    const reopened = executeModelScriptV2(directorCharacterScript('humanoid', entry.id));
    expect(reopened.ok).toBe(true);
  }
});

it('uses Anny age anchors and average body dimensions for the v2 quick presets', () => {
  const byId = new Map(SOMA_BODY_MANIFEST_V2.entries.map(entry => [entry.id, entry]));
  for (const id of ['soma-body-v2/male', 'soma-body-v2/female'] as const) {
    const entry = byId.get(id)!;
    expect(entry.parameters.age).toBeCloseTo(2 / 3);
    expect(entry.parameters.muscle).toBe(.5);
    expect(entry.parameters.weight).toBe(.5);
    expect(entry.parameters.proportions).toBe(0);
  }
  expect(byId.get('soma-body-v2/male-newborn')!.parameters.age).toBeCloseTo(-1 / 3);
  expect(byId.get('soma-body-v2/male-child')!.parameters.age).toBeCloseTo(1 / 3);
  expect(byId.get('soma-body-v2/male-old')!.parameters.age).toBe(1);
});

it('keeps the two-head capsule independent from humanoid body presets', () => {
  const compiled = executeModelScriptV2(directorCharacterScript('capsule', undefined, 'two-heads'));
  expect(compiled.ok).toBe(true); if (!compiled.ok) return;
  const bounds = v2SceneAabb(compiled.scene.ops)!;
  expect(bounds.min[1]).toBeCloseTo(0, 6); expect(bounds.max[1]).toBeCloseTo(.88, 6);
  expect(compiled.scene.ops.find(op => op.id === 'body')).toMatchObject({ height: .44, radius: .22, position: [0, .22, 0] });
  expect(compiled.scene.ops.find(op => op.id === 'head')).toMatchObject({ radius: .22, position: [0, .66, 0] });
  expect(() => directorCharacterScript('humanoid', undefined, 'two-heads')).toThrow();
  expect(() => directorCharacterScript('capsule', 'soma-body-v2/female-child', 'two-heads')).toThrow();
});
