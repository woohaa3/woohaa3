import {expect,it} from "vitest";
import {describeHumanoidMotion,sampleJointEndpoint,sampleRigLandmarks} from "./humanoid-motion-reference.js";
import {describeWorldModelAnimationRig,inspectWorldAnimationModelSample} from "./world-animation-spatial.js";
import {executeModelWithStoredRig} from "./model-executor-v2.js";
import {HUMANOID_REFERENCE_PARAMETERS} from "./humanoid-rig.js";
import {quatFromEulerYXZDegrees} from "./model-transform.js";
function fixture(){
 const rig={profile:"humanoid",templateId:"humanoid",templateVersion:1,parameters:HUMANOID_REFERENCE_PARAMETERS} as const;
 const c=executeModelWithStoredRig('scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.32,depth:0.24,shape:"box"});',"woohaa-model-js-v2",rig);
 if(!c.ok)throw new Error(c.message);
 return describeWorldModelAnimationRig(c.scene.ops,rig);
}
it("describes actual T-pose axes and derived arms-down rotations",()=>{
 const ref=describeHumanoidMotion(fixture())!;
 expect(ref.joints.find(j=>j.jointId==="LeftUpperArm")).toMatchObject({childId:"LeftLowerArm",longAxisLocal:[1,0,0],lengthMeters:0.3});
 expect(ref.joints.find(j=>j.jointId==="RightLowerArm")?.longAxisLocal).toEqual([-1,0,0]);
 expect(ref.armsDownPose.LeftUpperArm?.[2]).toBeCloseTo(-90);
 expect(ref.armsDownPose.RightUpperArm?.[2]).toBeCloseTo(90);
 expect(ref.joints.find(j=>j.jointId==="LeftLowerArm")?.flexionAxisLocal).toEqual([0,-1,0]);
 expect(fixture().motionReference?.profile).toBe("humanoid-v1");
});
it("distinguishes axial twisting from real limb endpoint movement",()=>{
 const rig=fixture();
 const a=sampleJointEndpoint(rig,"LeftUpperArm","LeftLowerArm",{LeftUpperArm:quatFromEulerYXZDegrees([-30,0,0])})!;
 const b=sampleJointEndpoint(rig,"LeftUpperArm","LeftLowerArm",{LeftUpperArm:quatFromEulerYXZDegrees([30,0,0])})!;
 expect(a.endpointInParent).toEqual(b.endpointInParent);
 const swing=sampleJointEndpoint(rig,"LeftUpperArm","LeftLowerArm",{LeftUpperArm:quatFromEulerYXZDegrees([30,0,-90])})!;
 expect(Math.abs(swing.endpointInParent[2])).toBeGreaterThan(0.1);
 const elbow=sampleJointEndpoint(rig,"LeftLowerArm","LeftHand",{LeftLowerArm:quatFromEulerYXZDegrees([0,-30,0])})!;
 expect(elbow.endpointInParent[2]).toBeGreaterThan(0.1);
});
it("samples landmarks through the hierarchy but excludes ancestor motion from joint diagnostics",()=>{
 const rig=fixture(),rotations={Spine:quatFromEulerYXZDegrees([0,90,0]),LeftUpperArm:quatFromEulerYXZDegrees([0,0,-90])};
 expect(sampleRigLandmarks(rig,{}).LeftHand?.[0]).toBeCloseTo(0.85);
 expect(sampleRigLandmarks(rig,{}).LeftHand?.[1]).toBeCloseTo(0.5);
 expect(sampleRigLandmarks(rig,{}).LeftHand?.[2]).toBeCloseTo(0);
 const hand=sampleRigLandmarks(rig,rotations).LeftHand!;
 expect(hand[1]).toBeCloseTo(-0.05);
 const local=sampleJointEndpoint(rig,"LeftUpperArm","LeftLowerArm",rotations)!;
 expect(local.endpointInParent[1]).toBeCloseTo(-0.3);
 expect(local.endpointInParent[2]).toBeCloseTo(0);
 expect(sampleJointEndpoint(rig,"LeftUpperArm","RightHand",{})).toBeNull();
 const unknown={...rig,rig:null};
 expect(describeHumanoidMotion(unknown)).toBeNull();
});

it("exposes parent-relative endpoint vectors in the sampled inspection data",()=>{
 const rig=fixture(),sample={partRotations:{Spine:quatFromEulerYXZDegrees([0,90,0]),LeftUpperArm:quatFromEulerYXZDegrees([20,0,-90])}};
 const r=inspectWorldAnimationModelSample({transform:{version:"shared-world-v1",position:{u:5,v:3,h:1},rotation:[0,0,0,1],scale:2},animationRig:rig},sample,undefined);
 expect(r.jointEndpointsInParent.LeftUpperArm?.[2]).toBeLessThan(-0.1);
 expect(r.landmarksLocal.LeftHand).toBeDefined();
});

it("preserves nonuniform ancestor scaling in landmarks while keeping joint endpoints parent-relative",()=>{
 const rig=fixture();
 rig.groups.find(g=>g.id==="Spine")!.scale=[2,1,1];
 const rotations={LeftUpperArm:quatFromEulerYXZDegrees([0,0,45])};
 const hand=sampleRigLandmarks(rig,rotations).LeftHand!;
 expect(hand[0]).toBeCloseTo(0.6+1.1/Math.sqrt(2));
 expect(hand[1]).toBeCloseTo(0.5+0.55/Math.sqrt(2));
 const endpoint=sampleJointEndpoint(rig,"LeftUpperArm","LeftLowerArm",rotations)!;
 expect(endpoint.endpointInParent[0]).toBeCloseTo(0.3/Math.sqrt(2));
 expect(endpoint.endpointInParent[1]).toBeCloseTo(0.3/Math.sqrt(2));
});
