import {describe,it,expect} from 'vitest';
import {executeModelScriptV2} from '../model-executor-v2.js';
import {SOMA77_JOINTS} from './skeleton.js';
import {SOMA_SKIN} from './skin-data.js';
describe('official SOMA skin',()=>{
 it('builds the white human as a skinned official mesh on all77 joints',()=>{
  const result=executeModelScriptV2('scene.somaHumanoid({id:"human",style:"humanoid"});');
  expect(result.ok).toBe(true);if(!result.ok)return;
  const mesh=result.scene.ops.find(op=>op.t==='mesh');expect(mesh?.t).toBe('mesh');
  if(mesh?.t==='mesh'){expect(mesh.skin?.jointIds).toHaveLength(77);expect(mesh.vertices).toHaveLength(18056);expect(mesh.skin?.weights[0]).toHaveLength(8);}
 });
 it('all8 influences reconstruct every bind vertex and remain finite',()=>{
  let error=0;
  for(let i=0;i<SOMA_SKIN.vertices.length;i++){
   const v=SOMA_SKIN.vertices[i]!,out=[0,0,0];
   for(let k=0;k<8;k++){
    const joint=SOMA_SKIN.indices[i]![k]!,m=SOMA_SKIN.inverseBindMatrices[joint]!,b=SOMA77_JOINTS[joint]!.bind;
    const local=[0,1,2].map(r=>m[r]!*v[0]+m[4+r]!*v[1]+m[8+r]!*v[2]+m[12+r]!);
    for(let r=0;r<3;r++)out[r]!+=(b[r]![0]!*local[0]!+b[r]![1]!*local[1]!+b[r]![2]!*local[2]!+b[r]![3]!)*SOMA_SKIN.weights[i]![k]!;
   }
   for(let r=0;r<3;r++)error=Math.max(error,Math.abs(out[r]!-v[r]!));
  }
  expect(Number.isFinite(error)).toBe(true);expect(error).toBeLessThan(.00001);
 });
 it('retains the official full topology and every normalized influence',()=>{
  expect(SOMA_SKIN.vertices).toHaveLength(18056);expect(SOMA_SKIN.faces).toHaveLength(36108);
  expect(SOMA_SKIN.inverseBindMatrices).toHaveLength(77);
  for(let i=0;i<SOMA_SKIN.vertices.length;i++){
   expect(SOMA_SKIN.indices[i]).toHaveLength(8);expect(SOMA_SKIN.weights[i]).toHaveLength(8);
   expect(SOMA_SKIN.weights[i]!.reduce((a,b)=>a+b,0)).toBeCloseTo(1,5);
  }
 });
});
