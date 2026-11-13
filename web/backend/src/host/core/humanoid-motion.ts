import {validateRaisedWavePrerequisite} from '../../ports/humanoid-motion-gesture.js';
import {createHumanoidSceneLap} from '../../ports/humanoid-scene-lap.js';
import { validateHumanoidMotionPath, type HumanoidMotionPathInput } from '../../ports/humanoid-motion-path.js';
import { createHash } from 'node:crypto';
import { isSomaMotionMetadata, decodeSomaPosedJoints, inspectSomaMotionTiming, executeWorldAnimationScript, removeWorldAnimationInstanceTracks, serializeWorldAnimationScript, somaSkeletonPrefix, type AssistantWorldContextView, type AssistantWorldFailure, type AssistantWorldWriteInput, type AssistantWorldWriteOutcome, type BackendTaskPort, type CanvasTaskCatalog, type TaskResultSummary, type StoredAsset } from '@woohaa3/contracts';

type Binding = { canvasId:string; contextId:string; instanceId:string };
type Generate = Binding & { expectedVersion:string; prompt:string; duration:number; requestId:string; steps?:number };
type Lookup = Binding & { generationId?:string; assetId?:string; inspectTiming?:boolean };
type Apply = Lookup & { upperBodyGenerationId?:string; expectedVersion:string; startTime:number; sourceStartTime?:number; blendInDuration?:number; loop?:boolean; rootMotion?:'in-place'|'translate';locomotion?:'scene-lap';replaceExisting?:boolean;requiresRaisedWave?:boolean };
type Animate = Binding & {prompt:string;duration:number;requestId:string;startTime?:number;rootMotion?:'in-place'|'translate';locomotion?:'scene-lap';replaceExisting?:boolean};
type Outcome = Record<string,unknown> & {ok:boolean};
export type HumanoidMotionTools = {animate(input:Animate):Promise<Outcome>;generate(input:Generate):Promise<Outcome>;get(input:Lookup):Promise<Outcome>;apply(input:Apply):Promise<Outcome>};
type World = {
 read(input:{canvasId:string;contextId:string}):Promise<{ok:true;view:AssistantWorldContextView}|AssistantWorldFailure>|{ok:true;view:AssistantWorldContextView}|AssistantWorldFailure;
 write(input:AssistantWorldWriteInput):Promise<AssistantWorldWriteOutcome>;
};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code:string,message:string):Outcome=>({ok:false,code,message});
/** Shared compiled-frame verification used by the authority commit path too. */
export const somaJointPrefix=somaSkeletonPrefix;
export function createHumanoidMotionTools(deps:{readAsset?: (canvasId:string,assetId:string)=>Promise<StoredAsset|undefined>;compose?: (canvasId:string,walk:StoredAsset,wave:StoredAsset)=>Promise<{assetId:string;checksum:string;asset:StoredAsset;fps:number;frameCount:number;composition:Record<string,unknown>}>;readBytes?:HumanoidMotionPathInput['readBytes'];world:World;task:BackendTaskPort;catalog:()=>Promise<CanvasTaskCatalog>;materialize:(canvasId:string,result:TaskResultSummary,createdAt?:string)=>Promise<{assetId:string;checksum:string;asset:StoredAsset}>}):HumanoidMotionTools {
 async function target(input:Binding,expectedVersion?:string){
  const read=await deps.world.read(input);if(!read.ok)return {...read};
  const view=read.view;
  if(view.canvasId!==input.canvasId||view.contextId!==input.contextId||view.scope.scope.kind!=='scene-area'||!view.worldWritable)return {ok:false as const,code:'outside-scope',message:'需要当前导演区写权限'};
  const version=view.writable.find(v=>v.kind==='instance'&&v.instanceId===input.instanceId);
  const model=view.sceneModels?.find(m=>m.instanceId===input.instanceId);
  if(!version||!model)return {ok:false as const,code:'outside-scope',message:'目标不在当前可写集合'};
  if(expectedVersion!==undefined&&version.version!==expectedVersion)return {ok:false as const,code:'version-conflict',message:'模型内容版本已变化'};
  const prefix=somaJointPrefix(model.animationRig?.groups??[]);
  if(!prefix)return {ok:false as const,code:'invalid-data',message:'目标不是实际编译的标准 SOMA77 骨架'};
  return {ok:true as const,view,model,prefix,version:version.version};
 }
 const tag=(input:Binding,view:AssistantWorldContextView)=>`humanoid-${digest([input.canvasId,view.scope.scope,input.instanceId])}-`;
 async function lookup(input:Lookup){
  const t=await target(input);if(!t.ok)return t;
  if(typeof input.generationId!=='string'||!input.generationId.startsWith(tag(input,t.view)))return {ok:false as const,code:'outside-scope',message:'动作不属于此画布、导演区及角色'};
  const task=await deps.task.status(input.generationId);
  if(!task||task.canvasId!==input.canvasId||task.nodeId!==tag(input,t.view).slice(0,-1)||task.modelType!=='motion')return {ok:false as const,code:'target-unavailable',message:'动作任务不存在'};
  return {ok:true as const,target:t,task};
 }
 async function get(input:Lookup):Promise<Outcome>{
  let asset:{assetId:string;checksum:string;asset:StoredAsset},fps:number,frameCount:number,requestedRaisedWave=false;
  if(input.assetId!==undefined){
   if(input.generationId!==undefined)return fail('invalid-data','generationId与assetId只能选一个');
   const t=await target(input);if(!t.ok)return t;
   const saved=t.view.sceneArea?.animationScript,compiled=saved?executeWorldAnimationScript(saved.script,saved):null;
   const track=compiled?.ok?compiled.ir.somaTracks?.find(v=>v.targetId===input.instanceId&&v.assetId===input.assetId):undefined;
   if(!track)return fail('outside-scope','只能重用当前角色已绑定的动作资产');
   if(!deps.readAsset)return fail('capability-unsupported','当前宿主无法恢复已绑定动作');
   const stored=await deps.readAsset(input.canvasId,input.assetId),metadata=stored?.metadata,m=metadata?.motion;
   if(!stored||stored.id!==input.assetId||stored.status!=='ready'||stored.mediaKind!=='motion'||!metadata||metadata.checksum!==track.checksum||!isSomaMotionMetadata(m)||m.fps!==track.fps||m.frameCount!==track.frameCount)return fail('invalid-data','已绑定动作的稳定资产身份不匹配');
   asset={assetId:stored.id,checksum:track.checksum,asset:stored};fps=m.fps;frameCount=m.frameCount;
  }else{
   const found=await lookup(input);if(!found.ok)return found;
   const {task}=found;
   if(task.state!=='succeeded')return {ok:true,generationId:input.generationId,state:task.state,...(task.error?{error:task.error}:{})};
   const r=task.result,m=r?.motion;
   if(!r||r.mediaKind!=='motion'||r.mediaState||!m||m.skeletonId!=='somaskel77'||m.restPoseId!=='kimodo-standard-tpose'||m.formatVersion!=='kimodo-soma-v1'||!Number.isFinite(m.fps)||m.fps<=0||!Number.isInteger(m.frameCount)||m.frameCount<1)return fail('not-ready','动作尚无有效 SOMA77 稳定产物');
   asset=await deps.materialize(input.canvasId,r,task.createdAt);fps=m.fps;frameCount=m.frameCount;
   requestedRaisedWave=task.request?.prompt?.includes('Keep the right hand raised at head height')??false;
  }
  let timing:ReturnType<typeof inspectSomaMotionTiming>|undefined;
  if(input.inspectTiming){
   if(!deps.readBytes)return fail('capability-unsupported','当前宿主无法读取动作时序');
   try{
    const metadata=asset.asset.metadata;
    if(!metadata||typeof metadata.storageKey!=='string'||!Number.isInteger(metadata.size)||Number(metadata.size)<=0||Number(metadata.size)>128*1024*1024||metadata.checksum!==asset.checksum)throw Error('动作缺少稳定字节身份');
    const bytes=await deps.readBytes({canvasId:input.canvasId,storageKey:metadata.storageKey,maxBytes:128*1024*1024});
    if(bytes.byteLength!==metadata.size||createHash('sha256').update(bytes).digest('hex')!==asset.checksum)throw Error('动作字节校验失败');
    timing=inspectSomaMotionTiming(await decodeSomaPosedJoints(bytes),fps,frameCount);
   }catch(error){return fail('invalid-data',error instanceof Error?error.message:'动作时序读取失败');}
  }
  return {ok:true,generationId:input.generationId,state:'succeeded',...asset,...(timing?{timing}:{}),fps,frameCount,requestedRaisedWave};
 }
 const api:HumanoidMotionTools = {
  async animate(input){
   const t=await target(input);if(!t.ok)return t;
   let generationPrompt=input.prompt;
   const requiresRaisedWave=input.locomotion==='scene-lap'&&/wave|waving|挥手|招手|摆手/i.test(input.prompt);
   if(input.locomotion==='scene-lap'){
    try{
     const planned=createHumanoidSceneLap(t.view,input.instanceId,input.duration);
     generationPrompt=requiresRaisedWave
       ? `A person walks straight forward with continuous alternating steps at approximately ${planned.facts.speed.toFixed(2)} meters per second for ${input.duration} seconds. Keep walking without stopping. The arms swing naturally. Generate locomotion only, without circling or turning; the director adds the waving upper body and the world route separately.`
       : `Generate only the requested body motion: ${input.prompt}. Continue straight forward at approximately ${planned.facts.speed.toFixed(2)} meters per second for ${input.duration} seconds. No turns and no circling: the director controls the world route externally.`;
     if(!planned) return fail('invalid-data','无法规划导演区绕场路线');
    }catch(error){return fail('invalid-data',error instanceof Error?error.message:'无法规划绕场路线');}
   }
   const frozen={...input,prompt:generationPrompt,expectedVersion:t.version,requiresRaisedWave,...(requiresRaisedWave?{steps:50}:{})};
   const submitted=await api.generate(frozen);if(!submitted.ok)return submitted;
   const generationId=String(submitted.generationId);
   const deadline=Date.now()+180_000;
   while(Date.now()<deadline){
    const current=await target(input,t.version);
    if(!current.ok){await deps.task.cancel(generationId).catch(()=>{});return {...current,generationId};}
    const state=await get({...input,generationId});
    if(!state.ok)return state;
    if(state.state==='succeeded'){
     let upperBodyGenerationId:string|undefined;
     if(requiresRaisedWave){
      if(!deps.compose)return fail('capability-unsupported','当前宿主未装配复合动作合成');
      const upper=await api.generate({...frozen,requestId:input.requestId+':upper-body',duration:4,prompt:'A person stands still and waves goodbye continuously with the right hand. Keep the right hand raised at head height, elbow bent, open palm facing outward. Repeatedly wave the raised hand from side to side. Do not walk.',steps:50});
      if(!upper.ok)return {...upper,generationId,fallback:{allowed:false,mode:'joint-animation',reason:'partial-generation',taskSubmitted:true}};
      upperBodyGenerationId=String(upper.generationId);
      let ready=false;
      while(Date.now()<deadline){
       const current=await target(input,t.version);
       if(!current.ok){await deps.task.cancel(upperBodyGenerationId).catch(()=>{});return {...current,generationId,upperBodyGenerationId};}
       const body=await get({...input,generationId:upperBodyGenerationId});if(!body.ok)return body;
       if(body.state==='succeeded'){ready=true;break;}
       if(['failed','cancelled'].includes(String(body.state)))return {...body,ok:false};
       await new Promise(resolve=>setTimeout(resolve,500));
      }
      if(!ready)return {ok:false,code:'timeout',generationId,upperBodyGenerationId,message:'挥手动作仍在生成，未替换原动画'};
     }
     return {...await api.apply({...frozen,generationId,...(upperBodyGenerationId?{upperBodyGenerationId}:{}),startTime:input.startTime??0,replaceExisting:input.replaceExisting??true,...((input.rootMotion==='translate'||input.locomotion==='scene-lap')?{loop:false}:{})}),generationId,...(upperBodyGenerationId?{upperBodyGenerationId}:{})};
    }
    if(['failed','cancelled','canceled'].includes(String(state.state)))return {...state,ok:false};
    await new Promise(resolve=>setTimeout(resolve,500));
   }
   return {ok:false,code:'timeout',generationId,message:'动作仍在生成，可通过 generationId 恢复查询；没有应用动画'};
  },
  async generate(input){
   const t=await target(input,input.expectedVersion);if(!t.ok)return t;
   const generationId=tag(input,t.view)+digest([input.requestId,input.expectedVersion,input.prompt,input.duration,...(input.steps!==undefined?[input.steps]:[])]);
   const existing=await deps.task.status(generationId);
   if(existing){
    if(existing.canvasId!==input.canvasId||existing.nodeId!==tag(input,t.view).slice(0,-1)||existing.modelType!=='motion')return fail('operation-conflict','动作任务身份已被其他内容占用');
    return {ok:true,generationId,state:existing.state,reused:true};
   }
   const catalog=await deps.catalog();
   const available=catalog.models.filter(m=>m.modelType==='motion');
   const model=available.find(m=>m.modelKey===catalog.defaultModels.motion)??available[0];
   if(!catalog.available||!model)return {
    ...fail('capability-unsupported',catalog.available?'当前没有可用的动作生成模型，可使用真实骨架编写关节动画':'当前动作模型目录不可用，可暂用关节动画；不能据此判断远端 GPU 状态'),
    fallback:{allowed:true,mode:'joint-animation',reason:catalog.available?'motion-model-unavailable':'motion-catalog-unavailable',taskSubmitted:false},
    ...(catalog.reason?{catalogReason:catalog.reason}:{})
   };
   // Re-read after catalog await, immediately before durable submission.
   const current=await target(input,input.expectedVersion);if(!current.ok)return current;
   const accepted=await deps.task.submit({workerTaskKey:generationId,canvasId:input.canvasId,nodeId:tag(input,t.view).slice(0,-1),runId:generationId,jobId:generationId,nodeType:'motion',modelType:'motion',modelKey:model.modelKey,interaction:model.interaction,prompt:input.prompt,parameters:{...model.defaultInput,duration:input.duration,...(input.steps!==undefined?{steps:input.steps}:{})},inputs:[]});
   return {ok:true,generationId,state:accepted.state,reused:accepted.reused};
  },get,
  async apply(input){
   let asset=await get(input);if(!asset.ok||asset.state!=='succeeded')return asset.ok?fail('not-ready','动作生成尚未完成'):asset;
   if(input.upperBodyGenerationId){
    if(!deps.compose)return fail('capability-unsupported','复合动作合成不可用');
    const upper=await get({...input,assetId:undefined,generationId:input.upperBodyGenerationId});if(!upper.ok||upper.state!=='succeeded')return upper.ok?fail('not-ready','挥手素材尚未完成'):upper;
    try{asset={...asset,...await deps.compose(input.canvasId,asset.asset as StoredAsset,upper.asset as StoredAsset)};}
    catch(error){return fail('motion-quality-rejected',error instanceof Error?error.message:'复合动作合成失败');}
   }
   const t=await target(input,input.expectedVersion);if(!t.ok)return t;
   const saved=t.view.sceneArea?.animationScript;
   let planned:ReturnType<typeof createHumanoidSceneLap>|undefined;
   if(input.locomotion==='scene-lap'){
    if(!Number.isInteger(t.view.sceneArea?.revision))return fail('capability-unsupported','绕场需要当前场景版本');
    try{planned=createHumanoidSceneLap(t.view,input.instanceId,Number(asset.frameCount)/Number(asset.fps));}
    catch(error){return fail('invalid-data',error instanceof Error?error.message:'绕场路线校验失败');}
   }
   if(input.rootMotion==='translate'&&!planned){
    if(!deps.readBytes||!t.view.bounds||!t.model.animationRig?.spatial?.groundAnchorLocal)return fail('capability-unsupported','当前宿主无法验证动作位移路径');
    const existing=saved?executeWorldAnimationScript(saved.script,saved):null;
    if(!input.replaceExisting&&existing?.ok&&existing.ir.instanceTracks.some(track=>track.targetId===input.instanceId))return fail('invalid-data','位移动作不能与同角色独立位置、旋转或缩放轨道同时应用');
    try{await validateHumanoidMotionPath({canvasId:input.canvasId,asset:asset.asset as StoredAsset,transform:t.model.transform,bounds:t.view.bounds,groundAnchorLocal:t.model.animationRig.spatial.groundAnchorLocal,readBytes:deps.readBytes});}
    catch(error){return fail('invalid-data',error instanceof Error?error.message:'动作路径校验失败');}
   }
   let gestureVerification:Record<string,unknown>|undefined;
   if(planned&&(input.requiresRaisedWave||asset.requestedRaisedWave||input.upperBodyGenerationId)){
    if(!deps.readBytes)return fail('capability-unsupported','当前宿主无法验证挥手动作');
    try{
     const stored=asset.asset as StoredAsset,m=stored.metadata!;
     const bytes=await deps.readBytes({canvasId:input.canvasId,storageKey:String(m.storageKey),maxBytes:128*1024*1024});
     if(bytes.byteLength!==m.size||createHash('sha256').update(bytes).digest('hex')!==m.checksum)throw new Error('挥手动作稳定字节校验失败');
     gestureVerification=await validateRaisedWavePrerequisite(bytes,Number(asset.frameCount));
     if(input.upperBodyGenerationId&&Math.max(Number(gestureVerification.leftRaisedFraction),Number(gestureVerification.rightRaisedFraction))<.98)throw new Error('合成动作未保持持续抬手，原动画未替换');
    }catch(error){return fail('motion-quality-rejected',error instanceof Error?error.message:'挥手姿态检查失败');}
   }
   const sourceDuration=Number(asset.frameCount)/Number(asset.fps);
   const sourceStartTime=input.sourceStartTime??0;
   const blendInDuration=input.blendInDuration??(sourceStartTime>0?Math.min(.12,sourceDuration-sourceStartTime):0);
   if(!Number.isFinite(sourceStartTime)||sourceStartTime<0||sourceStartTime>=sourceDuration||!Number.isFinite(blendInDuration)||blendInDuration<0||blendInDuration>Math.min(1,sourceDuration-sourceStartTime)||!Number.isFinite(input.startTime)||input.startTime<0)return fail('invalid-data','动作片内起点或过渡时间无效');
   if((sourceStartTime>0||blendInDuration>0)&&(input.rootMotion==='translate'||planned))return fail('capability-unsupported','当前片内裁切仅支持原地动作；位移和绕场继续使用完整素材');
   const endTime=input.startTime+sourceDuration-sourceStartTime;
   const clip={assetId:asset.assetId,checksum:asset.checksum,fps:asset.fps,frameCount:asset.frameCount,startTime:input.startTime,endTime,...(input.sourceStartTime!==undefined?{sourceStartTime}:{}),...(blendInDuration>0||input.blendInDuration!==undefined?{blendInDuration}:{}),jointPrefix:t.prefix,rootMotion:planned?'in-place':input.rootMotion??'in-place',...(planned?{route:planned.route}:{})};
   const declaration=`motion.soma.clip(${JSON.stringify(input.instanceId)},${JSON.stringify(clip)});`;
   const compiled=saved?executeWorldAnimationScript(saved.script,saved):null;
   const alreadyBound=compiled?.ok && compiled.ir.somaTracks?.some(track=>track.targetId===input.instanceId&&(track.sourceStartTime??0)===sourceStartTime&&(track.blendInDuration??0)===blendInDuration&&Object.entries(clip).every(([key,value])=>JSON.stringify((track as unknown as Record<string,unknown>)[key])===JSON.stringify(value)));
   if(alreadyBound&&(input.loop===undefined||saved?.loop===input.loop))return {ok:true,noop:true,generationId:input.generationId};
   if(saved&&!compiled?.ok)return fail('invalid-data','当前动画脚本无法编译，不能安全替换角色动作');
   const base=input.replaceExisting&&compiled?.ok?serializeWorldAnimationScript(removeWorldAnimationInstanceTracks(compiled.ir,new Set([input.instanceId]))):saved?.script??'';
   const script=alreadyBound?saved!.script:base+'\n'+declaration;
   const outcome=await deps.world.write({contextId:input.contextId,operation:{kind:'set-scene-animation-script',motionBaseRevision:saved?.revision??0,motionTarget:{instanceId:input.instanceId,expectedVersion:input.expectedVersion,scopeVersion:t.view.sceneArea?.scopeVersion,...(planned?{canvasRevision:t.view.sceneArea?.revision}:{})},motionAsset:asset.asset as StoredAsset,operationId:`humanoid-apply-${digest([input.generationId,input.assetId,input.startTime,saved?.revision,input.expectedVersion,input.rootMotion,input.locomotion,input.replaceExisting,input.upperBodyGenerationId,sourceStartTime,blendInDuration])}`,script,duration:Math.max(saved?.duration??0,endTime),loop:input.loop??saved?.loop??false}});
   return {...outcome,...(outcome.ok?{generationId:input.generationId,assetId:asset.assetId,timing:{startTime:input.startTime,sourceStartTime,blendInDuration,endTime,eventMapping:"timelineTime = startTime + sourceEventTime - sourceStartTime"},replacedExisting:!!input.replaceExisting,...(asset.composition?{composition:asset.composition}:{}),...(gestureVerification?{gestureVerification}:{}),...(planned?{locomotion:'scene-lap',routeVerification:planned.facts,verification:'route-data-verified; body-motion-and-foot-contact-require-visual-review'}:{})}:{})};
  }
 };
 return api;
}
