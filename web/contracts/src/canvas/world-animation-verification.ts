/** Bounded post-save data diagnostics. This is neither visual acceptance nor contact solving. */
import { quatRotate,quatMul } from "./model-transform.js";
import { describeHumanoidMotion, sampleJointEndpoint,sampleRigLandmarks } from "./humanoid-motion-reference.js";
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
  for(const track of [...ir.instanceTracks,...(ir.partTracks ?? []),...(ir.walkTracks ?? [])]) {
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

export function analyzeWorldAnimationData(ir:WorldAnimationIr, models:readonly Model[], origin:GroundPoint, area?:GroundAabb, quarterTurns = 0) {
  const targets=new Set([...ir.instanceTracks,...(ir.partTracks ?? []),...(ir.walkTracks ?? [])].map(track=>track.targetId));
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
      if(!(ir.partTracks ?? []).some(track=>track.targetId===instanceId && track.partId===joint.jointId) && !(ir.walkTracks ?? []).some(track=>track.targetId===instanceId))continue;
      jointSamples.set(JSON.stringify([instanceId,joint.jointId]),{instanceId,jointId:joint.jointId,childId:joint.childId,lengthMeters:joint.lengthMeters,samples:[]});
    }
  }
  const previousFeet=new Map<string,{time:number;u:number;v:number;h:number}>();
  for(const time of times){
    const current=sampleWorldAnimationInArea(ir,time,origin,quarterTurns);
    const neighborTime=time<ir.duration ? Math.min(ir.duration,time+0.01) : Math.max(0,time-0.01);
    const next=sampleWorldAnimationInArea(ir,neighborTime,origin,quarterTurns);
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
          // Use the actual parent-relative endpoint, not Euler decomposition. In
          // the standard downward shin bind, negative X sends the foot forward.
          const joint=model.animationRig.groups.find(group=>group.id===record.jointId);
          const child=model.animationRig.groups.find(group=>group.id===record.childId);
          if(posed && record.jointId.endsWith("LowerLeg") && joint && child &&
            Math.abs(joint.rotation[0])+Math.abs(joint.rotation[1])+Math.abs(joint.rotation[2])<1e-6 &&
            child.position[1]<0 && Math.abs(child.position[0])+Math.abs(child.position[2])<1e-6 &&
            posed.endpointInParent[2]>record.lengthMeters*Math.sin(5*Math.PI/180)) {
            flag(instanceId,"knee-hyperextension",time,{jointId:record.jointId,forwardEndpointMeters:posed.endpointInParent[2],method:"known-downward-shin-endpoint"});
          }
        }
      }
      const result=inspectWorldAnimationModelSample(model,current.instances.get(instanceId),next.instances.get(instanceId),area,neighborTime-time);
      // Generated contacts name a stance interval; independently reconstruct actual
      // rig sockets at the neighboring time instead of trusting the planned target.
      const motion=current.instances.get(instanceId),neighbor=next.instances.get(instanceId);
      if(model.animationRig && motion?.footContacts && neighbor?.footContacts){
        const nextLandmarks=sampleRigLandmarks(model.animationRig,neighbor.partRotations);
        const rotation=neighbor.rotation ? quatMul([...model.transform.rotation],[...neighbor.rotation]) : model.transform.rotation;
        const position=neighbor.position ?? model.transform.position,scale=neighbor.scale ?? model.transform.scale;
        for(const [jointId,contact] of Object.entries(motion.footContacts)){
          const following=neighbor.footContacts[jointId],a=result.landmarksLocal[jointId],b=nextLandmarks[jointId];
          if(!contact.stance||!following?.stance||contact.plant!==following.plant||!a||!b)continue;
          const wa=quatRotate([...result.worldTransform.rotation],[a[0]*result.worldTransform.scale,-a[2]*result.worldTransform.scale,a[1]*result.worldTransform.scale]);
          const wb=quatRotate([...rotation],[b[0]*scale,-b[2]*scale,b[1]*scale]);
          const displacement=Math.hypot(wa[0]+result.worldTransform.position.u-wb[0]-position.u,wa[1]+result.worldTransform.position.v-wb[1]-position.v,wa[2]+result.worldTransform.position.h-wb[2]-position.h);
          if(displacement>0.001*scale)flag(instanceId,"apparent-support-foot-drift",time,{jointId,displacementMeters:displacement,intervalSeconds:Math.abs(neighborTime-time),method:"declared stance interval; actual posed rig socket; contact unverified"});
        }
      }
      // A near-ground socket is only a support candidate. This detects apparent
      // sliding, never physical contact, and only when a known leg is animated.
      if(model.animationRig?.rig?.templateId==="humanoid" && result.ground && Math.abs(result.ground.lowestBoundsHeightMeters)<0.05) {
        for(const side of ["Left","Right"]){
          if(!(ir.partTracks ?? []).some(track=>track.targetId===instanceId && (track.partId===`${side}UpperLeg` || track.partId===`${side}LowerLeg`)))continue;
          const local=result.landmarksLocal[`${side}Foot`];
          if(!local)continue;
          const world=result.worldTransform;
          const offset=quatRotate([...world.rotation],[local[0]*world.scale,-local[2]*world.scale,local[1]*world.scale]);
          const foot={time,u:world.position.u+offset[0],v:world.position.v+offset[1],h:world.position.h+offset[2]};
          const key=JSON.stringify([instanceId,side]),previous=previousFeet.get(key);
          if(previous && time-previous.time<=1 && time>previous.time && Math.abs(foot.h)<0.12 && Math.abs(previous.h)<0.12 && Math.abs(foot.h-previous.h)<0.02){
            const drift=Math.hypot(foot.u-previous.u,foot.v-previous.v);
            if(drift>0.08)flag(instanceId,"apparent-support-foot-drift",time,{jointId:`${side}Foot`,displacementMeters:drift,intervalSeconds:time-previous.time,method:"near-ground-socket-candidate; contact unverified"});
          }
          previousFeet.set(key,foot);
        }
      } else {
        for(const side of ["Left","Right"])previousFeet.delete(JSON.stringify([instanceId,side]));
      }
      if(result.heading.status==="sideways")flag(instanceId,"sideways-motion",time,{alignment:result.heading.alignment});
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
  // Inspect one-sided path tangents only at authored boundaries (and the loop
  // seam). These are timeline samples, with no additional geometry evaluation.
  const boundaryTimes=new Set(ir.instanceTracks.filter(track=>track.property==="position").flatMap(track=>[track.startTime,track.endTime]));
  if(ir.loop)boundaryTimes.add(0);
  const epsilon=Math.min(0.01,ir.duration/1000);
  for(const time of times)if(boundaryTimes.has(time) && time<ir.duration && (ir.loop || time>0)) {
    const before=sampleWorldAnimationInArea(ir,time===0 ? ir.duration-epsilon : time-epsilon,origin,quarterTurns);
    const center=sampleWorldAnimationInArea(ir,time,origin,quarterTurns);
    const after=sampleWorldAnimationInArea(ir,time===ir.duration ? epsilon : time+epsilon,origin,quarterTurns);
    const seamEnd=time===0 ? sampleWorldAnimationInArea(ir,ir.duration,origin,quarterTurns) : center;
    for(const instanceId of targets){
      const a=before.instances.get(instanceId)?.position,b=seamEnd.instances.get(instanceId)?.position;
      const c=center.instances.get(instanceId)?.position,d=after.instances.get(instanceId)?.position;
      if(!a || !b || !c || !d)continue;
      const incoming=[b.u-a.u,b.v-a.v],outgoing=[d.u-c.u,d.v-c.v];
      const lengths=Math.hypot(...incoming)*Math.hypot(...outgoing);
      if(lengths>1e-12){
        const alignment=(incoming[0]!*outgoing[0]!+incoming[1]!*outgoing[1]!)/lengths;
        if(alignment<Math.SQRT1_2)flag(instanceId,"path-tangent-discontinuity",time,{alignment,loopSeam:time===0 || time===ir.duration});
      }
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
    limits:"Bounded time samples and conservative geometry bounds; intentional axial twists, hyperextension, sideways/backward motion, sharp turns, foot drift, jumps and departures require intent review. Near-ground sockets are support candidates only; contact is unverified. Body overflow is informational. No visual, IK or contact verification."
  };
}
