import { describeSomaSceneLapRoute, projectSomaRootTranslation, roundedWalkPath, sampleSomaSceneLapRoute, validateSomaSceneLapRoute, type AssistantWorldContextView, type SomaSceneLapRoute } from '@woohaa3/contracts';

/** Construct from authoritative geometry only; never changes the canonical actor transform. */
export function createHumanoidSceneLap(view: AssistantWorldContextView, instanceId: string, duration: number) {
 const bounds=view.bounds, actor=view.sceneModels?.find(model=>model.instanceId===instanceId);
 if(!view.worldWritable||view.scope.scope.kind!=='scene-area'||!bounds||!actor)throw new Error('场景绕行需要导演区内的可写角色与范围');
 if(![bounds.min.u,bounds.min.v,bounds.max.u,bounds.max.v].every(Number.isFinite)||bounds.min.u>=bounds.max.u||bounds.min.v>=bounds.max.v)throw new Error('导演区范围无效');
 const {transform,localBounds}=actor, anchor=actor.animationRig?.spatial?.groundAnchorLocal;
 if(!anchor||!anchor.every(Number.isFinite)||!localBounds)throw new Error('场景绕行缺少稳定脚底锚点或模型包围盒');
 if(!Number.isFinite(transform.scale)||transform.scale<=0||Math.abs(Math.hypot(...transform.rotation)-1)>1e-6||Math.abs(transform.rotation[0])+Math.abs(transform.rotation[1])>1e-6)throw new Error('场景绕行要求直立的有效角色变换');
 const start=projectSomaRootTranslation(anchor,transform.rotation,transform.scale,transform.position);
 const inside=(u:number,v:number)=>Number.isFinite(u)&&Number.isFinite(v)&&u>=bounds.min.u&&u<=bounds.max.u&&v>=bounds.min.v&&v<=bounds.max.v;
 if(!inside(start.u,start.v))throw new Error('稳定脚底锚点超出导演区范围');
 const extents=[localBounds.min,localBounds.max];
 if(!extents.every(p=>p.every(Number.isFinite)))throw new Error('角色包围盒无效');
 const clearance=Math.max(.35,Math.hypot(Math.max(...extents.map(p=>Math.abs(p[0]-anchor[0]))),Math.max(...extents.map(p=>Math.abs(p[2]-anchor[2]))))*transform.scale+.1);
 const minU=bounds.min.u+clearance,maxU=bounds.max.u-clearance,minV=bounds.min.v+clearance,maxV=bounds.max.v-clearance;
 if(Math.min(maxU-minU,maxV-minV)<1)throw new Error('导演区过小，无法容纳完整场景绕行');
 const path=[{u:minU,v:minV},{u:maxU,v:minV},{u:maxU,v:maxV},{u:minU,v:maxV}];
 const cornerRadius=Math.min(1,(maxU-minU)/4,(maxV-minV)/4);
 const lap=roundedWalkPath(path.map(p=>[p.u,p.v]),cornerRadius);
 let phaseDistance=0,best=Infinity;
 for(let i=0;i<2048;i++){const distance=i*lap.length/2048,p=lap.sample(distance).point,d=Math.hypot(p[0]-start.u,p[1]-start.v);if(d<best){best=d;phaseDistance=distance;}}
 const route:SomaSceneLapRoute={kind:'scene-lap',connectorMode:'smooth',path,cornerRadius,startAnchor:{u:start.u,v:start.v},phaseDistance,groundAnchorLocal:[...anchor],baseRotation:[...transform.rotation],scale:transform.scale,rootHeight:transform.position.h,...(view.sceneArea?{referenceFrame:{origin:{...view.sceneArea.animationOrigin},quarterTurns:view.sceneArea.animationQuarterTurns??0}}:{})};
 validateSomaSceneLapRoute(route,duration);
 // Expanded obstacle footprints and a swept polyline conservatively cover the body,
 // including both connectors. Unknown obstacle geometry fails closed.
 const obstacles=(view.sceneModels??[]).filter(m=>m.instanceId!==instanceId).map(model=>{
  if(!model.localBounds)throw new Error(`场景绕行缺少障碍物包围盒：${model.instanceId}`);
  const points=[];
  for(let mask=0;mask<8;mask++)points.push(projectSomaRootTranslation([0,1,2].map(i=>(mask&(1<<i))?model.localBounds!.max[i]!:model.localBounds!.min[i]!) as [number,number,number],model.transform.rotation,model.transform.scale,model.transform.position));
  if(!points.every(p=>[p.u,p.v,p.h].every(Number.isFinite)))throw new Error('障碍物包围盒无效');
  return {id:model.instanceId,minU:Math.min(...points.map(p=>p.u))-clearance-.05,maxU:Math.max(...points.map(p=>p.u))+clearance+.05,minV:Math.min(...points.map(p=>p.v))-clearance-.05,maxV:Math.max(...points.map(p=>p.v))+clearance+.05};
 });
 const facts=describeSomaSceneLapRoute(route,duration),steps=Math.ceil(facts.length/.025);
 for(let i=0;i<=steps;i++){
  const pose=sampleSomaSceneLapRoute(route,i/steps);
  const anchorPoint=projectSomaRootTranslation(route.groundAnchorLocal,pose.rotation,route.scale,pose.position);
  const p:[number,number]=[anchorPoint.u,anchorPoint.v];
  if(!inside(...p))throw new Error('场景绕行路径超出导演区范围');
  const hit=obstacles.find(o=>p[0]>=o.minU&&p[0]<=o.maxU&&p[1]>=o.minV&&p[1]<=o.maxV);
  if(hit)throw new Error(`场景绕行路径与障碍物冲突：${hit.id}`);
 }
 return {route,facts:{...describeSomaSceneLapRoute(route,duration),closedLoop:true as const,fullLap:true as const,canonicalTransformUnchanged:true as const}};
}
