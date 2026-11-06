import {describe,it,expect} from 'vitest';
import {roundedWalkPath} from './world-walk.js';
describe('rounded walk route',()=>{
 it('has continuous constant-distance tangents at corners and loop',()=>{
  const path=roundedWalkPath([[0,0],[4,0],[4,3],[0,3]],.5);
  for(let d=0;d<=path.length;d+=.01){
   const a=path.sample(d-.00001),b=path.sample(d+.00001);
   expect(Math.hypot(a.tangent[0]-b.tangent[0],a.tangent[1]-b.tangent[1])).toBeLessThan(.001);
   expect(Math.hypot(b.point[0]-a.point[0],b.point[1]-a.point[1])).toBeCloseTo(.00002,7);
  }
  expect(path.sample(0)).toEqual(path.sample(path.length));
 });
 it('rejects degenerate, non-finite and crossing routes',()=>{
  for(const points of [[[0,0],[0,0],[1,1]],[[0,0],[1,1],[0,1],[1,0]],[[0,0],[Infinity,0],[1,1]]])expect(()=>roundedWalkPath(points as [number,number][],.2)).toThrow();
 });
});

import {describeHumanoidWalkProfile,sampleHumanoidWalk,validateHumanoidWalk} from './world-walk.js';
import {describeWorldModelAnimationRig} from './world-animation-spatial.js';
import {executeModelWithStoredRig} from './model-executor-v2.js';
import {HUMANOID_REFERENCE_PARAMETERS} from './humanoid-rig.js';
import {sampleRigLandmarks} from './humanoid-motion-reference.js';
import {quatMul,quatRotate,type Quat,type Vec3} from './model-transform.js';
function fixture(){
 const stored={profile:'humanoid',templateId:'humanoid',templateVersion:1,parameters:HUMANOID_REFERENCE_PARAMETERS} as const;
 const c=executeModelWithStoredRig('scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.32,depth:0.24,shape:"box"});scene.box({id:"leftsole",parent:rig.joint("LeftFoot"),size:[0.2,0.1,0.3]});scene.box({id:"rightsole",parent:rig.joint("RightFoot"),size:[0.2,0.1,0.3]});','woohaa-model-js-v2',stored);
 if(!c.ok)throw new Error(c.message);
 return describeWorldModelAnimationRig(c.scene.ops,stored);
}
function track(scale=1,baseYawDegrees=0){return validateHumanoidWalk({targetId:'a',startTime:0,endTime:12,path:[[0,0],[3,0],[3,3],[0,3]],cornerRadius:.6,strideLength:.55*scale,stepHeight:.07*scale,scale,baseYawDegrees,profile:describeHumanoidWalkProfile(fixture())},12);}
function sole(t:ReturnType<typeof track>,time:number,side:'Left'|'Right'){
 const rig=fixture(),s=sampleHumanoidWalk(t,time)!,points=sampleRigLandmarks(rig,s.partRotations);
 let q:Quat=[0,0,0,1];for(const id of ['Root','Hips',side+'UpperLeg',side+'LowerLeg',side+'Foot'])q=quatMul(q,(s.partRotations?.[id]??[0,0,0,1]) as Quat);
 const offset=quatRotate(q,t.profile.legs[side].soleLocal),foot=points[side+'Foot']!;
 const local=foot.map((v,i)=>(v+offset[i]!)*t.scale) as Vec3;
 // World yaw maps model +Z to [sin(yaw),-cos(yaw)].
 const delta=s.rotation!,worldYaw=2*Math.atan2(delta[2],delta[3])+t.baseYawDegrees*Math.PI/180;
 return [s.position!.u+Math.cos(worldYaw)*local[0]+Math.sin(worldYaw)*local[2],s.position!.v+Math.sin(worldYaw)*local[0]-Math.cos(worldYaw)*local[2],s.position!.h+local[1]];
}
it('derives supported real foot soles and fails closed for altered binds',()=>{
 const rig=fixture(),p=describeHumanoidWalkProfile(rig)!;
 expect(p.version).toBe('humanoid-walk-v1');expect(p.legs.Left.soleLocal[1]).toBeCloseTo(-.05);
 rig.groups.find(g=>g.id==='Hips')!.position[0]=.01;expect(describeHumanoidWalkProfile(rig)).toBeNull();
 expect(describeHumanoidWalkProfile({...fixture(),shapes:[]})).toBeNull();
});
it('plants both soles without sliding, bends knees positively, clears swing and loops exactly',()=>{
 const t=track();
 for(let time=0;time<12;time+=.023){
  const s=sampleHumanoidWalk(t,time)!;
  expect(s.partRotations!.LeftLowerLeg![0]).toBeGreaterThan(0);
  for(const side of ['Left','Right'] as const)expect(sole(t,time,side)[2]).toBeGreaterThan(-1e-7);
 }
 // At phase zero left stance spans the first 60% of a cycle.
 const cycle=12/Math.ceil(roundedWalkPath(t.path,t.cornerRadius).length/t.strideLength);
 const a=sole(t,cycle*.1,'Left'),b=sole(t,cycle*.4,'Left');
 for(let i=0;i<3;i++)expect(a[i]).toBeCloseTo(b[i]!,7);
 expect(sole(t,cycle*.8,'Left')[2]).toBeGreaterThan(.02);
 expect(sampleHumanoidWalk(t,12)).toEqual(sampleHumanoidWalk(t,0));
});
it('supports scale and base yaw and rejects malformed or unreachable declarations',()=>{
 const t=track(2,37);
 expect(sole(t,.01,'Left')[2]).toBeCloseTo(0,7);
 expect(()=>validateHumanoidWalk({...t,unknown:1},12)).toThrow();
 expect(()=>validateHumanoidWalk({...t,strideLength:100},12)).toThrow();
 expect(()=>validateHumanoidWalk({...t,profile:{...t.profile,groundAnchorLocal:[0,NaN,0]}},12)).toThrow();
 expect(sampleHumanoidWalk(t,-1)).toBeUndefined();
});

it('matches tangent heading and holds curved-route stance contacts at every step',()=>{
 const t=track(),route=roundedWalkPath(t.path,t.cornerRadius),cycles=Math.ceil(route.length/t.strideLength),cycle=12/cycles;
 for(let n=0;n<cycles;n++)for(const [side,offset] of [['Left',0],['Right',.5]] as const){
  const time=(n+offset+.1)*cycle;if(time+cycle*.3>=12)continue;
  const a=sole(t,time,side),b=sole(t,time+cycle*.3,side);
  for(let i=0;i<3;i++)expect(a[i]).toBeCloseTo(b[i]!,7);
 }
 for(let time=0;time<12;time+=.051){
  const sample=sampleHumanoidWalk(t,time)!,angle=2*Math.atan2(sample.rotation![2],sample.rotation![3]);
  const tangent=route.sample(route.length*time/12).tangent;
  expect(Math.sin(angle)).toBeCloseTo(tangent[0],7);expect(-Math.cos(angle)).toBeCloseTo(tangent[1],7);
 }
});
it('rejects unknown rigs, malformed transforms, missing feet, impossible proportions and bad times',()=>{
 const original=fixture();
 expect(describeHumanoidWalkProfile({...original,rig:null})).toBeNull();
 for(const mutate of [(r:typeof original)=>{r.groups.find(g=>g.id==='LeftLowerLeg')!.position[2]=.1;},(r:typeof original)=>{r.groups[0]!.scale=[2,1,1];},(r:typeof original)=>{r.groups[0]!.parent=r.groups[0]!.id;},(r:typeof original)=>{r.groups.find(g=>g.id==='LeftFoot')!.position[1]=-.001;}]){
  const rig=fixture();mutate(rig);expect(describeHumanoidWalkProfile(rig)).toBeNull();
 }
 const t=track();
 for(const change of [{endTime:13},{startTime:12},{scale:0},{cornerRadius:0},{stepHeight:1},{targetId:''},{path:[[0,0],[1,1],[0,1],[1,0]]}])expect(()=>validateHumanoidWalk({...t,...change},12)).toThrow();
});
it('keeps lowered shoulders while swinging arms contralaterally and flexing both elbows',()=>{
 const t=track(),s=sampleHumanoidWalk(t,.17)!;
 expect(Object.keys(s.partRotations!)).toHaveLength(10);
 const hands=sampleRigLandmarks(fixture(),s.partRotations);
 expect(hands.LeftLowerArm![1]).toBeLessThan(.5);
 expect(Math.hypot(...s.partRotations!.LeftLowerArm!.slice(0,3))).toBeGreaterThan(0);
});
it('uses actual translated and scaled foot geometry and rejects tilted soles',()=>{
 const rig=fixture(),foot=rig.shapes!.find(s=>s.parent==='LeftFoot')!;
 foot.localTransform={translation:[0,-.02,0],rotation:[0,0,0,1],scale:[1,2,1]};
 // Unequal sole heights are unsupported because the stable anchor would differ.
 expect(describeHumanoidWalkProfile(rig)).toBeNull();
 const right=rig.shapes!.find(s=>s.parent==='RightFoot')!;
 right.localTransform=foot.localTransform;
 const changed={...rig,spatial:undefined};
 expect(describeHumanoidWalkProfile(changed)!.legs.Left.soleLocal[1]).toBeCloseTo(-.12);
 right.localTransform={...right.localTransform,rotation:[Math.sin(.1),0,0,Math.cos(.1)]};
 expect(describeHumanoidWalkProfile(changed)).toBeNull();
});
it('rejects the narrow-corner counterexample before runtime reaches an unsampled impossible contact',()=>{
 const profile={version:'humanoid-walk-v1',groundAnchorLocal:[.3,-1.01,0],legs:{},armsDownPose:{LeftUpperArm:[0,0,-90],RightUpperArm:[0,0,90]}} as unknown as import('./world-walk.js').HumanoidWalkProfile;
 for(const [side,sign] of [['Left',1],['Right',-1]] as const)profile.legs[side]={hipLocal:[sign*.38379894976863377,0,0],upperLength:.5,lowerLength:.5,soleLocal:[.3,-.01,0]};
 expect(()=>validateHumanoidWalk({targetId:'a',startTime:0,endTime:1,path:[[0,0],[5.321999365226751,0],[5.321999365226751,5.234977878401806],[0,5.234977878401806]],cornerRadius:.10726755963187212,strideLength:.4463967226736083,stepHeight:.05,scale:1,baseYawDegrees:0,profile},1)).toThrow(/larger corner radius|smaller stride/);
});
it('rejects modified shoulder, elbow and hand chains instead of applying canonical arm axes',()=>{
 for(const mutate of [(r:ReturnType<typeof fixture>)=>{r.groups.find(g=>g.id==='LeftLowerArm')!.position=[0,-.3,0];},(r:ReturnType<typeof fixture>)=>{r.groups.find(g=>g.id==='RightUpperArm')!.parent='Hips';},(r:ReturnType<typeof fixture>)=>{r.groups.find(g=>g.id==='LeftHand')!.position=[0,0,.25];}]){
  const rig=fixture();mutate(rig);expect(describeHumanoidWalkProfile(rig)).toBeNull();
 }
});
it('keeps every densely sampled accepted contact finite throughout varied scales, curvature, proportions and sole offsets',()=>{
 let accepted=0,seed=1907;
 const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
 for(let run=0;run<36;run++){
  const upper=.3+random()*.4,lower=upper*(.65+random()*.6),length=upper+lower,hip=.05+random()*.2;
  const soleOffset:Vec3=[(random()-.5)*.2,-.02-random()*.05,(random()-.5)*.2];
  const profile={version:'humanoid-walk-v1',groundAnchorLocal:[soleOffset[0],soleOffset[1]-length,soleOffset[2]],legs:{Left:{hipLocal:[hip,0,0],upperLength:upper,lowerLength:lower,soleLocal:soleOffset},Right:{hipLocal:[-hip,0,0],upperLength:upper,lowerLength:lower,soleLocal:soleOffset}},armsDownPose:{LeftUpperArm:[0,0,-90],RightUpperArm:[0,0,90]}};
  const scale=.4+random()*2.1,width=1+random()*5,depth=1+random()*5;
  let t:ReturnType<typeof track>;
  try{t=validateHumanoidWalk({targetId:'a',startTime:0,endTime:1,path:[[0,0],[width,0],[width,depth],[0,depth]],cornerRadius:.1+random(),strideLength:(.3+random()*.55)*length*scale,stepHeight:(.04+random()*.1)*length*scale,scale,baseYawDegrees:random()*360,profile},1);}catch{continue;}
  accepted++;
  for(let index=0;index<=1000;index++){
   const s=sampleHumanoidWalk(t,index/1000)!;
   expect(Object.values(s.position!).every(Number.isFinite)).toBe(true);
   expect(Object.values(s.partRotations!).every(q=>q.every(Number.isFinite))).toBe(true);
  }
 }
 expect(accepted).toBeGreaterThan(20);
});
it('canonicalizes floating-point descriptor values for exact host profile matching',()=>{
 const rig=fixture();
 for(const side of ['Left','Right']){
  const shape=rig.shapes!.find(s=>s.parent===side+'Foot')!;
  shape.localTransform={translation:[.1+.01,-.06, .1-.02],rotation:[0,0,0,1],scale:[1,1,1]};
 }
 const p=describeHumanoidWalkProfile({...rig,spatial:undefined})!;
 expect(p.legs.Left.soleLocal).toEqual([.11,-.11,.08]);
 expect(p.groundAnchorLocal).toEqual([.11,-.86,.08]);
 expect(Object.is(p.armsDownPose.LeftUpperArm![0],-0)).toBe(false);
});
