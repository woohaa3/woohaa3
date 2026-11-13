import {describe,it,expect,vi} from 'vitest';
import {executeWorldAnimationScript,SOMA77_JOINTS} from '@woohaa3/contracts';
import {somaJointPrefix,createHumanoidMotionTools} from './humanoid-motion.js';
const groups=():Array<{id:string;parent?:string;position?:number[];rotation?:number[];scale?:number[]}>=>[{id:'robot'},...SOMA77_JOINTS.map(j=>({id:`robot.${j.name}`,parent:j.parent<0?'robot':`robot.${SOMA77_JOINTS[j.parent]!.name}`,position:[...j.position],rotation:[...j.rotation],scale:[1,1,1]}))];
describe('director humanoid motions',()=>{
 it('requires all actual compiled bind frames and hierarchy',()=>{
  expect(somaJointPrefix(groups())).toBe('robot');
  const changed=groups();changed[5]!.position=[1,2,3];expect(somaJointPrefix(changed)).toBeNull();
  expect(somaJointPrefix(groups().slice(0,-1))).toBeNull();
  const stretched=groups();stretched[0]!.scale=[2,1,1];expect(somaJointPrefix(stretched)).toBeNull();
 });
 const setup=()=>{
  const view:any={canvasId:'canvas',contextId:'context',worldWritable:true,scope:{scope:{kind:'scene-area',areaId:'director'}},writable:[{kind:'instance',instanceId:'actor',version:'v1'}],sceneModels:[{instanceId:'actor',nodeId:'model',animationRig:{groups:groups()}}],sceneArea:{revision:1,scopeVersion:'scope',animationOrigin:{u:0,v:0},animationQuarterTurns:0,animationScript:{script:'// keep camera',duration:2,loop:true,revision:1}}};
  const submit=vi.fn(async(r:any)=>({state:'queued',reused:false,...r}));
  const status=vi.fn(async()=>submit.mock.calls.length?({canvasId:'canvas',nodeId:submit.mock.calls[0]?.[0].nodeId,modelType:'motion',state:'succeeded',result:{mediaKind:'motion',motion:{skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1',fps:30,frameCount:90}}}):null);
  const write=vi.fn(async(_input:any)=>({ok:true}));
  const api=createHumanoidMotionTools({world:{read:()=>({ok:true,view}),write} as any,task:{submit,status} as any,catalog:async()=>({available:true,defaultModels:{motion:'kimodo'},models:[{modelType:'motion',modelKey:'kimodo',defaultInput:{steps:20},interaction:{}}]}) as any,materialize:async()=>({assetId:'asset',checksum:'a'.repeat(64),asset:{id:'asset'}} as any)});
  return {api,view,submit,status,write};
 };
 const input={canvasId:'canvas',contextId:'context',instanceId:'actor',expectedVersion:'v1',prompt:'wave',duration:3,requestId:'run'};
 it('durably submits deterministic keys without creating motion nodes',async()=>{
  const {api,submit}=setup();const a=await api.generate(input),b=await api.generate(input);
  expect(a.generationId).toBe(b.generationId);expect(b.reused).toBe(true);expect(submit).toHaveBeenCalledTimes(1);expect(submit.mock.calls[0]![0].nodeId).not.toBe('model');expect(submit.mock.calls[0]![0]).toMatchObject({nodeType:'motion',parameters:{steps:20,duration:3}});
 });
 it('rejects stale version before submission and cross-target lookup before status',async()=>{
  const {api,submit,status}=setup();expect((await api.generate({...input,expectedVersion:'stale'})).ok).toBe(false);expect(submit).not.toHaveBeenCalled();
  expect((await api.get({...input,generationId:'unrelated'})).ok).toBe(false);expect(status).not.toHaveBeenCalled();
 });
 it('rejects another canvas generation after a valid current-scope read',async()=>{
  const {api,view,status}=setup();const generated=await api.generate(input);view.canvasId='other';const calls=status.mock.calls.length;
  expect((await api.get({...input,canvasId:'other',generationId:generated.generationId as string})).ok).toBe(false);expect(status).toHaveBeenCalledTimes(calls);
 });
 it('preserves existing director source and commits stable asset with clip',async()=>{
  const {api,write}=setup();const generated=await api.generate(input);
  const result=await api.apply({...input,generationId:generated.generationId as string,startTime:2});expect(result.ok).toBe(true);
  const op=write.mock.calls[0]?.[0] as any;expect(op.operation.script).toContain('// keep camera\nmotion.soma.clip("actor",');expect(op.operation.script).not.toContain('https:');expect(op.operation.duration).toBe(5);expect(op.operation.motionAsset.id).toBe('asset');
 });
 it('orchestrates generation and apply without requiring AI rig or polling calls',async()=>{
  const {api,write,submit}=setup();
  const result=await api.animate({canvasId:'canvas',contextId:'context',instanceId:'actor',prompt:'wave',duration:3,requestId:'run'});
  expect(result.ok).toBe(true);expect(submit).toHaveBeenCalledTimes(1);expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]?.[0].operation.script).toContain('"rootMotion":"in-place"');
 });
 it('does not apply if the model changes while generation is running',async()=>{
  const {api,view,write,status}=setup();
  status.mockImplementationOnce(async()=>null).mockImplementationOnce(async()=>{view.writable[0].version='v2';return {canvasId:'canvas',nodeId:'wrong',state:'succeeded'} as any;});
  expect((await api.animate({canvasId:'canvas',contextId:'context',instanceId:'actor',prompt:'wave',duration:3,requestId:'run'})).ok).toBe(false);
  expect(write).not.toHaveBeenCalled();
 });

 it('atomically replaces only this actor while preserving other actors and camera tracks',async()=>{
  const {api,view,write}=setup();
  const clip=(id:string)=>`motion.soma.clip("${id}",{assetId:"old",checksum:"${'b'.repeat(64)}",fps:30,frameCount:60,startTime:0,jointPrefix:"robot"});`;
  view.sceneArea.animationScript={script:clip('actor')+'\n'+clip('other')+'\nmotion.camera.tween({cameraId:"cam",property:"position",startTime:0,endTime:2,from:[0,0,0],to:[1,1,1]});',duration:2,loop:false,revision:1};
  const result=await api.animate(input);if(!result.ok)throw Error(JSON.stringify(result));
  const op=write.mock.calls[0]?.[0].operation;
  const compiled=executeWorldAnimationScript(op.script,op);expect(compiled.ok).toBe(true);
  if(!compiled.ok)throw Error(compiled.message);
  expect(compiled.ir.somaTracks?.filter(t=>t.targetId==='actor')).toHaveLength(1);
  expect(compiled.ir.somaTracks?.find(t=>t.targetId==='other')?.assetId).toBe('old');
  expect(compiled.ir.cameraTracks).toHaveLength(1);expect(write).toHaveBeenCalledTimes(1);
 });
 it('refuses to apply an asset too short for the planned scene lap',async()=>{
  const {api,view,write,submit}=setup();
  view.bounds={min:{u:-2,v:-2},max:{u:2,v:2}};
  const actor=view.sceneModels[0];actor.transform={version:'shared-world-v1',position:{u:0,v:0,h:0},rotation:[0,0,0,1],scale:1};actor.localBounds={min:[-.2,0,-.2],max:[.2,1.7,.2]};actor.animationRig.spatial={groundAnchorLocal:[0,0,0]};
  const result=await api.animate({...input,prompt:'walk forward',duration:10,locomotion:'scene-lap'});
  // This mock asset lasts three seconds, too short for its route; no scene write.
  expect(result.ok).toBe(false);expect(write).not.toHaveBeenCalled();
  expect(submit.mock.calls[0]?.[0].prompt).toContain('No turns and no circling');
 });

 it('applies a host-owned closed route and reports explicit route verification',async()=>{
  const {api,view,write,submit,status}=setup();
  view.bounds={min:{u:-2,v:-2},max:{u:2,v:2}};view.sceneArea.revision=4;view.sceneArea.animationOrigin={u:0,v:0};view.sceneArea.animationQuarterTurns=0;
  const actor=view.sceneModels[0];actor.transform={version:'shared-world-v1',position:{u:0,v:0,h:0},rotation:[0,0,0,1],scale:1};actor.localBounds={min:[-.2,0,-.2],max:[.2,1.7,.2]};actor.animationRig.spatial={groundAnchorLocal:[0,0,0]};
  status.mockImplementation(async()=>submit.mock.calls.length?({canvasId:'canvas',nodeId:submit.mock.calls[0]![0].nodeId,modelType:'motion',state:'succeeded',result:{mediaKind:'motion',motion:{skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1',fps:30,frameCount:300}}}):null);
  const result=await api.animate({...input,prompt:'walk forward',duration:10,locomotion:'scene-lap'});expect(result).toMatchObject({ok:true,routeVerification:{closedLoop:true,fullLap:true}});
  const op=write.mock.calls[0]?.[0].operation;expect(op.motionTarget.canvasRevision).toBe(4);expect(op.loop).toBe(false);
  const compiled=executeWorldAnimationScript(op.script,op);expect(compiled.ok).toBe(true);if(compiled.ok)expect(compiled.ir.somaTracks?.[0]?.route?.kind).toBe('scene-lap');
 });

});
