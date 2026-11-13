import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SOMA_BODY_PRESETS, somaBodyData, somaBodyPresetId, resolveSomaBodyPreset } from './body-presets.js';
import { SOMA_BODY_MANIFEST } from './body-manifest.js';
import { executeModelScriptV2 } from '../model-executor-v2.js';
import { directorCharacterScript } from '../director-character.js';
import { somaSkeletonIdentity } from './validation.js';
import { composeTransform, transformOf, quatRotate, type Transform, type Vec3 } from '../model-transform.js';
import { v2SceneAabb } from '../scene-ir-v2/bounds.js';
import { normalizeModelDefinition } from '../model-definition.js';

it('has exactly the complete Cartesian matrix and rejects unknown or unsupported combinations', () => {
  expect(SOMA_BODY_PRESETS).toHaveLength(21);
  expect(new Set(SOMA_BODY_PRESETS.map(p=>p.sha256)).size).toBe(21);
  for(const sex of ['male','female'] as const)for(const heads of [7,8,9,10] as const)for(const build of ['slim','fat'] as const)
    expect(somaBodyPresetId({sex,heads,build})).toBe(`soma-body-v1/${sex}-${heads}-${build}`);
  for(const preset of SOMA_BODY_PRESETS)expect(preset.parameters.gender).toBe(preset.sex==='neutral'?.5:preset.sex==='male'?0:1);
  for(const id of ['male-8-slim','soma-body-v2/male-8-slim','soma-body-v1/male-6-slim',null,{}])expect(()=>resolveSomaBodyPreset(id)).toThrow();
  expect(executeModelScriptV2('scene.somaHumanoid({bodyPreset:"soma-body-v1/male-8-slim"});').ok).toBe(false);
  expect(()=>directorCharacterScript('capsule','soma-body-v1/male-8-slim')).toThrow();
});

describe('exported body surface, binding and identity',()=>{
 for(const entry of SOMA_BODY_PRESETS)it(entry.id,()=>{
  const body=somaBodyData(entry.id),s=body.skin;
  expect(s.vertices).toHaveLength(18056);expect(s.faces).toHaveLength(36108);
  const ys=s.vertices.map(v=>v[1]);
  expect(Math.min(...ys)).toBeCloseTo(0,6);expect(Math.max(...ys)).toBeCloseTo(entry.measurements.height,6);
  const headHeight=Math.max(...SOMA_BODY_MANIFEST.measurement.headSurfaceVertices.map(i=>s.vertices[i]![1]))-s.vertices[SOMA_BODY_MANIFEST.measurement.chinVertex]![1];
  if(entry.heads !== null) expect(Math.abs(1.7/headHeight-entry.heads)).toBeLessThan(.05);
  const pair=SOMA_BODY_PRESETS.find(p=>p.sex===entry.sex&&p.heads===entry.heads&&p.build!=='fat')!;
  if(entry.build==='fat')expect(entry.measurements.waist/pair.measurements.waist).toBeGreaterThanOrEqual(1.15);
  let maxError=0;
  for(let i=0;i<s.vertices.length;i++){
   expect(s.indices[i]).toHaveLength(10);expect(s.weights[i]).toHaveLength(10);
   expect(s.weights[i]!.reduce((a,b)=>a+b,0)).toBeCloseTo(1,5);
   const v=s.vertices[i]!,out=[0,0,0];
   for(let k=0;k<s.indices[i]!.length;k++){
    const n=s.indices[i]![k]!,w=s.weights[i]![k]!,inv=s.inverseBindMatrices[n]!,b=body.joints[n]!.bind;
    const local=[0,1,2].map(r=>inv[r]!*v[0]+inv[4+r]!*v[1]+inv[8+r]!*v[2]+inv[12+r]!);
    for(let r=0;r<3;r++)out[r]!+=(b[r]![0]!*local[0]!+b[r]![1]!*local[1]!+b[r]![2]!*local[2]!+b[r]![3]!)*w;
   }
   for(let r=0;r<3;r++)maxError=Math.max(maxError,Math.abs(out[r]!-v[r]!));
  }
  expect(maxError).toBeLessThan(2e-6);
  const hash=createHash('sha256');
  for(const [a,integer] of [[s.vertices,false],[body.joints.flatMap(j=>j.bind),false],[s.inverseBindMatrices,false],[s.faces,true],[s.indices,true],[s.weights,false]] as const){
   const flat=a.flat(),bytes=new Uint8Array(flat.length*4),view=new DataView(bytes.buffer);
   flat.forEach((v,i)=>integer?view.setUint32(i*4,v,true):view.setFloat32(i*4,v,true));hash.update(bytes);
  }
  expect(hash.digest('hex')).toBe(entry.sha256);
  const script=directorCharacterScript('humanoid',entry.id),compiled=executeModelScriptV2(script);
  expect(compiled.ok,compiled.ok?'':JSON.stringify(compiled)).toBe(true);if(!compiled.ok)return;
  const groups=compiled.scene.ops.filter(op=>op.t==='group');
  expect(somaSkeletonIdentity(groups)).toEqual({prefix:'humanoid',bodyPreset:entry.id});
  const world:Transform[]=[];
  for(const j of body.joints){
   const op=groups.find(g=>g.id===`humanoid.${j.name}`)!;
   const local=transformOf(op),t=j.parent<0?local:composeTransform(world[j.parent]!,local);world.push(t);
   t.translation.forEach((v,r)=>expect(v).toBeCloseTo(j.bind[r]![3]!,5));
   for(let axis=0;axis<3;axis++){
    const basis:Vec3=[0,0,0];basis[axis]=1;
    quatRotate(t.rotation,basis).forEach((v,r)=>expect(v).toBeCloseTo(j.bind[r]![axis]!,5));
   }
  }
  const tampered=structuredClone(groups);tampered.find(g=>g.id==='humanoid.LeftShin')!.position![1]+=.001;
  expect(somaSkeletonIdentity(tampered)).toBeNull();
  const first=normalizeModelDefinition({modelScript:script,modelScriptLanguage:'javascript',modelScriptVersion:'woohaa-model-js-v2'});
  const reopened=normalizeModelDefinition(JSON.parse(JSON.stringify({modelScript:script,modelScriptLanguage:'javascript',modelScriptVersion:'woohaa-model-js-v2'})));
  expect(first).toEqual(reopened);
  expect(somaBodyData(entry.id)).toBe(body);
 },30000);
});

it('uses fixed age shapes without adult ratio/build selection',()=>{
 const defaults={sex:'male',heads:8,build:'fat'} as const;
 for(const [age,height] of [['baby',.7],['child',1.15],['teen',1.5]] as const){
  for(const sex of ['male','female'] as const){
   const id=somaBodyPresetId({...defaults,sex,age});
   const entry=resolveSomaBodyPreset(id);
   expect(entry.heads).toBeNull();expect(entry.build).toBeNull();
   expect(entry.measurements.height).toBeCloseTo(height,6);
   expect(somaBodyPresetId({...defaults,sex,age,heads:10,build:'slim'})).toBe(id);
  }
 }
});
it('keeps the legacy capsule and exposes an independently validated two-head capsule',()=>{
 const compiled=executeModelScriptV2(directorCharacterScript('capsule',undefined,'two-heads'));
 expect(compiled.ok).toBe(true);if(!compiled.ok)return;
 const bounds=v2SceneAabb(compiled.scene.ops)!;
 expect(bounds.min[1]).toBeCloseTo(0,6);expect(bounds.max[1]).toBeCloseTo(.88,6);
 const body=compiled.scene.ops.find(op=>op.id==='body')!;
 const head=compiled.scene.ops.find(op=>op.id==='head')!;
 expect(body).toMatchObject({height:.44,radius:.22,position:[0,.22,0]});
 expect(head).toMatchObject({radius:.22,position:[0,.66,0]});
 expect(()=>directorCharacterScript('humanoid',undefined,'two-heads')).toThrow();
 expect(()=>directorCharacterScript('capsule','soma-body-v1/baby','two-heads')).toThrow();
 expect(()=>directorCharacterScript('capsule',undefined,'unknown' as never)).toThrow();
});
