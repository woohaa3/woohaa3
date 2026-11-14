import { describe, expect, it } from 'vitest';
import { SOMA77_JOINTS } from '../soma-humanoid/skeleton.js';
import { SOMA_SKIN } from '../soma-humanoid/skin-data.js';
import { SOMA_BODY_PRESETS, somaBodyData } from '../soma-humanoid/body-presets.js';
import { composeTransform, quatFromEulerYXZDegrees, quatMul, quatRotate, transformOf, transformPoint, type Transform, type Vec3, type Quat } from '../model-transform.js';
import { matrixQuaternion, sampleSomaClipTrack, validateSomaClip } from './clip.js';
import { somaBodyRootScale, SOMA_BODY_ADAPTATION_VERSION } from './body-adaptation.js';
import type { PreparedSomaMotion } from './index.js';

function source(): PreparedSomaMotion {
 const localRotations=new Float64Array(3*77*9);
 for(let frame=0;frame<3;frame++)for(let i=0;i<77;i++){
  const j=SOMA77_JOINTS[i]!,b=j.bind;
  const local=Array.from({length:9},(_,n)=>{
   const r=Math.floor(n/3),c=n%3;
   return j.parent<0?b[r]![c]!:b.slice(0,3).reduce((s,row,k)=>s+SOMA77_JOINTS[j.parent]!.bind[k]![r]!*row[c]!,0);
  });
  let q=matrixQuaternion(local);
  if(frame>0 && j.name==='LeftArm')q=quatMul(q,quatFromEulerYXZDegrees([0,0,frame===1?35:70]));
  if(frame>0 && /^Left(Leg|Shin)$/.test(j.name))q=quatMul(q,quatFromEulerYXZDegrees([j.name.startsWith('Left')?20:-20,0,0]));
  for(let axis=0;axis<3;axis++){
   const v:Vec3=[0,0,0];v[axis]=1;
   quatRotate(q,v).forEach((x,row)=>localRotations[(frame*77+i)*9+row*3+axis]=x);
  }
 }
 const y=SOMA77_JOINTS[0]!.bind[1]![3]!;
 return {fps:30,frameCount:3,durationSeconds:.1,jointNames:SOMA77_JOINTS.map(j=>j.name),parents:Int32Array.from(SOMA77_JOINTS.map(j=>j.parent)),order:SOMA77_JOINTS.map((_,i)=>i),
  bindTransforms:Float64Array.from(SOMA77_JOINTS.flatMap(j=>j.bind.flat())),bindVertices:Float32Array.from(SOMA_SKIN.vertices.flat()),faces:Uint32Array.from(SOMA_SKIN.faces.flat()),
  indices:Uint32Array.from(SOMA_SKIN.indices.flat()),weights:Float32Array.from(SOMA_SKIN.weights.flat()),localRotations,rootPositions:Float64Array.from([0,y,0,.1,y,.2,.2,y+.3,.4]),
  globalRotations:new Float32Array(),posedJoints:new Float32Array(),restOffsets:new Float64Array()};
}
function sole(id: typeof SOMA_BODY_PRESETS[number]['id'],pose:ReturnType<typeof sampleSomaClipTrack>) {
 const b=somaBodyData(id),worlds:Transform[]=[];
 for(const j of b.joints){
  const local=transformOf({position:j.position as Vec3,rotation:j.rotation as Vec3,scale:[1,1,1]});
  local.rotation=quatMul(local.rotation,pose.partRotations[`actor.${j.name}`] as Quat);
  const delta=pose.partPositions[`actor.${j.name}`]??[0,0,0];local.translation=local.translation.map((v,i)=>v+delta[i]!) as Vec3;
  worlds.push(j.parent<0?local:composeTransform(worlds[j.parent],local));
 }
 let min=Infinity;
 for(let i=0;i<b.skin.vertices.length;i++){
  const v=b.skin.vertices[i]!,out=[0,0,0];
  for(let k=0;k<b.skin.indices[i]!.length;k++){
   const joint=b.skin.indices[i]![k]!,weight=b.skin.weights[i]![k]!,m=b.skin.inverseBindMatrices[joint]!;
   if(!weight)continue;
   const local=[0,1,2].map(r=>m[r]!*v[0]+m[4+r]!*v[1]+m[8+r]!*v[2]+m[12+r]!) as Vec3;
   const posed=transformPoint(worlds[joint]!,local);
   for(let r=0;r<3;r++)out[r]!+=posed[r]!*weight;
  }
  min=Math.min(min,out[1]!);
 }
 return min;
}

describe('target-specific exact-time motion adaptation',()=>{
 const p=source();
 for(const body of SOMA_BODY_PRESETS)it(body.id,()=>{
  const track=validateSomaClip({targetId:'instance',assetId:'source',checksum:'a'.repeat(64),fps:30,frameCount:3,startTime:0,endTime:.1,jointPrefix:'actor',targetBodyPreset:body.id,adaptationVersion:SOMA_BODY_ADAPTATION_VERSION,rootMotion:'translate'},.1);
  const initial=sampleSomaClipTrack(p,track,0);
  expect(sole(body.id,initial)).toBeCloseTo(0,5);
  const moving=sampleSomaClipTrack(p,track,1/30);
  expect(Math.abs(sole(body.id,moving))).toBeLessThan(.001);
  expect(moving.rootTranslation?.[0]).toBeCloseTo(.1*somaBodyRootScale(body.id),8);
  expect(moving.rootTranslation?.[2]).toBeCloseTo(.2*somaBodyRootScale(body.id),8);
  expect(moving.partRotations['actor.LeftArm']).not.toEqual(initial.partRotations['actor.LeftArm']);
  expect(moving.partRotations['actor.RightArm']).toEqual(initial.partRotations['actor.RightArm']);
  const jump=sampleSomaClipTrack(p,track,2/30);
  expect(sole(body.id,jump)).toBeGreaterThan(.2*somaBodyRootScale(body.id));
  sampleSomaClipTrack(p,track,100);
  expect(sampleSomaClipTrack(p,track,0)).toEqual(initial);
  expect(sampleSomaClipTrack(p,{...track,rootMotion:'in-place'},1/30).rootTranslation).toBeUndefined();
 },30000);
 it('separates target identity, validates the source, and preserves independent outputs',()=>{
  const track=validateSomaClip({targetId:'instance',assetId:'source',checksum:'a'.repeat(64),fps:30,frameCount:3,startTime:0,jointPrefix:'actor',targetBodyPreset:SOMA_BODY_PRESETS[0]!.id,adaptationVersion:SOMA_BODY_ADAPTATION_VERSION},.1);
  const first=sampleSomaClipTrack(p,track,1/60),before=structuredClone(first);
  const other=sampleSomaClipTrack(p,{...track,targetBodyPreset:SOMA_BODY_PRESETS[15]!.id},1/60);
  expect(other.partPositions).not.toEqual(first.partPositions);expect(first).toEqual(before);
  const corrupt=source();corrupt.bindTransforms[7]+=.1;
  expect(()=>sampleSomaClipTrack(corrupt,track,0)).toThrow('source bind');
  expect(()=>validateSomaClip({...track,adaptationVersion:'unknown'},.1)).toThrow();
  expect(()=>validateSomaClip({...track,targetBodyPreset:undefined},.1)).toThrow();
 });
});
