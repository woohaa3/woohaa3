import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { prepareSomaMotion } from './index.js';
import { sampleSomaClip, projectSomaRootTranslation } from './clip.js';
import { executeWorldAnimationScript, sampleWorldAnimation, serializeWorldAnimationScript } from '../world-animation-script.js';
const bytes=(name:string)=>new Uint8Array(readFileSync(new URL(`./fixtures/${name}.npz`,import.meta.url)));
it('samples actual NPZ deterministically with in-place root translation',async()=>{
 const p=await prepareSomaMotion(bytes('skin'),bytes('motion'));
 const first=sampleSomaClip(p,'actor',0);
 expect(first.partPositions['actor.Hips']).toEqual([0,0,0]);
 expect(sampleSomaClip(p,'actor',1/30).partPositions['actor.Hips']).toEqual([0,0,0]);
 sampleSomaClip(p,'actor',100);
 expect(sampleSomaClip(p,'actor',0)).toEqual(first);
 expect(sampleSomaClip(p,'actor',-100)).toEqual(first);
});
it('removes rotated parent and bind local rotations and interpolates height',async()=>{
 const p=await prepareSomaMotion(bytes('skin'),bytes('motion'));
 // A global 90-degree root bind and an identity child bind imply a -90 child local bind.
 p.bindTransforms.set([0,-1,0,0,1,0,0,1,0,0,1,0,0,0,0,1],0);
 p.localRotations.set([0,-1,0,1,0,0,0,0,1],0);
 p.localRotations.set([0,1,0,-1,0,0,0,0,1],9);
 p.localRotations.set([0,-1,0,1,0,0,0,0,1],18);
 p.localRotations.set([0,1,0,-1,0,0,0,0,1],27);
 p.rootPositions.set([5,1,8,9,3,20]);
 const pose=sampleSomaClip(p,'actor',1/60);
 expect(pose.partPositions['actor.Hips']).toEqual([0,1,0]);
 for(const q of Object.values(pose.partRotations))expect(Math.abs(q[3])).toBeCloseTo(1);
 // A half-turn pose interpolates at 45 degrees from the first root pose.
 p.localRotations.set([-1,0,0,0,-1,0,0,0,1],18);
 const q=sampleSomaClip(p,'actor',1/60).partRotations['actor.Hips']!;
 expect(Math.abs(q[2])).toBeCloseTo(Math.sin(Math.PI/8));
 expect(Math.abs(q[3])).toBeCloseTo(Math.cos(Math.PI/8));
});
const options={assetId:'motion-1',checksum:'a'.repeat(64),fps:30,frameCount:2,startTime:0,jointPrefix:'actor'};
const line=`motion.soma.clip('instance',${JSON.stringify(options)});`;
it('compiles compact clips, round trips and resolves prepared motion',async()=>{
 const result=executeWorldAnimationScript(line,{duration:1,loop:false});
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.ir.somaTracks?.[0]?.endTime).toBe(2/30);
 const repeated=executeWorldAnimationScript(serializeWorldAnimationScript(result.ir),{duration:1,loop:false});
 expect(repeated).toEqual(result);
 const p=await prepareSomaMotion(bytes('skin'),bytes('motion'));
 expect(sampleWorldAnimation(result.ir,0,{resolveSomaMotion:()=>p}).instances.get('instance')?.partRotations).toBeDefined();
 expect(sampleWorldAnimation(result.ir,0).instances.size).toBe(0);
});
it('rejects duplicate clips, competing joint owners, oversized and nonfinite metadata',()=>{
 for(const source of [line+line,line+`motion.instance.walk('instance',{});`,line+`motion.part.tween('instance','actor.Hips',{property:'rotation',startTime:0,endTime:1,from:[0,0,0],to:[0,1,0]});`, `motion.soma.clip('instance',{...${JSON.stringify(options)},fps:Infinity});`, `motion.soma.clip('instance',{...${JSON.stringify(options)},frameCount:18001});`])expect(executeWorldAnimationScript(source,{duration:1,loop:false}).ok).toBe(false);
 expect(executeWorldAnimationScript(line+`motion.instance.tween('instance',{property:'position',startTime:0,endTime:1,from:[0,0,0],to:[1,1,0]});`,{duration:1,loop:false}).ok).toBe(true);
});

import { removeWorldAnimationInstanceTracks } from '../world-animation-script.js';
import { analyzeWorldAnimationData } from '../world-animation-verification.js';
it('strips selected SOMA targets without changing other targets or cameras',()=>{
 const result=executeWorldAnimationScript(line+line.replace("'instance'","'other'"),{duration:1,loop:false});
 expect(result.ok).toBe(true);if(!result.ok)return;
 const stripped=removeWorldAnimationInstanceTracks(result.ir,new Set(['instance']));
 expect(stripped.somaTracks?.map(t=>t.targetId)).toEqual(['other']);
 expect(result.ir.somaTracks).toHaveLength(2);
 expect(stripped.cameraTracks).toBe(result.ir.cameraTracks);
 const diagnostic=analyzeWorldAnimationData(result.ir,[],{u:0,v:0});
 expect(diagnostic.status).toBe('partial');
 expect(diagnostic.unavailableTargets).toEqual(['instance','other']);
});

it('projects translated root relative to frame zero through world yaw and scale without changing Hips',async()=>{
 const p=await prepareSomaMotion(bytes('skin'),bytes('motion'));
 p.rootPositions.set([5,1,8,9,3,20]);
 const first=sampleSomaClip(p,'actor',0,'translate');
 const mid=sampleSomaClip(p,'actor',1/60,'translate');
 expect(first.rootTranslation).toEqual([0,0,0]);
 expect(mid.rootTranslation).toEqual([2,0,6]);
 expect(mid.partPositions['actor.Hips']).toEqual(sampleSomaClip(p,'actor',1/60).partPositions['actor.Hips']);
 const end=sampleSomaClip(p,'actor',100,'translate');
 expect(end.rootTranslation).toEqual([4,0,12]);
 const base={u:10,v:20,h:3};
 const result=projectSomaRootTranslation(end.rootTranslation!,[0,0,Math.SQRT1_2,Math.SQRT1_2],2,base);
 expect(result.u).toBeCloseTo(34);expect(result.v).toBeCloseTo(28);expect(result.h).toBeCloseTo(3);
 expect(base).toEqual({u:10,v:20,h:3});
 expect(sampleSomaClip(p,'actor',0,'translate')).toEqual(first);
 expect(sampleSomaClip(p,'actor',100).rootTranslation).toBeUndefined();
});
it('holds translated root before start and after end, permits seeking, and rejects position ownership and looping',async()=>{
 const moving=`motion.soma.clip('instance',${JSON.stringify({...options,startTime:0.5,rootMotion:'translate'})});`;
 const result=executeWorldAnimationScript(moving,{duration:1,loop:false});expect(result.ok).toBe(true);if(!result.ok)return;
 const p=await prepareSomaMotion(bytes('skin'),bytes('motion'));p.rootPositions.set([5,1,8,9,3,20]);
 const sample=(time:number)=>sampleWorldAnimation(result.ir,time,{resolveSomaMotion:()=>p}).instances.get('instance')!;
 expect(sample(0).rootTranslation).toEqual([0,0,0]);expect(sample(1).rootTranslation).toEqual([4,0,12]);expect(sample(0.5).rootTranslation).toEqual([0,0,0]);expect(sample(1).rootTranslation).toEqual([4,0,12]);
 expect(executeWorldAnimationScript(moving,{duration:1,loop:true}).ok).toBe(false);
 expect(executeWorldAnimationScript(moving+`motion.instance.tween('instance',{property:'position',startTime:0,endTime:1,from:[0,0,0],to:[1,1,0]});`,{duration:1,loop:false}).ok).toBe(false);
 expect(executeWorldAnimationScript(moving.replace('translate','unknown'),{duration:1,loop:false}).ok).toBe(false);
});

import { validateSomaSceneLapRoute, sampleSomaSceneLapRoute, describeSomaSceneLapRoute, type SomaSceneLapRoute } from './scene-lap.js';
import { sampleWorldAnimationInArea } from '../world-animation-script.js';
const sceneRoute:SomaSceneLapRoute={kind:'scene-lap',path:[{u:0,v:0},{u:2,v:0},{u:2,v:2},{u:0,v:2}],startAnchor:{u:-1,v:-1},cornerRadius:.3,groundAnchorLocal:[.2,-1,.1],baseRotation:[0,0,0,1],scale:2,rootHeight:2};
it('scene lap includes full closed loop and connectors, holds world anchor, and seeks deterministically',()=>{
 const route=validateSomaSceneLapRoute(sceneRoute,10),facts=describeSomaSceneLapRoute(route,10);
 expect(facts.length).toBeCloseTo(facts.lapLength+facts.connectorLength);
 const a=sampleSomaSceneLapRoute(route,0),b=sampleSomaSceneLapRoute(route,1);
 // Rotation changes with outgoing/return connector, but transformed stable ground anchor returns exactly.
 for(const pose of [a,b]){
  const anchor=projectSomaRootTranslation(route.groundAnchorLocal,pose.rotation,route.scale,pose.position);
  expect(anchor.u).toBeCloseTo(-1);expect(anchor.v).toBeCloseTo(-1);expect(anchor.h).toBeCloseTo(0);
 }
 expect(sampleSomaSceneLapRoute(route,2)).toEqual(b);
 expect(sampleSomaSceneLapRoute(route,-1)).toEqual(a);
 const mid=sampleSomaSceneLapRoute(route,.4);sampleSomaSceneLapRoute(route,.8);expect(sampleSomaSceneLapRoute(route,.4)).toEqual(mid);
 for(const invalid of [{...route,scale:0},{...route,baseRotation:[1,0,0,0]},{...route,path:[...route.path,{u:0,v:0}]},{...route,phaseDistance:Infinity}])expect(()=>validateSomaSceneLapRoute(invalid,10)).toThrow();
 expect(()=>validateSomaSceneLapRoute(route,.1)).toThrow();
});
it('scene lap clips own world transforms and remove NPZ root yaw without dropping articulation',async()=>{
 const p=await prepareSomaMotion(bytes('skin'),bytes('motion'));
 p.localRotations.set([0,0,1,0,1,0,-1,0,0],0);
 const normalized=sampleSomaClip(p,'actor',0,'in-place',true);
 expect(normalized.partRotations['actor.Hips']![3]).toBeCloseTo(1);
 expect(Object.keys(normalized.partRotations)).toHaveLength(p.jointNames.length);
 const source=`motion.soma.clip('instance',${JSON.stringify({...options,frameCount:300,endTime:10,rootMotion:'in-place',route:{...sceneRoute,referenceFrame:{origin:{u:100,v:200},quarterTurns:1}}})});`;
 const result=executeWorldAnimationScript(source,{duration:12,loop:false});expect(result.ok).toBe(true);if(!result.ok)return;
 const prepared={...p,frameCount:300,localRotations:Float64Array.from({length:300*p.jointNames.length*9},(_,i)=>p.localRotations[i%p.localRotations.length]!),rootPositions:new Float64Array(900)};
 const context={resolveSomaMotion:()=>prepared};
 const a=sampleWorldAnimation(result.ir,0,context).instances.get('instance');
 const shifted=sampleWorldAnimationInArea(result.ir,0,{u:100,v:200},1,context).instances.get('instance');
 expect(shifted).toEqual(a);expect(a?.absoluteTransform).toBe(true);
 expect(sampleWorldAnimation(result.ir,12,context)).toEqual(sampleWorldAnimation(result.ir,10,context));
 expect(executeWorldAnimationScript(source,{duration:12,loop:true}).ok).toBe(false);
 expect(executeWorldAnimationScript(source+`motion.instance.tween('instance',{property:'rotation',startTime:0,endTime:1,from:[0,0,0],to:[0,1,0]});`,{duration:12,loop:false}).ok).toBe(false);
});
it('scene lap tangent controls heading independently of base yaw and selected lap phase',()=>{
 const route={...sceneRoute,startAnchor:{u:.3,v:0},phaseDistance:0,groundAnchorLocal:[0,-1,0] as [number,number,number],baseRotation:[0,0,1,0] as const};
 const sampled=sampleSomaSceneLapRoute(route,.01);
 // First rounded rectangle edge travels +u: model +Z forward must face +u.
 const forward=projectSomaRootTranslation([0,0,1],sampled.rotation,1,{u:0,v:0,h:0});
 expect(forward.u).toBeCloseTo(1);expect(forward.v).toBeCloseTo(0);
 const next=sampleSomaSceneLapRoute({...route,phaseDistance:2},0);
 expect(next.position.u).toBeCloseTo(route.startAnchor.u);expect(next.position.v).toBeCloseTo(route.startAnchor.v);
});

import { transformSomaSceneLapPoint } from './scene-lap.js';
import { rotateGroundQuarterTurns, rotateWorldQuarterTurn } from '../world-quarter-turn.js';
it('rebases stored world routes for director movement, rotation, and cloned targets without changing IR',async()=>{
 const p=await prepareSomaMotion(bytes('skin'),bytes('motion'));
 const prepared={...p,frameCount:300,localRotations:Float64Array.from({length:300*p.jointNames.length*9},(_,i)=>p.localRotations[i%p.localRotations.length]!),rootPositions:new Float64Array(900)};
 const route={...sceneRoute,referenceFrame:{origin:{u:5,v:7},quarterTurns:1}};
 const source=`motion.soma.clip('clone',${JSON.stringify({...options,frameCount:300,endTime:10,rootMotion:'in-place',route})});`;
 const result=executeWorldAnimationScript(source,{duration:12,loop:false});expect(result.ok).toBe(true);if(!result.ok)return;
 const original=JSON.stringify(result.ir),context={resolveSomaMotion:()=>prepared};
 for(const time of [0,2,8,10,12,2]){
  const raw=sampleWorldAnimation(result.ir,time,context).instances.get('clone')!;
  const same=sampleWorldAnimationInArea(result.ir,time,{u:5,v:7},1,context).instances.get('clone')!;
  expect(same.position!.u).toBeCloseTo(raw.position!.u);expect(same.position!.v).toBeCloseTo(raw.position!.v);expect(same.rotation).toEqual(raw.rotation);
  const moved=sampleWorldAnimationInArea(result.ir,time,{u:15,v:27},2,context).instances.get('clone')!;
  const turn=rotateGroundQuarterTurns(raw.position!,{u:5,v:7},1);
  expect(moved.position!.u).toBeCloseTo(turn.u+10);expect(moved.position!.v).toBeCloseTo(turn.v+20);
  expect(moved.position!.h).toBe(raw.position!.h);expect(moved.rotation).toEqual(rotateWorldQuarterTurn(raw.rotation!));
  expect(moved.partRotations).toEqual(raw.partRotations);
 }
 expect(JSON.stringify(result.ir)).toBe(original);
 expect(transformSomaSceneLapPoint({u:1,v:2},sceneRoute,{u:10,v:20},1)).toEqual({u:12,v:19});
 expect(()=>validateSomaSceneLapRoute({...route,referenceFrame:{origin:{u:0,v:0},quarterTurns:.5}},10)).toThrow();
});
it('smooth connector tangents join both ends of the complete lap without hard turns',()=>{
 const route={...sceneRoute,connectorMode:'smooth' as const,groundAnchorLocal:[0,-1,0] as [number,number,number]};
 const facts=describeSomaSceneLapRoute(route,10);
 for(const distance of [facts.entryLength,facts.entryLength+facts.lapLength]){
  const a=sampleSomaSceneLapRoute(route,(distance-1e-6)/facts.length),b=sampleSomaSceneLapRoute(route,(distance+1e-6)/facts.length);
  const dot=Math.abs(a.rotation.reduce((sum,x,k)=>sum+x*b.rotation[k]!,0));
  expect(2*Math.acos(Math.min(1,dot))).toBeLessThan(1e-3);
  expect(Math.hypot(a.position.u-b.position.u,a.position.v-b.position.v)).toBeLessThan(3e-6);
 }
 const legacy=describeSomaSceneLapRoute({...route,connectorMode:undefined},10);
 expect(facts.length).toBeGreaterThan(legacy.length);
 expect(()=>validateSomaSceneLapRoute(route,10)).not.toThrow();
 expect(()=>validateSomaSceneLapRoute({...route,connectorMode:'bad'},10)).toThrow();
 const first=sampleSomaSceneLapRoute(route,0),last=sampleSomaSceneLapRoute(route,1);
 expect(first.position).toEqual(last.position);
 // Sample headings densely around the entire route: cubic/lap joins remain continuous.
 let max=0;
 for(let i=1;i<10000;i++){
  const a=sampleSomaSceneLapRoute(route,(i-1)/10000).rotation,b=sampleSomaSceneLapRoute(route,i/10000).rotation;
  const dot=Math.min(1,Math.abs(a.reduce((sum,x,k)=>sum+x*b[k]!,0)));
  max=Math.max(max,2*Math.acos(dot));
 }
 expect(max).toBeLessThan(.1);
 expect(facts.entryLength).toBeGreaterThan(0);
});
