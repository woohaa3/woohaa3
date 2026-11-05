import {expect,it} from "vitest";
import {analyzeWorldAnimationData} from "./world-animation-verification.js";
import {executeWorldAnimationScript} from "./world-animation-script.js";
import type {WorldModelAnimationRig} from "./assistant-world-authority.js";
const transform={version:"shared-world-v1",position:{u:0,v:0,h:0},rotation:[0,0,0,1],scale:1} as const;
const animationRig:WorldModelAnimationRig={rig:null,groups:[],shapes:[{id:"foot",parent:null,position:[0,-1,0],rotation:[0,0,0],scale:[1,1,1],localBounds:{min:[-0.1,-0.1,-0.1],max:[0.1,0.1,0.1]}}],spatial:{forwardLocal:[0,0,1],forwardSource:"humanoid-v1",groundAnchorLocal:[0,-1.1,0],rootToGroundHeightMeters:1.1,anchorSource:"geometry-bounds"}};
function ir(script:string){const result=executeWorldAnimationScript(script,{duration:18,loop:true});if(!result.ok)throw new Error(result.message);return result.ir;}
const area={min:{u:-2,v:-20},max:{u:2,v:20}},origin={u:0,v:0};
it("automatically flags backwards movement and below-ground geometry without rejecting writes",()=>{
 const result=analyzeWorldAnimationData(ir('motion.instance.tween("a",{property:"position",startTime:0,endTime:18,from:[0,0,0],to:[0,1,0]});'),[{instanceId:"a",transform,animationRig}],origin,area);
 expect(result.status).toBe("warnings");
 expect(result.verification).toBe("sampled-data-only");
 expect(result.issues.map(i=>i.code)).toContain("backward-motion");
 expect(result.issues.map(i=>i.code)).toContain("below-ground-bounds");
 expect(result.issues.every(i=>i.times.length<=4)).toBe(true);
});
it("keeps body overflow informational when the stable anchor stays inside",()=>{
 const model={instanceId:"a",transform:{...transform,position:{u:0,v:0,h:1.1}},animationRig};
 const result=analyzeWorldAnimationData(ir('motion.instance.tween("a",{property:"position",startTime:0,endTime:18,from:[0,0,1.1],to:[0,-0.5,1.1]});'),[model],origin,{min:{u:0,v:-1},max:{u:1,v:1}});
 expect(result.status).toBe("clear");
 expect(result.issues).toEqual([]);
 expect(result.bodyOverflowSampleCount).toBeGreaterThan(0);
});
it("samples cycle phases without expanding by playback duration and reports missing models",()=>{
 const cycle=ir('motion.part.cycle("missing","joint",{property:"rotation",startTime:0,endTime:18,period:0.2,keyframes:[{time:0,value:[0,0,0]},{time:0.1,value:[30,0,0]},{time:0.2,value:[0,0,0]}]});');
 const result=analyzeWorldAnimationData(cycle,[],origin,area);
 expect(result.status).toBe("partial");
 expect(result.unavailableTargets).toEqual(["missing"]);
 expect(result.sampleCount).toBeLessThanOrEqual(96);
});

import {describeWorldModelAnimationRig} from "./world-animation-spatial.js";
import {executeModelWithStoredRig} from "./model-executor-v2.js";
import {HUMANOID_REFERENCE_PARAMETERS} from "./humanoid-rig.js";
function humanoid() {
 const stored={profile:"humanoid",templateId:"humanoid",templateVersion:1,parameters:HUMANOID_REFERENCE_PARAMETERS} as const;
 const execution=executeModelWithStoredRig('scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.32,depth:0.24,shape:"box"});scene.box({id:"foot",parent:rig.joint("LeftFoot"),size:[0.2,0.1,0.3]});',"woohaa-model-js-v2",stored);
 if(!execution.ok)throw new Error(execution.message);
 return describeWorldModelAnimationRig(execution.scene.ops,stored);
}
const tween=(part:string,from:number[],to:number[])=>`motion.part.tween("a","${part}",{property:"rotation",startTime:0,endTime:18,from:${JSON.stringify(from)},to:${JSON.stringify(to)}});`;
it("warns separately for axial upper arm and forearm motion even when the body moves",()=>{
 const script=tween("LeftUpperArm",[-25,0,0],[25,0,0])+tween("LeftLowerArm",[-30,0,0],[30,0,0])+tween("Root",[0,0,0],[0,60,0])+'motion.instance.tween("a",{property:"position",startTime:0,endTime:18,from:[0,0,1],to:[0,-4,1]});';
 const result=analyzeWorldAnimationData(ir(script),[{instanceId:"a",transform,animationRig:humanoid()}],origin);
 const twists=result.issues.filter(i=>i.code==="joint-twist-without-swing");
 expect(twists.map(i=>i.detail.jointId).sort()).toEqual(["LeftLowerArm","LeftUpperArm"]);
 for(const issue of twists){expect(issue.detail.rotationRadians).toBeGreaterThan(0.8);expect(issue.detail.endpointDisplacementMeters).toBeLessThan(0.001);}
});
it("accepts lowered shoulder swing and elbow flexion, and static axial posture",()=>{
 for(const script of [tween("LeftUpperArm",[-25,0,-90],[25,0,-90])+tween("LeftLowerArm",[0,0,0],[0,-50,0]),tween("LeftUpperArm",[25,0,0],[25,0,0])]) {
 const result=analyzeWorldAnimationData(ir(script),[{instanceId:"a",transform,animationRig:humanoid()}],origin);
 expect(result.issues.filter(i=>i.code==="joint-twist-without-swing")).toEqual([]);
 }
});
it("does not infer axial warnings for unknown rigs",()=>{
 const rig=humanoid();rig.rig=null;
 const result=analyzeWorldAnimationData(ir(tween("LeftUpperArm",[-25,0,0],[25,0,0])),[{instanceId:"a",transform,animationRig:rig}],origin);
 expect(result.issues.filter(i=>i.code==="joint-twist-without-swing")).toEqual([]);
});

it("does not confuse moving ancestors with motion in a static joint",()=>{
 const script=tween("Root",[0,0,0],[0,60,0])+tween("LeftUpperArm",[25,0,0],[25,0,0]);
 const result=analyzeWorldAnimationData(ir(script),[{instanceId:"a",transform,animationRig:humanoid()}],origin);
 expect(result.issues.filter(i=>i.code==="joint-twist-without-swing")).toEqual([]);
});
it("retains local twist diagnosis under translated rotated and scaled world roots",()=>{
 const moved={...transform,position:{u:6,v:-4,h:3},rotation:[0,1,0,0] as const,scale:3};
 const result=analyzeWorldAnimationData(ir(tween("LeftUpperArm",[-25,0,0],[25,0,0])),[{instanceId:"a",transform:moved,animationRig:humanoid()}],origin);
 expect(result.issues.find(i=>i.code==="joint-twist-without-swing")?.detail.jointId).toBe("LeftUpperArm");
});

it("does not compare a delayed static twist to an invented pre-track identity",()=>{
 const script=tween("LeftUpperArm",[40,0,0],[40,0,0]).replace("startTime:0","startTime:9");
 const result=analyzeWorldAnimationData(ir(script),[{instanceId:"a",transform,animationRig:humanoid()}],origin);
 expect(result.issues.filter(i=>i.code==="joint-twist-without-swing")).toEqual([]);
});
