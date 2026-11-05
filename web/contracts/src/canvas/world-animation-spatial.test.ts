import { expect, it } from "vitest";
import { describeWorldModelAnimationRig, inspectWorldAnimationModelSample, worldAnimationSegmentSummary } from "./world-animation-spatial.js";
import { executeModelWithStoredRig } from "./model-executor-v2.js";
import { executeWorldAnimationScript } from "./world-animation-script.js";
import { HUMANOID_REFERENCE_PARAMETERS } from "./humanoid-rig.js";
import type { WorldTransform } from "./shared-world.js";

const transform: WorldTransform = {version:"shared-world-v1",position:{u:0,v:0,h:0},rotation:[0,0,0,1],scale:1};
function fixture() {
  const rig = {profile:"humanoid",templateId:"humanoid",templateVersion:1,parameters:HUMANOID_REFERENCE_PARAMETERS} as const;
  const execution = executeModelWithStoredRig('scene.segment({id:"abdomen",parent:rig.joint("Spine"),from:[0,-0.5,0],to:[0,0,0],width:0.32,depth:0.24,shape:"box"});scene.box({id:"foot",parent:rig.joint("LeftFoot"),position:[0,-0.04,0.08],size:[0.24,0.14,0.38]});',"woohaa-model-js-v2",rig);
  if (!execution.ok) throw new Error(execution.message);
  return describeWorldModelAnimationRig(execution.scene.ops,rig);
}

it("reports humanoid forward and a geometry-derived foot anchor below the hip root", () => {
  const rig = fixture();
  expect(rig.spatial?.forwardLocal).toEqual([0,0,1]);
  expect(rig.spatial?.groundAnchorLocal?.[1]).toBeCloseTo(-0.86);
  expect(rig.spatial?.rootToGroundHeightMeters).toBeCloseTo(0.86);
  expect(rig.spatial?.anchorSource).toBe("foot-geometry-bounds");
});

it("detects backwards translation, root-height error and posed boundary overflow", () => {
  const animationRig = fixture(), model = {transform,animationRig};
  const sample = {position:{u:0,v:0,h:0}},next = {position:{u:0,v:0.1,h:0}};
  const d = inspectWorldAnimationModelSample(model,sample,next,{min:{u:-0.1,v:-0.1},max:{u:0.1,v:0.1}});
  expect(d.heading.status).toBe("backward");
  expect(d.heading.alignment).toBeCloseTo(-1);
  expect(d.ground?.lowestBoundsHeightMeters).toBeCloseTo(-0.86);
  expect(d.ground?.recommendedRootHeightMeters).toBeCloseTo(0.86);
  expect(d.bounds?.outsideSceneArea).toBe(true);
  expect(inspectWorldAnimationModelSample(model,{position:{u:0,v:0,h:0.86}},undefined).ground?.status).toBe("touching");
});

it("composes base yaw, scale and animated joint poses without assuming feet remain fixed", () => {
  const model = {transform:{...transform,scale:2,rotation:[0,0,1,0] as const},animationRig:fixture()};
  const initial = inspectWorldAnimationModelSample(model,undefined,{position:{u:0,v:0.1,h:0}});
  expect(initial.heading.status).toBe("forward");
  expect(initial.ground?.recommendedRootHeightMeters).toBeCloseTo(1.72);
  const moved = inspectWorldAnimationModelSample(model,{partRotations:{LeftUpperLeg:[Math.sin(Math.PI/4),0,0,Math.cos(Math.PI/4)]}},undefined);
  expect(moved.ground?.lowestBoundsHeightMeters).not.toBeCloseTo(initial.ground!.lowestBoundsHeightMeters);
});

it("keeps unknown model forward unknown and handles endpoint backward differences", () => {
  const rig = fixture();
  rig.spatial!.forwardLocal = null;
  rig.spatial!.forwardSource = "unknown";
  expect(inspectWorldAnimationModelSample({transform,animationRig:rig},undefined,{position:{u:0,v:1,h:0}}).heading.status).toBe("unknown");
  expect(inspectWorldAnimationModelSample({transform,animationRig:fixture()},{position:{u:0,v:0,h:0}},{position:{u:0,v:0.1,h:0}},undefined,-0.01).heading.status).toBe("forward");
});

it("counts segments independently of distinct joint and channel count", () => {
  const c = executeWorldAnimationScript('for(let i=0;i<18;i++){motion.part.tween("a","knee",{property:"rotation",startTime:i,endTime:i+1,from:[0,0,0],to:[1,0,0]});}',{duration:18,loop:false});
  if(!c.ok)throw new Error(c.message);
  expect(worldAnimationSegmentSummary(c.ir)).toMatchObject({segmentCount:18,animatedJointCount:1,channelCount:1,logicalTrackCount:1,keyframeCount:36,cycleCount:0,maxChannels:256});
});

it("includes an animated rig root in facing diagnostics", () => {
  const model = {transform,animationRig:fixture()};
  const diagnostics = inspectWorldAnimationModelSample(model,{partRotations:{Root:[0,1,0,0]}},{position:{u:0,v:1,h:0}});
  expect(diagnostics.heading.status).toBe("forward");
});

it("keeps scaled segments centered at their endpoint midpoint", () => {
  const execution = executeModelWithStoredRig('scene.segment({id:"s",from:[1,0,0],to:[3,0,0],width:0.2,depth:0.2,shape:"box",scale:[2,2,2]});',"woohaa-model-js-v2",null);
  if(!execution.ok)throw new Error(execution.message);
  const r = inspectWorldAnimationModelSample({transform,animationRig:describeWorldModelAnimationRig(execution.scene.ops,null)},undefined,undefined);
  expect(r.bounds!.min[0]).toBeCloseTo(0);
  expect(r.bounds!.max[0]).toBeCloseTo(4);
});

it("preserves affine parent scaling when a child rotates", () => {
  const execution = executeModelWithStoredRig('const p=scene.group({id:"p",scale:[2,1,1]});const c=scene.group({id:"c",parent:p});scene.box({id:"b",parent:c,size:[2,2,2]});',"woohaa-model-js-v2",null);
  if(!execution.ok)throw new Error(execution.message);
  const r=inspectWorldAnimationModelSample({transform,animationRig:describeWorldModelAnimationRig(execution.scene.ops,null)},{partRotations:{c:[0,0,Math.sin(Math.PI/8),Math.cos(Math.PI/8)]}},undefined);
  expect(r.bounds!.max[0]).toBeCloseTo(2*Math.SQRT2);
  expect(r.bounds!.max[2]).toBeCloseTo(Math.SQRT2);
});

it("counts authored cycle points and segments without expanding duration", () => {
  const c = executeWorldAnimationScript('motion.part.cycle("a","knee",{property:"rotation",startTime:0,endTime:180,period:1,phase:0.5,keyframes:[{time:0,value:[0,0,0]},{time:0.5,value:[30,0,0]},{time:1,value:[0,0,0]}]}); motion.part.tween("a","knee",{property:"rotation",startTime:180,endTime:181,from:[0,0,0],to:[1,0,0]}); motion.instance.tween("a",{property:"position",startTime:0,endTime:181,from:[0,0,0],to:[1,0,0]});',{duration:181,loop:false});
  if(!c.ok)throw new Error(c.message);
  expect(worldAnimationSegmentSummary(c.ir)).toEqual({maxChannels:256,channelCount:2,logicalTrackCount:2,animatedJointCount:1,segmentCount:4,keyframeCount:7,cycleCount:1,instanceSegmentCount:1,partSegmentCount:3,cameraSegmentCount:0});
});

it("uses a stable ground anchor through instance rotation, scale and translation", async () => {
 const {modelGroundAnchorLocal,worldModelGroundAnchor}=await import("./world-animation-spatial.js");
 const rig=fixture();
 const local=rig.spatial!.groundAnchorLocal!;
 const world=worldModelGroundAnchor(local,{...transform,position:{u:5,v:7,h:3},scale:2,rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2]});
 expect(world.u).toBeCloseTo(5+local[2]*2);
 expect(world.v).toBeCloseTo(7+local[0]*2);
 const unknown=modelGroundAnchorLocal([],null);
 expect(unknown).toBeNull();
});

it("keeps an edge foot anchor inside while the root and body are outside", () => {
 const model={transform:{...transform,position:{u:-0.2,v:0.08,h:0}},animationRig:fixture()};
 const area={min:{u:0,v:0},max:{u:1,v:1}};
 const result=inspectWorldAnimationModelSample(model,undefined,undefined,area);
 expect(result.membership.anchorWorld?.u).toBeCloseTo(0);
 expect(result.membership.anchorWorld?.v).toBeCloseTo(0);
 expect(result.membership.insideSceneArea).toBe(true);
 expect(result.bounds?.outsideSceneArea).toBe(true);
 const moved=inspectWorldAnimationModelSample(model,{position:{u:-0.3,v:0.08,h:0}},undefined,area);
 expect(moved.membership.insideSceneArea).toBe(false);
});
