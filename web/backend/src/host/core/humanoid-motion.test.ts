import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {executeWorldAnimationScript,SOMA77_JOINTS} from '@woohaa3/contracts';
import {somaJointPrefix,createHumanoidMotionTools} from './humanoid-motion.js';
function archive(values:Float64Array,frames:number){
 const header=`{'descr': '<f4', 'fortran_order': False, 'shape': (${frames},77,3), }\n`;
 const npy=new Uint8Array(10+header.length+values.length*4),nv=new DataView(npy.buffer);
 npy.set([147,78,85,77,80,89,1,0]);nv.setUint16(8,header.length,true);npy.set(new TextEncoder().encode(header),10);
 values.forEach((value,i)=>nv.setFloat32(10+header.length+i*4,value,true));
 let crc=0xffffffff;for(const byte of npy){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 const name=new TextEncoder().encode('posed_joints.npy'),centralAt=30+name.length+npy.length,endAt=centralAt+46+name.length;
 const zip=new Uint8Array(endAt+22),v=new DataView(zip.buffer);
 v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(14,crc,true);v.setUint32(18,npy.length,true);v.setUint32(22,npy.length,true);v.setUint16(26,name.length,true);zip.set(name,30);zip.set(npy,30+name.length);
 v.setUint32(centralAt,0x02014b50,true);v.setUint16(centralAt+6,20,true);v.setUint32(centralAt+16,crc,true);v.setUint32(centralAt+20,npy.length,true);v.setUint32(centralAt+24,npy.length,true);v.setUint16(centralAt+28,name.length,true);zip.set(name,centralAt+46);
 v.setUint32(endAt,0x06054b50,true);v.setUint16(endAt+8,1,true);v.setUint16(endAt+10,1,true);v.setUint32(endAt+12,46+name.length,true);v.setUint32(endAt+16,centralAt,true);return zip;
}

const groups=():Array<{id:string;parent?:string;position?:number[];rotation?:number[];scale?:number[]}>=>[{id:'robot'},...SOMA77_JOINTS.map(j=>({id:`robot.${j.name}`,parent:j.parent<0?'robot':`robot.${SOMA77_JOINTS[j.parent]!.name}`,position:[...j.position],rotation:[...j.rotation],scale:[1,1,1]}))];
describe('director humanoid motions',()=>{
 it('requires all actual compiled bind frames and hierarchy',()=>{
  expect(somaJointPrefix(groups())).toBe('robot');
  const changed=groups();changed[5]!.position=[1,2,3];expect(somaJointPrefix(changed)).toBeNull();
  expect(somaJointPrefix(groups().slice(0,-1))).toBeNull();
  const stretched=groups();stretched[0]!.scale=[2,1,1];expect(somaJointPrefix(stretched)).toBeNull();
 });
 const setup=(options:{bytes?:Uint8Array}={})=>{
  const view:any={canvasId:'canvas',contextId:'context',worldWritable:true,scope:{scope:{kind:'scene-area',areaId:'director'}},writable:[{kind:'instance',instanceId:'actor',version:'v1'}],sceneModels:[{instanceId:'actor',nodeId:'model',animationRig:{groups:groups()}}],sceneArea:{revision:1,scopeVersion:'scope',animationOrigin:{u:0,v:0},animationQuarterTurns:0,animationScript:{script:'// keep camera',duration:2,loop:true,revision:1}}};
  const submit=vi.fn(async(r:any)=>({state:'queued',reused:false,...r}));
  const status=vi.fn(async()=>submit.mock.calls.length?({canvasId:'canvas',nodeId:submit.mock.calls[0]?.[0].nodeId,modelType:'motion',state:'succeeded',result:{mediaKind:'motion',motion:{skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1',fps:30,frameCount:90}}}):null);
  const write=vi.fn(async(_input:any)=>({ok:true}));
  const catalog=vi.fn(async()=>({available:true,defaultModels:{motion:'kimodo'},models:[{modelType:'motion',modelKey:'kimodo',defaultInput:{steps:20},interaction:{}}]}) as any);
  const readBytes=vi.fn(async()=>options.bytes??new Uint8Array());
  const materialize=vi.fn(async()=>options.bytes?({assetId:'asset',checksum:createHash('sha256').update(options.bytes).digest('hex'),asset:{id:'asset',metadata:{storageKey:'test.npz',size:options.bytes.byteLength,checksum:createHash('sha256').update(options.bytes).digest('hex')}}}):({assetId:'asset',checksum:'a'.repeat(64),asset:{id:'asset'}}));
  const api=createHumanoidMotionTools({readBytes,readAsset:async(_canvasId,assetId)=>({id:assetId,status:'ready',mediaKind:'motion',metadata:{checksum:'a'.repeat(64),storageKey:'test.npz',size:1,contentType:'application/x-npz',motion:{skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1',fps:30,frameCount:90}}} as any),world:{read:()=>({ok:true,view}),write} as any,compose:vi.fn(),task:{submit,status} as any,catalog,materialize:materialize as any});
  return {api,view,submit,status,write,catalog,readBytes};
 };
 const input={canvasId:'canvas',contextId:'context',instanceId:'actor',expectedVersion:'v1',prompt:'wave',duration:3,requestId:'run'};
 it('inspects bounded verified source bytes only on request and never writes or resubmits',async()=>{
  const values=new Float64Array(90*77*3);for(let f=0;f<90;f++)values[(f*77+3)*3+1]=1;
  const bytes=archive(values,90),{api,submit,write,readBytes}=setup({bytes});
  const generated=await api.generate(input),lookup={...input,generationId:String(generated.generationId)};
  expect((await api.get(lookup)).timing).toBeUndefined();expect(readBytes).not.toHaveBeenCalled();
  expect(await api.get({...lookup,inspectTiming:true})).toMatchObject({ok:true,timing:{verification:'kinematic-candidates-only',frameCount:90,signals:{torsoTilt:{onsetTime:null}}}});
  expect(readBytes).toHaveBeenCalledWith({canvasId:'canvas',storageKey:'test.npz',maxBytes:128*1024*1024});
  readBytes.mockResolvedValueOnce(new Uint8Array([0]));
  expect((await api.get({...lookup,inspectTiming:true})).ok).toBe(false);
  expect(submit).toHaveBeenCalledTimes(1);expect(write).not.toHaveBeenCalled();
 });
 it('recovers only this actor current bound asset when old conversations lost generation IDs',async()=>{
  const {api,view,status,write}=setup();
  view.sceneArea.animationScript={script:`motion.soma.clip("actor",{assetId:"legacy",checksum:"${'a'.repeat(64)}",fps:30,frameCount:90,startTime:0,jointPrefix:"robot"});`,duration:3,loop:false,revision:2};
  expect((await api.get({...input,assetId:'legacy'})).ok).toBe(true);
  expect(status).not.toHaveBeenCalled();
  expect((await api.get({...input,assetId:'other'})).ok).toBe(false);
  expect((await api.apply({...input,assetId:'legacy',startTime:.6,sourceStartTime:1.1,replaceExisting:true})).ok).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);
 });
 it('clears an existing explicit transition when reapplied with the default transition',async()=>{
  const {api,view,write}=setup();const generated=await api.generate(input);
  view.sceneArea.animationScript={script:`motion.soma.clip("actor",{assetId:"asset",checksum:"${'a'.repeat(64)}",fps:30,frameCount:90,startTime:0,jointPrefix:"robot",rootMotion:"in-place",blendInDuration:.5});`,duration:3,loop:false,revision:2};
  expect(await api.apply({...input,generationId:String(generated.generationId),startTime:0,replaceExisting:true})).toMatchObject({ok:true,timing:{blendInDuration:0}});
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![0].operation.script).not.toContain('blendInDuration');
 });
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
 it('applies a bounded source in-point without resubmission and rejects unsupported travel trim',async()=>{
  const {api,write,submit}=setup();const generated=await api.generate(input);
  const args={...input,generationId:String(generated.generationId),startTime:.4,sourceStartTime:1.1,blendInDuration:.12,replaceExisting:true};
  expect((await api.apply(args)).ok).toBe(true);
  const op=write.mock.calls[0]![0].operation;
  const compiled=executeWorldAnimationScript(op.script,op);expect(compiled.ok).toBe(true);
  if(compiled.ok)expect(compiled.ir.somaTracks?.[0]).toMatchObject({startTime:.4,sourceStartTime:1.1,blendInDuration:.12,endTime:2.3});
  expect(submit).toHaveBeenCalledTimes(1);
  expect((await api.apply({...args,sourceStartTime:3})).ok).toBe(false);
  expect((await api.apply({...args,rootMotion:'translate'})).ok).toBe(false);
  expect(write).toHaveBeenCalledTimes(1);
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

 it('permits joint-animation fallback only when no model exists before submission',async()=>{
  const {api,catalog,submit,write}=setup();
  catalog.mockResolvedValue({available:true,defaultModels:{},models:[]});
  expect(await api.animate(input)).toMatchObject({ok:false,code:'capability-unsupported',fallback:{allowed:true,mode:'joint-animation',reason:'motion-model-unavailable',taskSubmitted:false}});
  expect(submit).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
 });
 it('does not offer fallback for authorization or stale target errors',async()=>{
  const {api,view,catalog,submit}=setup();view.worldWritable=false;
  const result=await api.animate(input);
  expect(result.ok).toBe(false);expect(result.fallback).toBeUndefined();expect(catalog).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();
 });
 it('does not offer automatic fallback for an already submitted failed task',async()=>{
  const {api,status,submit,write}=setup();
  status.mockImplementation(async()=>submit.mock.calls.length?({canvasId:'canvas',nodeId:submit.mock.calls[0]![0].nodeId,modelType:'motion',state:'failed',error:{message:'worker failed'}} as any):null);
  const result=await api.animate(input);expect(result.ok).toBe(false);expect(result.state).toBe('failed');expect(result.fallback).toBeUndefined();expect(write).not.toHaveBeenCalled();
 });
 it('recovers an existing generation even when the model catalog disappears',async()=>{
  const {api,catalog,submit}=setup();await api.generate(input);catalog.mockClear();catalog.mockResolvedValue({available:false,defaultModels:{},models:[]});
  const result=await api.animate(input);expect(result.ok).toBe(true);expect(catalog).not.toHaveBeenCalled();expect(submit).toHaveBeenCalledTimes(1);
 });

 it('reports catalog unavailability without claiming that a remote worker is absent',async()=>{
  const {api,catalog,submit}=setup();catalog.mockResolvedValue({available:false,reason:'catalog configuration unavailable',defaultModels:{},models:[]});
  expect(await api.animate(input)).toMatchObject({ok:false,catalogReason:'catalog configuration unavailable',fallback:{allowed:true,reason:'motion-catalog-unavailable',taskSubmitted:false}});expect(submit).not.toHaveBeenCalled();
 });
 it('does not authorize whole-request fallback after generating the first composition source',async()=>{
  const {api,catalog,view,status,submit,write}=setup();
  view.bounds={min:{u:-2,v:-2},max:{u:2,v:2}};
  const actor=view.sceneModels[0];actor.transform={version:'shared-world-v1',position:{u:0,v:0,h:0},rotation:[0,0,0,1],scale:1};actor.localBounds={min:[-.2,0,-.2],max:[.2,1.7,.2]};actor.animationRig.spatial={groundAnchorLocal:[0,0,0]};
  catalog.mockResolvedValueOnce({available:true,defaultModels:{motion:'kimodo'},models:[{modelType:'motion',modelKey:'kimodo',defaultInput:{},interaction:{}}]}).mockResolvedValue({available:true,defaultModels:{},models:[]});
  status.mockImplementation(async(...args:any[])=>submit.mock.calls.length&&args[0]===submit.mock.calls[0]![0].workerTaskKey?({canvasId:'canvas',nodeId:submit.mock.calls[0]![0].nodeId,modelType:'motion',state:'succeeded',result:{mediaKind:'motion',motion:{skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1',fps:30,frameCount:300}}} as any):null);
  const result=await api.animate({...input,prompt:'walk and wave',duration:10,locomotion:'scene-lap'});
  expect(result).toMatchObject({ok:false,fallback:{allowed:false,reason:'partial-generation',taskSubmitted:true}});expect(result.generationId).toBeTruthy();expect(submit).toHaveBeenCalledTimes(1);expect(write).not.toHaveBeenCalled();
 });

});
