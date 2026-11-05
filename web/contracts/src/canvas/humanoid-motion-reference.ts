/** Actual bind-pose kinematics for known humanoids; no semantic guesses for other rigs. */
import type { WorldModelAnimationRig } from "./assistant-world-authority.js";
import {quatMul,quatRotate,transformOf,transformPoint,type Quat,type Vec3} from "./model-transform.js";
import type {SampledInstanceMotion} from "./world-animation-script.js";

export type HumanoidMotionReference={
 profile:"humanoid-v1";
 limbs:Array<{name:"leftArm"|"rightArm"|"leftLeg"|"rightLeg";rootJointId:string;middleJointId:string;endJointId:string}>;
 joints:Array<{jointId:string;childId:string;longAxisLocal:Vec3;lengthMeters:number;flexionAxisLocal:Vec3|null}>;
 armsDownPose:Record<string,Vec3>;
 rotationSemantics:string;
};
const LIMBS:HumanoidMotionReference["limbs"]=[
 {name:"leftArm",rootJointId:"LeftUpperArm",middleJointId:"LeftLowerArm",endJointId:"LeftHand"},
 {name:"rightArm",rootJointId:"RightUpperArm",middleJointId:"RightLowerArm",endJointId:"RightHand"},
 {name:"leftLeg",rootJointId:"LeftUpperLeg",middleJointId:"LeftLowerLeg",endJointId:"LeftFoot"},
 {name:"rightLeg",rootJointId:"RightUpperLeg",middleJointId:"RightLowerLeg",endJointId:"RightFoot"}
];
const normalize=(v:Vec3):Vec3|null=>{
 const length=Math.hypot(...v);
 return length>1e-8 && Number.isFinite(length)?v.map(value=>value/length) as Vec3:null;
};

/** Return one bone endpoint in its joint parent's axes, excluding all ancestor movement. */
export function sampleJointEndpoint(rig:WorldModelAnimationRig,jointId:string,childId:string,rotations:SampledInstanceMotion["partRotations"]={}) {
 const joint=rig.groups.find(group=>group.id===jointId),child=rig.groups.find(group=>group.id===childId);
 if(!joint || !child || child.parent!==jointId)return null;
 const pose=transformOf(joint);
 if(rotations[jointId])pose.rotation=quatMul(pose.rotation,[...rotations[jointId]] as Quat);
 const endpoint=transformPoint(pose,child.position);
 return {endpointInParent:endpoint.map((v,i)=>v-pose.translation[i]!) as Vec3,rotation:pose.rotation};
}

/** Model-local origins of actual groups/sockets, preserving affine hierarchy transforms. */
export function sampleRigLandmarks(rig:WorldModelAnimationRig,rotations:SampledInstanceMotion["partRotations"]={}):Record<string,Vec3>{
 const groups=new Map(rig.groups.map(group=>[group.id,group]));
 const result:Record<string,Vec3>=Object.create(null) as Record<string,Vec3>;
 for(const group of rig.groups){
  let point:Vec3=[0,0,0],id:string|null=group.id;
  while(id!==null){
   const parent=groups.get(id);
   if(!parent)break;
   const pose=transformOf(parent);
   if(rotations[id])pose.rotation=quatMul(pose.rotation,[...rotations[id]] as Quat);
   point=transformPoint(pose,point);
   id=parent.parent;
  }
  result[group.id]=point;
 }
 return result;
}

export function describeHumanoidMotion(rig:WorldModelAnimationRig):HumanoidMotionReference|null{
 if(rig.rig?.templateId!=="humanoid" || rig.rig.templateVersion!==1)return null;
 const groups=new Map(rig.groups.map(group=>[group.id,group]));
 const limbs=LIMBS.filter(limb=>groups.has(limb.rootJointId)&&groups.get(limb.middleJointId)?.parent===limb.rootJointId&&groups.get(limb.endJointId)?.parent===limb.middleJointId);
 if(!limbs.length)return null;
 const joints:HumanoidMotionReference["joints"]=[];
 const armsDownPose:Record<string,Vec3>={};
 for(const limb of limbs){
  for(const [jointId,childId] of [[limb.rootJointId,limb.middleJointId],[limb.middleJointId,limb.endJointId]]){
   const joint=groups.get(jointId!)!,child=groups.get(childId!)!;
   const axis=normalize([...child.position]);
   if(!axis)continue;
   // Cross(long axis, model +Z) is a candidate flexion axis, not a joint limit.
   const flexionAxisLocal=normalize([axis[1],-axis[0],0]);
   const scaled=child.position.map((value,i)=>value*joint.scale[i]!) as Vec3;
   joints.push({jointId:jointId!,childId:childId!,longAxisLocal:axis,lengthMeters:Math.hypot(...scaled),flexionAxisLocal});
  }
  if(limb.name.endsWith("Arm")){
   const root=groups.get(limb.rootJointId)!,child=groups.get(limb.middleJointId)!;
   const pose=transformOf(root);
   const inverse:Quat=[-pose.rotation[0],-pose.rotation[1],-pose.rotation[2],pose.rotation[3]];
   const down=quatRotate(inverse,[0,-1,0]);
   const axis=normalize(child.position.map((v,i)=>v*root.scale[i]!) as Vec3);
   // Known XY bind axes admit a pure Z lowering delta. Omit unsupported configurations.
   if(axis && Math.abs(axis[2])<1e-6 && Math.abs(down[2])<1e-6){
    const z=Math.atan2(axis[0]*down[1]-axis[1]*down[0],axis[0]*down[0]+axis[1]*down[1])*180/Math.PI;
    armsDownPose[limb.rootJointId]=[0,0,z];
   }
  }
 }
 return {profile:"humanoid-v1",limbs,joints,armsDownPose,rotationSemantics:"Local bind quaternion * Euler Y-X-Z delta in degrees. Keep arms-down components in every swing keyframe; separate tracks on one rotation channel replace rather than add. Axes are directions, not joint limits."};
}
