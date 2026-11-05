/** Bounded post-save data diagnostics. This is neither visual acceptance nor contact solving. */
import { describeHumanoidMotion, sampleJointEndpoint } from "./humanoid-motion-reference.js";
import type { WorldModelAnimationRig } from "./assistant-world-authority.js";
import { inspectWorldAnimationModelSample } from "./world-animation-spatial.js";
import { sampleWorldAnimationInArea, type WorldAnimationIr, type WorldPartTrack } from "./world-animation-script.js";
import type { GroundAabb, GroundPoint, WorldTransform } from "./shared-world.js";

type Model = {instanceId:string;transform:WorldTransform;animationRig?:WorldModelAnimationRig};
type Issue = {code:string;instanceId:string;times:number[];occurrenceCount:number;detail:Record<string,unknown>};

function diagnosticTimes(ir: WorldAnimationIr, maximum: number): number[] {
  const times = new Set<number>([0,ir.duration]);
  const add = (time:number) => { if(Number.isFinite(time) && time>=0 && time<=ir.duration) times.add(time); };
  for(let i=1;i<32;i++)add(ir.duration*i/32);
  for(const track of [...ir.instanceTracks,...(ir.partTracks ?? [])]) {
    add(track.startTime);add(track.endTime);
    for(const fraction of [0.25,0.5,0.75])add(track.startTime+(track.endTime-track.startTime)*fraction);
    const cycle = "partId" in track ? (track as WorldPartTrack).cycle : undefined;
    if(cycle) {
      const {period,phase,keyframes} = cycle;
      for(const frame of keyframes) {
        const offset = ((frame.time-phase)%period+period)%period;
        add(track.startTime+offset);
        add(track.endTime-((track.endTime-track.startTime-offset)%period+period)%period);
      }
    }
  }
  const sorted=[...times].sort((a,b)=>a-b);
  if(sorted.length<=maximum)return sorted;
  return Array.from({length:maximum},(_,i)=>sorted[Math.round(i*(sorted.length-1)/(maximum-1))]!);
}

export function analyzeWorldAnimationData(ir:WorldAnimationIr, models:readonly Model[], origin:GroundPoint, area?:GroundAabb) {
  const targets=new Set([...ir.instanceTracks,...(ir.partTracks ?? [])].map(track=>track.targetId));
  const byId=new Map(models.map(model=>[model.instanceId,model]));
  const unavailableTargets=new Set<string>();
  const issues=new Map<string,Issue>();
  // Bound combined geometry evaluations as well as timeline coverage.
  const maximum=Math.max(2,Math.min(96,Math.floor(512/Math.max(1,targets.size))));
  const times=diagnosticTimes(ir,maximum);
  let bodyOverflowSampleCount=0;
  const flag=(instanceId:string,code:string,time:number,detail:Record<string,unknown>)=>{
    const key=JSON.stringify([instanceId,code,detail.jointId ?? null]);
    let issue=issues.get(key);
    if(!issue){issue={code,instanceId,times:[],occurrenceCount:0,detail};issues.set(key,issue);}
    issue.occurrenceCount++;
    if(issue.times.length<4)issue.times.push(time);
  };
  for(const instanceId of targets)if(!byId.has(instanceId))unavailableTargets.add(instanceId);
  const jointSamples=new Map<string,{instanceId:string;jointId:string;childId:string;lengthMeters:number;samples:Array<{time:number;endpointInParent:readonly number[];rotation:readonly number[]}>}>();
  for(const instanceId of targets){
    const rig=byId.get(instanceId)?.animationRig;
    const reference=rig ? describeHumanoidMotion(rig) : null;
    for(const joint of reference?.joints ?? []) {
      if(!(ir.partTracks ?? []).some(track=>track.targetId===instanceId && track.partId===joint.jointId))continue;
      jointSamples.set(JSON.stringify([instanceId,joint.jointId]),{instanceId,jointId:joint.jointId,childId:joint.childId,lengthMeters:joint.lengthMeters,samples:[]});
    }
  }
  for(const time of times){
    const current=sampleWorldAnimationInArea(ir,time,origin);
    const neighborTime=time<ir.duration ? Math.min(ir.duration,time+0.01) : Math.max(0,time-0.01);
    const next=sampleWorldAnimationInArea(ir,neighborTime,origin);
    for(const instanceId of targets){
      const model=byId.get(instanceId);
      if(!model)continue;
      // Only observed authored joint values count: a track that is inactive at
      // these times must not be compared against an invented identity pose.
      const rotations=current.instances.get(instanceId)?.partRotations;
      if(model.animationRig && rotations) {
        for(const record of jointSamples.values()) {
          if(record.instanceId!==instanceId || !rotations[record.jointId])continue;
          const posed=sampleJointEndpoint(model.animationRig,record.jointId,record.childId,rotations);
          if(posed)record.samples.push({time,...posed});
        }
      }
      const result=inspectWorldAnimationModelSample(model,current.instances.get(instanceId),next.instances.get(instanceId),area,neighborTime-time);
      if(result.heading.status==="backward")flag(instanceId,"backward-motion",time,{alignment:result.heading.alignment});
      if(!result.ground || result.membership.anchorWorld===null)unavailableTargets.add(instanceId);
      if(result.heading.status==="unknown" && current.instances.get(instanceId)?.position)unavailableTargets.add(instanceId);
      if(result.ground){
        const height=result.ground.lowestBoundsHeightMeters;
        if(!Number.isFinite(height))flag(instanceId,"non-finite-pose",time,{});
        else if(height < -0.05)flag(instanceId,"below-ground-bounds",time,{lowestBoundsHeightMeters:height,recommendedRootHeightMeters:result.ground.recommendedRootHeightMeters});
        else if(height > 0.15)flag(instanceId,"above-ground-bounds",time,{lowestBoundsHeightMeters:height});
      }
      if(result.membership.insideSceneArea===false)flag(instanceId,"anchor-outside-area",time,{anchorWorld:result.membership.anchorWorld});
      if(result.bounds?.outsideSceneArea===true)bodyOverflowSampleCount++;
    }
  }
  for(const record of jointSamples.values()) {
    let rotationRadians=0,endpointDisplacementMeters=0;
    for(let i=0;i<record.samples.length;i++)for(let j=i+1;j<record.samples.length;j++) {
      const a=record.samples[i]!,b=record.samples[j]!;
      const dot=a.rotation.reduce((sum,value,k)=>sum+value*b.rotation[k]!,0);
      rotationRadians=Math.max(rotationRadians,2*Math.acos(Math.min(1,Math.abs(dot))));
      endpointDisplacementMeters=Math.max(endpointDisplacementMeters,Math.hypot(...a.endpointInParent.map((value,k)=>value-b.endpointInParent[k]!)));
    }
    if(rotationRadians>8*Math.PI/180 && endpointDisplacementMeters<Math.max(0.00001,record.lengthMeters*0.03)) {
      flag(record.instanceId,"joint-twist-without-swing",record.samples[0]!.time,{jointId:record.jointId,rotationRadians,endpointDisplacementMeters,boneLengthMeters:record.lengthMeters});
    }
  }
  return {
    verification:"sampled-data-only" as const,
    status:issues.size ? "warnings" as const : unavailableTargets.size ? "partial" as const : "clear" as const,
    sampleCount:times.length,
    checkedTimes:times,
    issues:[...issues.values()],unavailableTargets:[...unavailableTargets],bodyOverflowSampleCount,
    limits:"Bounded time samples and conservative geometry bounds; intentional axial twists, backward motion, jumps and departures require intent review. Body overflow is informational. No visual, IK or contact verification."
  };
}
