import type {HumanoidInteractionInput,HumanoidInteractionActor,StoredAsset} from '@woohaa3/contracts';
type Outcome=Record<string,any>&{ok:boolean};
type ActorInput=HumanoidInteractionActor&{canvasId:string;contextId:string;requestId:string};
type Dependencies={
 validate(input:ActorInput):Promise<Outcome>;
 generate(input:ActorInput):Promise<Outcome>;
 get(input:{canvasId:string;contextId:string;instanceId:string;generationId:string;inspectTiming:true}):Promise<Outcome>;
 apply(input:ActorInput&{generationId:string;startTime:number;sourceStartTime:number;blendInDuration:number;replaceExisting:true;loop:false}):Promise<Outcome>;
 checkPath(input:ActorInput,asset:StoredAsset):Promise<void>;
};
/** No successful return can skip inspection or the movement decision. Publication remains per actor. */
export async function runHumanoidInteraction(input:HumanoidInteractionInput,deps:Dependencies):Promise<Outcome>{
 const generationIds:Record<string,string>={},appliedActors:string[]=[];
 const fail=(phase:string,result:Outcome):Outcome=>({...result,ok:false,phase,generationIds:{...generationIds},appliedActors:[...appliedActors],...(Object.keys(generationIds).length?{fallback:{allowed:false,mode:'joint-animation',reason:'interaction-already-submitted',taskSubmitted:true}}:{})});
 const attempt=async(work:()=>Promise<Outcome>):Promise<Outcome>=>{try{return await work();}catch(error){return {ok:false,code:'operation-failed',message:error instanceof Error?error.message:'互动操作失败'};}};
 const actors=[input.initiator,input.responder];
 if(actors[0].instanceId===actors[1].instanceId)return fail('validate',{ok:false,code:'invalid-data',message:'互动需要两个不同角色'});
 const keys=['initiator','responder'] as const;
 const args=actors.map((actor,i)=>({...actor,canvasId:input.canvasId,contextId:input.contextId,requestId:input.requestId+':'+keys[i]}));
 for(const actor of args){
  if(!['in-place','translate'].includes(actor.rootMotion)||!Number.isFinite(actor.duration)||actor.duration<1||actor.duration>10)return fail('validate',{ok:false,code:'invalid-data',message:'每个角色必须明确位移模式和1到10秒时长'});
  const checked=await attempt(()=>deps.validate(actor));if(!checked.ok)return fail('validate',checked);
 }
 for(let i=0;i<args.length;i++){
  const submitted=await attempt(()=>deps.generate(args[i]!));if(!submitted.ok)return fail('generate',submitted);
  generationIds[keys[i]!]=String(submitted.generationId);
 }
 const deadline=Date.now()+180000,sources:Outcome[]=[];
 for(let i=0;i<args.length;i++){
  const actor=args[i]!;
  while(true){
   const checked=await attempt(()=>deps.validate(actor));if(!checked.ok)return fail('inspect',checked);
   const source=await attempt(()=>deps.get({...actor,generationId:generationIds[keys[i]!]!,inspectTiming:true}));
   if(!source.ok)return fail('inspect',source);
   if(source.state==='succeeded'){
    if(!source.timing?.signals||!source.rootTravel||!Number.isFinite(source.rootTravel.maxHorizontalDistance))return fail('inspect',{ok:false,code:'not-ready',message:'互动素材缺少已验证的时序或根位移数据'});
    sources.push(source);break;
   }
   if(['failed','cancelled','canceled'].includes(source.state))return fail('inspect',{...source,ok:false});
   if(Date.now()>deadline)return fail('inspect',{ok:false,code:'timeout',message:'互动素材仍在生成，使用返回的generationIds恢复，不要重复提交'});
   await new Promise(resolve=>setTimeout(resolve,500));
  }
 }
 for(let i=0;i<args.length;i++){
  const actor=args[i]!,source=sources[i]!;
  if(actor.rootMotion==='in-place'&&source.rootTravel.maxHorizontalDistance>.2&&!actor.allowInPlaceTravel)return fail('movement',{ok:false,code:'movement-decision-required',instanceId:actor.instanceId,rootTravel:source.rootTravel,message:'素材含明显根位移。使用translate并检查路径；只有用户明确要求原地时才允许allowInPlaceTravel:true，不能静默丢弃后退或被推开的位移'});
  if(actor.rootMotion==='translate')try{await deps.checkPath(actor,source.asset);}catch(error){return fail('movement',{ok:false,code:'invalid-data',instanceId:actor.instanceId,message:error instanceof Error?error.message:'位移路径检查失败'});}
 }
 const publications:Array<{canvasId:string;commandId:string;nodeId?:string;revision?:number}>=[];
 const event=sources[0]!.timing.signals[input.initiatorEvent];
 const attackTime=event?.peakTime;
 const candidates=[sources[1]!.timing.signals.torsoTilt?.onsetTime,sources[1]!.timing.signals.headDisplacement?.onsetTime,sources[1]!.rootTravel.onsetTime].filter((time):time is number=>typeof time==='number'&&Number.isFinite(time)&&time>=0);
 if(!Number.isFinite(attackTime)||attackTime<0||!Number.isFinite(event?.peakValue)||event.peakValue<.04||!candidates.length)return fail('align',{ok:false,code:'motion-timing-unavailable',message:'素材没有足够清晰的发力伸展或身体反应候选，未应用互动；不能宣称已经对齐'});
 const responseTime=Math.min(...candidates);
 let start=[0,0],sourceStart=[0,0],blend=[0,0],eventTime:number;
 if(args[1]!.rootMotion==='translate'){
  eventTime=Math.max(attackTime,responseTime);start=[eventTime-attackTime,eventTime-responseTime];
 }else{
  eventTime=attackTime;const preRoll=Math.min(.12,attackTime,responseTime);
  start=[0,attackTime-preRoll];sourceStart=[0,responseTime-preRoll];blend=[0,preRoll];
 }
 for(let i=0;i<args.length;i++){
  const actor=args[i]!,checked=await attempt(()=>deps.validate(actor));if(!checked.ok)return fail('apply',checked);
  const applied=await attempt(()=>deps.apply({...actor,generationId:generationIds[keys[i]!]!,startTime:start[i]!,sourceStartTime:sourceStart[i]!,blendInDuration:blend[i]!,replaceExisting:true,loop:false}));
  if(!applied.ok)return fail('apply',applied);appliedActors.push(actor.instanceId);
  if(typeof applied.commandId==='string'&&typeof applied.canvasId==='string')publications.push({canvasId:applied.canvasId,commandId:applied.commandId,...(typeof applied.nodeId==='string'?{nodeId:applied.nodeId}:{}),...(typeof applied.revision==='number'?{revision:applied.revision}:{})});
 }
 const last=publications.at(-1);
 return {ok:true,phase:'applied',generationIds,appliedActors,verification:'kinematic-alignment-only',timing:{initiatorEvent:input.initiatorEvent,initiatorSourceTime:attackTime,responderSourceTime:responseTime,timelineEventTime:eventTime},actors:args.map((actor,i)=>({instanceId:actor.instanceId,rootMotion:actor.rootMotion,rootTravel:sources[i]!.rootTravel,startTime:start[i],sourceStartTime:sourceStart[i],blendInDuration:blend[i],discardedRootTravel:actor.rootMotion==='in-place'&&sources[i]!.rootTravel.maxHorizontalDistance>.2})),...(last??{}),...(publications.length?{commandReceipts:publications}:{}),limits:'Kinematic candidates only; no contact, IK, foot locking or visual verification. Publication is per actor; failures report appliedActors.'};
}
