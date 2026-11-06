/** Trusted distance-driven locomotion math; source scripts only declare a route. */
type Point=[number,number];
type RouteSample={point:Point;tangent:Point};
const add=(a:Point,b:Point):Point=>[a[0]+b[0],a[1]+b[1]];
const sub=(a:Point,b:Point):Point=>[a[0]-b[0],a[1]-b[1]];
const mul=(a:Point,s:number):Point=>[a[0]*s,a[1]*s];
const cross=(a:Point,b:Point)=>a[0]*b[1]-a[1]*b[0];
const mod=(a:number,b:number)=>((a%b)+b)%b;
const unit=(a:Point):Point=>mul(a,1/Math.hypot(...a));
export function roundedWalkPath(points:Point[],radius:number):{length:number;maxCurvature:number;sample:(distance:number)=>RouteSample}{
 if(points.length<3||points.length>64||!points.every(p=>p.length===2&&p.every(Number.isFinite))||!Number.isFinite(radius)||radius<=0)throw new Error('Invalid closed walk route');
 const edges=points.map((p,i)=>sub(points[(i+1)%points.length]!,p));
 if(edges.some(e=>Math.hypot(...e)<1e-5))throw new Error('Repeated walk waypoint');
 for(let i=0;i<points.length;i++)for(let j=i+2;j<points.length;j++){
  if(i===0&&j===points.length-1)continue;
  const p=points[i]!,q=points[j]!,a=edges[i]!,b=edges[j]!,den=cross(a,b);
  if(Math.abs(den)<1e-9)continue;
  const t=cross(sub(q,p),b)/den,u=cross(sub(q,p),a)/den;
  if(t>=0&&t<=1&&u>=0&&u<=1)throw new Error('Crossing walk route');
 }
 const corners=points.map((p,i)=>{
  const incoming=unit(edges[(i+points.length-1)%points.length]!),outgoing=unit(edges[i]!);
  const turn=Math.atan2(cross(incoming,outgoing),incoming[0]*outgoing[0]+incoming[1]*outgoing[1]);
  if(Math.abs(turn)>Math.PI-.001)throw new Error('Reversing walk corner');
  if(Math.abs(turn)<1e-8)return {entry:p,exit:p,center:p,r:0,turn:0,start:0};
  const trim=Math.min(radius*Math.tan(Math.abs(turn)/2),.45*Math.hypot(...edges[i]!),.45*Math.hypot(...edges[(i+points.length-1)%points.length]!));
  const r=trim/Math.tan(Math.abs(turn)/2),entry=sub(p,mul(incoming,trim)),exit=add(p,mul(outgoing,trim));
  const center=add(entry,mul([-incoming[1],incoming[0]],Math.sign(turn)*r));
  return {entry,exit,center,r,turn,start:Math.atan2(entry[1]-center[1],entry[0]-center[0])};
 });
 const segments:Array<{length:number;at:(distance:number)=>RouteSample}>=[];
 for(let i=0;i<points.length;i++){
  const a=corners[i]!,b=corners[(i+1)%points.length]!,delta=sub(b.entry,a.exit),length=Math.hypot(...delta),tangent=unit(delta);
  if(length>1e-8)segments.push({length,at:d=>({point:add(a.exit,mul(tangent,d)),tangent})});
  if(b.r>0)segments.push({length:b.r*Math.abs(b.turn),at:d=>{
   const angle=b.start+Math.sign(b.turn)*d/b.r;
   return {point:add(b.center,[b.r*Math.cos(angle),b.r*Math.sin(angle)]),tangent:mul([-Math.sin(angle),Math.cos(angle)],Math.sign(b.turn))};
  }});
 }
 const length=segments.reduce((sum,s)=>sum+s.length,0);
 return {length,maxCurvature:Math.max(0,...corners.filter(c=>c.r>0).map(c=>1/c.r)),sample:distance=>{
  let d=mod(distance,length);
  for(const segment of segments){if(d<segment.length)return segment.at(d);d-=segment.length;}
  return segments[0]!.at(0);
 }};
}

import type {WorldModelAnimationRig} from './assistant-world-authority.js';
import type {SampledInstanceMotion} from './world-animation-script.js';
import {compileHumanoidRig} from './humanoid-rig.js';
import {describeHumanoidMotion,sampleRigLandmarks} from './humanoid-motion-reference.js';
import {quatFromEulerYXZDegrees,quatMul,quatRotate,transformOf,transformPoint,type Vec3,type Quat} from './model-transform.js';
export const HUMANOID_WALK_PART_IDS=['LeftUpperLeg','LeftLowerLeg','LeftFoot','RightUpperLeg','RightLowerLeg','RightFoot','LeftUpperArm','LeftLowerArm','RightUpperArm','RightLowerArm'] as const;
type Leg={hipLocal:Vec3;upperLength:number;lowerLength:number;soleLocal:Vec3};
export type HumanoidWalkProfile={version:'humanoid-walk-v1';groundAnchorLocal:Vec3;legs:{Left:Leg;Right:Leg};armsDownPose:Record<string,Vec3>};
export type HumanoidWalkTrack={targetId:string;startTime:number;endTime:number;path:Point[];cornerRadius:number;strideLength:number;stepHeight:number;scale:number;baseYawDegrees:number;profile:HumanoidWalkProfile};
const sides=['Left','Right'] as const;
const vadd=(a:Vec3,b:Vec3):Vec3=>a.map((v,i)=>v+b[i]!) as Vec3;
const vsub=(a:Vec3,b:Vec3):Vec3=>a.map((v,i)=>v-b[i]!) as Vec3;
const vmul=(a:Vec3,s:number):Vec3=>a.map(v=>v*s) as Vec3;
const dot=(a:Vec3,b:Vec3)=>a.reduce((v,x,i)=>v+x*b[i]!,0);
const vcross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=(a:Vec3):Vec3=>vmul(a,1/Math.hypot(...a));
const inverse=(q:Quat):Quat=>[-q[0],-q[1],-q[2],q[3]];
const yawQ=(r:number):Quat=>[0,Math.sin(r/2),0,Math.cos(r/2)];
const validVec=(v:unknown):v is Vec3=>Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100);
const zero=(v:Vec3)=>v.every(n=>Math.abs(n)<1e-8);
const identity=(g:WorldModelAnimationRig['groups'][number])=>zero(g.rotation)&&g.scale.every(n=>Math.abs(n-1)<1e-8)&&validVec(g.position);
/** Strict supported bind: identity humanoid-v1 hierarchy, downward legs and real direct foot geometry. */
export function describeHumanoidWalkProfile(rig:WorldModelAnimationRig):HumanoidWalkProfile|null{
 if(rig.rig?.templateId!=='humanoid'||rig.rig.templateVersion!==1||rig.groups.some(g=>!identity(g)))return null;
 const groups=new Map(rig.groups.map(g=>[g.id,g]));
 if(groups.size!==rig.groups.length)return null;
 const canonical=compileHumanoidRig(rig.rig.parameters);
 if(!canonical.ok)return null;
 // The gait uses canonical shoulder/elbow axes as well as leg axes. Match every
 // template joint and socket to the stored parameters before producing a profile.
 for(const expected of [...canonical.joints,...canonical.sockets]){
  const actual=groups.get(expected.id);
  if(!actual||actual.parent!==expected.parent||actual.position.some((v,i)=>Math.abs(v-expected.position[i]!)>1e-8))return null;
 }
 for(const group of rig.groups){
  const seen=new Set<string>();let id:string|null=group.id;
  while(id!==null){if(seen.has(id)||!groups.has(id))return null;seen.add(id);id=groups.get(id)!.parent;}
 }
 const root=groups.get('Root'),hips=groups.get('Hips');
 if(!root||root.parent!==null||!zero(root.position)||!hips||hips.parent!=='Root'||!zero(hips.position))return null;
 const landmarks=sampleRigLandmarks(rig),legs={} as HumanoidWalkProfile['legs'];
 for(const side of sides){
  const upper=groups.get(side+'UpperLeg'),lower=groups.get(side+'LowerLeg'),foot=groups.get(side+'Foot');
  if(!upper||upper.parent!=='Hips'||!lower||lower.parent!==upper.id||!foot||foot.parent!==lower.id)return null;
  if([lower.position,foot.position].some(p=>Math.abs(p[0])+Math.abs(p[2])>1e-8||p[1]>=-.01))return null;
  const shapes=rig.shapes?.filter(s=>s.parent===foot.id)??[];
  if(!shapes.length)return null;
  const min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];
  for(const shape of shapes){
   if(!validVec(shape.localBounds.min)||!validVec(shape.localBounds.max)||shape.localBounds.min.some((v,i)=>v>=shape.localBounds.max[i]!))return null;
   const transform=shape.localTransform??transformOf(shape);
   if(!validVec(transform.translation)||!validVec(transform.scale)||transform.scale.some(n=>n<=0)||!transform.rotation.every(Number.isFinite))return null;
   // Rotated soles cannot be kept flat by the supported foot orientation contract.
   if(Math.abs(transform.rotation[0])+Math.abs(transform.rotation[1])+Math.abs(transform.rotation[2])>1e-8||Math.abs(Math.abs(transform.rotation[3])-1)>1e-8)return null;
   for(let mask=0;mask<8;mask++){
    const p=transformPoint(transform,[0,1,2].map(i=>(mask&(1<<i))?shape.localBounds.max[i]!:shape.localBounds.min[i]!) as Vec3);
    for(let i=0;i<3;i++){min[i]=Math.min(min[i]!,p[i]!);max[i]=Math.max(max[i]!,p[i]!);}
   }
  }
  legs[side]={hipLocal:landmarks[upper.id]!,upperLength:-lower.position[1],lowerLength:-foot.position[1],soleLocal:[(min[0]+max[0])/2,min[1],(min[2]+max[2])/2]};
 }
 const soles=sides.map(side=>vadd(landmarks[side+'Foot']!,legs[side].soleLocal));
 const profile:HumanoidWalkProfile={version:'humanoid-walk-v1',groundAnchorLocal:vmul(vadd(soles[0]!,soles[1]!),.5),legs,armsDownPose:describeHumanoidMotion(rig)?.armsDownPose??{}};
 if(rig.spatial?.groundAnchorLocal&&rig.spatial.groundAnchorLocal.some((v,i)=>Math.abs(v-profile.groundAnchorLocal[i]!)>1e-6))return null;
 try{
  // Descriptors cross JSON/MCP and are compared exactly with the host snapshot.
  // Keep sub-nanometer arithmetic noise out of that public identity contract.
  const canonical=JSON.parse(JSON.stringify(profile,(_key,value:unknown)=>typeof value==='number'?Math.round(value*1e9)/1e9:value)) as HumanoidWalkProfile;
  checkProfile(canonical);return canonical;
 }catch{return null;}
}
function keys(value:unknown,allowed:string[]):asserts value is Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||allowed.some(k=>!(k in value)))throw new Error('Invalid walk fields');
}
function checkProfile(value:unknown):asserts value is HumanoidWalkProfile{
 keys(value,['version','groundAnchorLocal','legs','armsDownPose']);
 if(value.version!=='humanoid-walk-v1'||!validVec(value.groundAnchorLocal))throw new Error('Invalid walk profile');
 keys(value.legs,['Left','Right']);
 for(const side of sides){
  const leg=value.legs[side];keys(leg,['hipLocal','upperLength','lowerLength','soleLocal']);
  if(!validVec(leg.hipLocal)||!validVec(leg.soleLocal))throw new Error('Invalid leg');
  const u=leg.upperLength,l=leg.lowerLength;
  if(typeof u!=='number'||typeof l!=='number'||!Number.isFinite(u+l)||Math.min(u,l)<.03||Math.max(u,l)>10||u/l<.5||u/l>2||leg.soleLocal[1]>=0||Math.hypot(...leg.soleLocal)>.35*(u+l)||Math.abs(leg.hipLocal[0])>.4*(u+l)||Math.abs(leg.hipLocal[2])>.1*(u+l))throw new Error('Unsupported leg proportions');
 }
 const legs=value.legs as HumanoidWalkProfile['legs'];
 const left=legs.Left,right=legs.Right;
 if(Math.abs((left.upperLength+left.lowerLength)-(right.upperLength+right.lowerLength))>.05*Math.min(left.upperLength+left.lowerLength,right.upperLength+right.lowerLength))throw new Error('Unequal legs');
 const expected=vmul(vadd(vadd(left.hipLocal,[left.soleLocal[0],left.soleLocal[1]-left.upperLength-left.lowerLength,left.soleLocal[2]]),vadd(right.hipLocal,[right.soleLocal[0],right.soleLocal[1]-right.upperLength-right.lowerLength,right.soleLocal[2]])),.5);
 if(expected.some((v,i)=>Math.abs(v-(value.groundAnchorLocal as Vec3)[i]!)>1e-6))throw new Error('Inconsistent ground anchor');
 if(!value.armsDownPose||typeof value.armsDownPose!=='object'||Array.isArray(value.armsDownPose)||Object.entries(value.armsDownPose).some(([id,v])=>!['LeftUpperArm','RightUpperArm'].includes(id)||!validVec(v)))throw new Error('Invalid arm pose');
 const arms=value.armsDownPose as Record<string,Vec3>;
 if(!arms.LeftUpperArm||!arms.RightUpperArm)throw new Error('Missing arms-down reference');
}
export function validateHumanoidWalk(input:unknown,duration:number):HumanoidWalkTrack{
 keys(input,['targetId','startTime','endTime','path','cornerRadius','strideLength','stepHeight','scale','baseYawDegrees','profile']);
 if(typeof input.targetId!=='string'||!input.targetId.trim()||input.targetId.length>256)throw new Error('Invalid walk target');
 for(const k of ['startTime','endTime','cornerRadius','strideLength','stepHeight','scale','baseYawDegrees'])if(typeof input[k]!=='number'||!Number.isFinite(input[k]))throw new Error('Invalid walk number');
 const t=input as unknown as HumanoidWalkTrack;
 if(!Number.isFinite(duration)||duration<=0||t.startTime<0||t.endTime<=t.startTime||t.endTime>duration||t.cornerRadius<1e-5||t.cornerRadius>10000||t.scale<.001||t.scale>1000||t.stepHeight<=0||Math.abs(t.baseYawDegrees)>360000)throw new Error('Invalid walk limits');
 checkProfile(t.profile);
 if(!Array.isArray(t.path)||!t.path.every(p=>Array.isArray(p)&&p.length===2&&p.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=100000)))throw new Error('Invalid walk path');
 const route=roundedWalkPath(t.path,t.cornerRadius),leg=Math.min(...sides.map(s=>t.profile.legs[s].upperLength+t.profile.legs[s].lowerLength))*t.scale;
 if(t.strideLength<=0||t.strideLength>.9*leg||t.stepHeight>.2*leg||route.length/t.strideLength>10000)throw new Error('Unreachable walk settings');
 // Prove reach for every continuous route/gait phase. A finite sample grid can
 // miss a narrow corner, so it cannot establish this contract.
 const stride=route.length/Math.max(1,Math.ceil(route.length/t.strideLength))/t.scale;
 const curvature=route.maxCurvature*t.scale;
 const bounds=sides.map(side=>{
  const limb=t.profile.legs[side],anchor=t.profile.groundAnchorLocal;
  const hipOffset=Math.hypot(limb.hipLocal[0]-anchor[0],limb.hipLocal[2]-anchor[2]);
  const soleOffset=Math.hypot(limb.soleLocal[0],limb.soleLocal[2]);
  // Route distance to the convexly blended plant positions is <= .5 stride.
  // Heading is curvature-Lipschitz; rotation chord <= min(2, angle).
  // The same bound covers the interpolated foot yaw (2b(1-b) <= .5).
  const horizontal=.5*stride+Math.min(2,.5*curvature*stride)*(hipOffset+soleOffset);
  const reach=.985*(limb.upperLength+limb.lowerLength);
  if(horizontal>=reach)throw new Error('Unreachable walk contacts: use a larger corner radius or smaller stride');
  return {limb,minHeight:-limb.soleLocal[1]-limb.hipLocal[1]+Math.sqrt(reach*reach-horizontal*horizontal)};
 });
 const minHeight=Math.min(...bounds.map(b=>b.minHeight));
 for(const {limb} of bounds){
  const maxAnkleHeight=t.stepHeight/t.scale-limb.soleLocal[1]-limb.hipLocal[1];
  if(minHeight-maxAnkleHeight<=Math.abs(limb.upperLength-limb.lowerLength)+1e-4)throw new Error('Unreachable walk contacts: use a larger corner radius, smaller stride or lower step height');
 }
 const result=JSON.parse(JSON.stringify(t)) as HumanoidWalkTrack;
 routeFor(result);return result;
}
/** Quaternion mapping the downward bind bone into a plane with its +X knee hinge. */
function thighRotation(direction:Vec3,pole:Vec3):Quat{
 const x=norm(vcross(pole,direction)),y=vmul(direction,-1);
 // Build from two robust vector alignments rather than Euler angles.
 const fromTo=(a:Vec3,b:Vec3):Quat=>{
  const c=vcross(a,b),w=1+dot(a,b);
  if(w<1e-8)return [1,0,0,0];
  const n=Math.hypot(...c,w);return [c[0]/n,c[1]/n,c[2]/n,w/n];
 };
 const q=fromTo([0,1,0],y),oldX=quatRotate(q,[1,0,0]);
 const angle=Math.atan2(dot(vcross(oldX,x),y),dot(oldX,x));
 return quatMul([y[0]*Math.sin(angle/2),y[1]*Math.sin(angle/2),y[2]*Math.sin(angle/2),Math.cos(angle/2)],q);
}
const routeCache=new WeakMap<HumanoidWalkTrack,{route:ReturnType<typeof roundedWalkPath>;cycles:number;stride:number}>();
function routeFor(t:HumanoidWalkTrack){
 let cached=routeCache.get(t);if(cached)return cached;
 const route=roundedWalkPath(t.path,t.cornerRadius),cycles=Math.max(1,Math.ceil(route.length/t.strideLength));
 cached={route,cycles,stride:route.length/cycles};routeCache.set(t,cached);return cached;
}
export function sampleHumanoidWalk(t:HumanoidWalkTrack,time:number):SampledInstanceMotion|undefined{
 if(!Number.isFinite(time)||time<t.startTime)return undefined;
 const {route,stride}=routeFor(t),distance=mod(Math.min(time,t.endTime)-t.startTime,t.endTime-t.startTime)/(t.endTime-t.startTime)*route.length;
 const current=route.sample(distance);
 const yaw=Math.atan2(current.tangent[0],-current.tangent[1]),c=Math.cos(yaw),s=Math.sin(yaw),scale=t.scale;
 const anchor=t.profile.groundAnchorLocal;
 const root:Point=[current.point[0]-scale*(c*anchor[0]+s*anchor[2]),current.point[1]-scale*(s*anchor[0]-c*anchor[2])];
 const targets=sides.map((side,index)=>{
  const leg=t.profile.legs[side],phaseOffset=index*.5,cycle=distance/stride+phaseOffset,phase=mod(cycle,1),plantDistance=(Math.floor(cycle)-phaseOffset)*stride;
  const plant=(d:number)=>{
   const r=route.sample(d+stride*.3),a=Math.atan2(r.tangent[0],-r.tangent[1]);
   const x=leg.hipLocal[0]+leg.soleLocal[0]-anchor[0],z=leg.hipLocal[2]+leg.soleLocal[2]-anchor[2];
   return {p:[r.point[0]+scale*(Math.cos(a)*x+Math.sin(a)*z),r.point[1]+scale*(Math.sin(a)*x-Math.cos(a)*z)] as Point,yaw:a};
  };
  const old=plant(plantDistance),next=plant(plantDistance+stride),swing=Math.max(0,(phase-.6)/.4),blend=swing*swing*(3-2*swing),footYaw=old.yaw+Math.atan2(Math.sin(next.yaw-old.yaw),Math.cos(next.yaw-old.yaw))*blend;
  const sole=add(mul(old.p,1-blend),mul(next.p,blend)),lift=t.stepHeight*Math.sin(Math.PI*swing)**2;
  const localQ=yawQ(footYaw-yaw),soleOffset=quatRotate(localQ,leg.soleLocal);
  const du=(sole[0]-root[0])/scale,dv=(sole[1]-root[1])/scale;
  const ankle:Vec3=[c*du+s*dv-soleOffset[0],lift/scale-soleOffset[1],s*du-c*dv-soleOffset[2]];
  const horizontal=Math.hypot(ankle[0]-leg.hipLocal[0],ankle[2]-leg.hipLocal[2]),reach=.985*(leg.upperLength+leg.lowerLength);
  if(horizontal>=reach)throw new Error('Walk contact exceeds leg reach');
  return {side,leg,ankle,localQ,stance:phase<.6,plant:Math.floor(cycle),maxHeight:ankle[1]-leg.hipLocal[1]+Math.sqrt(reach*reach-horizontal*horizontal)};
 });
 const height=Math.min(...targets.map(v=>v.maxHeight));
 const partRotations:NonNullable<SampledInstanceMotion['partRotations']>={};
 for(const [index,side] of sides.entries()){
  const phase=2*Math.PI*(distance/stride+index*.5),down=t.profile.armsDownPose[side+'UpperArm']!;
  partRotations[side+'UpperArm']=quatFromEulerYXZDegrees([down[0]+12*Math.sin(phase),down[1],down[2]]);
  partRotations[side+'LowerArm']=quatFromEulerYXZDegrees([0,(index===0?-1:1)*(18+8*Math.cos(phase)),0]);
 }
 for(const {side,leg,ankle,localQ} of targets){
  const delta=vsub(ankle,vadd(leg.hipLocal,[0,height,0])),d=Math.hypot(...delta),u=leg.upperLength,l=leg.lowerLength;
  if(d<=Math.abs(u-l)+1e-5||d>=u+l)throw new Error('Walk contact cannot bend supported knee');
  const direction=norm(delta),forward:Vec3=[0,0,1],pole=norm(vsub(forward,vmul(direction,dot(forward,direction))));
  const along=(u*u+d*d-l*l)/(2*d),perp=Math.sqrt(Math.max(0,u*u-along*along));
  const upper=thighRotation(norm(vadd(vmul(direction,along),vmul(pole,perp))),pole);
  const bend=Math.PI-Math.acos(Math.max(-1,Math.min(1,(u*u+l*l-d*d)/(2*u*l))));
  const lower:Quat=[Math.sin(bend/2),0,0,Math.cos(bend/2)];
  partRotations[side+'UpperLeg']=upper;partRotations[side+'LowerLeg']=lower;
  partRotations[side+'Foot']=quatMul(inverse(quatMul(upper,lower)),localQ);
 }
 const deltaYaw=yaw-t.baseYawDegrees*Math.PI/180;
 return {footContacts:Object.fromEntries(targets.map(t=>[t.side+"Foot",{stance:t.stance,plant:t.plant}])),position:{u:root[0],v:root[1],h:height*scale},rotation:[0,0,Math.sin(deltaYaw/2),Math.cos(deltaYaw/2)],partRotations};
}
