import {describe,it,expect} from 'vitest';
import {executeModelScriptV2} from '../model-executor-v2.js';
import {SOMA77_JOINTS} from './skeleton.js';
import {composeTransform,transformOf,quatRotate} from '../model-transform.js';
describe('SOMA humanoid template',()=>{
 it('creates all 77 official joints and preserves world bind positions',()=>{
  const result=executeModelScriptV2('scene.somaHumanoid({id:"pilot",style:"mecha"});');
  expect(result.ok).toBe(true);if(!result.ok)return;
  const joints=result.scene.ops.filter(op=>op.t==='group' && op.id.startsWith('pilot.'));
  expect(joints).toHaveLength(77);
  const worlds=new Map();
  for(const joint of SOMA77_JOINTS){
   const op=joints.find(o=>o.id===`pilot.${joint.name}`)! as any;
   expect(op.parent).toBe(joint.parent<0?'pilot':`pilot.${SOMA77_JOINTS[joint.parent]!.name}`);
   const t=transformOf(op);const world=joint.parent<0?t:composeTransform(worlds.get(SOMA77_JOINTS[joint.parent]!.name),t);worlds.set(joint.name,world);
   world.translation.forEach((v:number,k:number)=>expect(v).toBeCloseTo(joint.bind[k]![3]!,5));
   for(let axis=0;axis<3;axis++){const basis=[0,0,0] as [number,number,number];basis[axis]=1;quatRotate(world.rotation,basis).forEach((v,k)=>expect(v).toBeCloseTo(joint.bind[k]![axis]!,4));}
  }
  expect(executeModelScriptV2('scene.somaHumanoid({id:"pilot",style:"mecha"});')).toEqual(result);
 });
 it('supports appearance changes and named attachments without changing the skeleton',()=>{
  const result=executeModelScriptV2('const human=scene.somaHumanoid({id:"pilot",style:"mecha",armorColor:"#123456",accentColor:"#ff0000"});scene.box({id:"equipment",parent:human.joint("RightHand"),size:[0.05,0.1,0.2]});');
  expect(result.ok).toBe(true);if(!result.ok)return;
  expect(result.scene.ops.find(o=>o.id==='equipment')).toMatchObject({parent:'pilot.RightHand'});
  expect(result.scene.ops.find(o=>o.id==='pilot.material.armor')).toMatchObject({baseColor:'#123456'});
 });
 it('rejects unknown options, invalid colors and nonexistent joints',()=>{
  for(const source of ['scene.somaHumanoid({jointCount:30});','scene.somaHumanoid({armorColor:"red"});','scene.somaHumanoid().joint("fake");']) expect(executeModelScriptV2(source).ok).toBe(false);
 });
});
