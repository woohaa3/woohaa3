import { describe, expect, it } from "vitest";
import {
  countWorldAnimationChannels,
  createWorldAnimationScript,
  decodeWorldAnimationScript,
  executeWorldAnimationScript,
  sampleWorldAnimation,
  serializeWorldAnimationScript
} from "./world-animation-script.js";

const SCRIPT = [
  'motion.instance.tween("actor", { property: "position", startTime: 0, endTime: 4, from: [0, 0, 0], to: [4, 2, 0], easing: "linear" });',
  'motion.instance.tween("actor", { property: "rotation", startTime: 0, endTime: 4, from: [0, 0, 0], to: [0, 90, 0], easing: "linear" });',
  'motion.camera.tween({ cameraId: "camera-1", property: "zoom", startTime: 0, endTime: 4, from: [1], to: [3], easing: "linear" });'
].join("\n");

describe("world animation script", () => {
  it("plays sequential tracks by start time instead of future tracks overriding the active segment", () => {
    const compiled = executeWorldAnimationScript([
      'motion.instance.tween("actor", { property: "position", startTime: 2, endTime: 4, from: [2,0,0], to: [4,0,0] });',
      'motion.instance.tween("actor", { property: "position", startTime: 0, endTime: 2, from: [0,0,0], to: [2,0,0] });',
      'motion.camera.tween({ cameraId: "camera", property: "zoom", startTime: 2, endTime: 4, from: [2], to: [4] });',
      'motion.camera.tween({ cameraId: "camera", property: "zoom", startTime: 0, endTime: 2, from: [1], to: [2] });'
    ].join("\n"), { duration: 4, loop: false });
    if (!compiled.ok) throw new Error(compiled.message);
    expect(sampleWorldAnimation(compiled.ir, 1).instances.get("actor")?.position?.u).toBe(1);
    expect(sampleWorldAnimation(compiled.ir, 3).instances.get("actor")?.position?.u).toBe(3);
    expect(sampleWorldAnimation(compiled.ir, 1).cameras.get("camera")?.zoom).toBe(1.5);
    expect(sampleWorldAnimation(compiled.ir, 3).cameras.get("camera")?.zoom).toBe(3);
  });

  it("samples local rig joints independently and round-trips part tracks", () => {
    const compiled = executeWorldAnimationScript([
      'motion.part.tween("actor", "LeftUpperLeg", { property: "rotation", startTime: 0, endTime: 1, from: [-30,0,0], to: [30,0,0] });',
      'motion.part.tween("actor", "LeftUpperLeg", { property: "rotation", startTime: 1, endTime: 2, from: [30,0,0], to: [-30,0,0] });',
      'motion.part.tween("other", "LeftUpperLeg", { property: "rotation", startTime: 1, endTime: 2, from: [0,0,0], to: [60,0,0] });'
    ].join("\n"), { duration: 2, loop: true });
    if (!compiled.ok) throw new Error(compiled.message);
    expect(compiled.ir.partTracks).toHaveLength(3);
    const atStart = sampleWorldAnimation(compiled.ir, 0).instances;
    expect(atStart.get("actor")?.partRotations?.LeftUpperLeg[0]).toBeCloseTo(-Math.sin(Math.PI / 12));
    expect(atStart.get("other")?.partRotations).toEqual({});
    expect(sampleWorldAnimation(compiled.ir, 1).instances.get("actor")?.partRotations?.LeftUpperLeg[0]).toBeCloseTo(Math.sin(Math.PI / 12));
    const again = executeWorldAnimationScript(serializeWorldAnimationScript(compiled.ir), { duration: 2, loop: true });
    expect(again.ok && again.json).toBe(compiled.json);
  });

  it("rejects invalid part targets, channels and numeric arity", () => {
    for (const script of [
      'motion.part.tween("actor", "", { property:"rotation",startTime:0,endTime:1,from:[0,0,0],to:[30,0,0] });',
      'motion.part.tween("actor", "knee", { property:"position",startTime:0,endTime:1,from:[0,0,0],to:[30,0,0] });',
      'motion.part.tween("actor", "knee", { property:"rotation",startTime:0,endTime:1,from:[0,"bad",0,0],to:[30,0,0] });'
    ]) expect(executeWorldAnimationScript(script, { duration: 1, loop: false }).ok).toBe(false);
  });

  it("holds the previous end pose across gaps and accepts reverse-declared joint segments", () => {
    const compiled = executeWorldAnimationScript([
      'motion.part.tween("a","joint",{property:"rotation",startTime:3,endTime:4,from:[30,0,0],to:[60,0,0]});',
      'motion.part.tween("a","joint",{property:"rotation",startTime:0,endTime:1,from:[0,0,0],to:[30,0,0]});'
    ].join("\n"), {duration:4,loop:false});
    if (!compiled.ok) throw new Error(compiled.message);
    const pose = (t:number) => sampleWorldAnimation(compiled.ir,t).instances.get("a")?.partRotations?.joint;
    expect(pose(2)).toEqual(pose(1));
    expect(pose(3.5)?.[0]).toBeCloseTo(Math.sin(Math.PI/8));
  });

  it("compiles deterministically and samples instance and camera motion", () => {
    const compiled = executeWorldAnimationScript(SCRIPT, { duration: 4, loop: false });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.ir.instanceTracks).toHaveLength(2);
    expect(compiled.ir.cameraTracks).toHaveLength(1);

    const atTwo = sampleWorldAnimation(compiled.ir, 2);
    expect(atTwo.instances.get("actor")?.position).toEqual({ u: 2, v: 1, h: 0 });
    expect(atTwo.instances.get("actor")?.rotation).toBeDefined();
    expect(atTwo.cameras.get("camera-1")?.zoom).toBe(2);

    const before = sampleWorldAnimation(compiled.ir, 0);
    expect(before.instances.get("actor")?.position).toEqual({ u: 0, v: 0, h: 0 });
    expect(before.cameras.get("camera-1")?.zoom).toBe(1);
  });

  it("round-trips through serialization without changing the sampled result", () => {
    const compiled = executeWorldAnimationScript(SCRIPT, { duration: 4, loop: false });
    if (!compiled.ok) throw new Error(compiled.message);
    const serialized = serializeWorldAnimationScript(compiled.ir);
    const again = executeWorldAnimationScript(serialized, { duration: 4, loop: false });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.json).toBe(compiled.json);
  });

  it("rejects invalid tracks, unknown properties and nondeterministic scripts", () => {
    expect(executeWorldAnimationScript(
      'motion.instance.tween("actor", { property: "position", startTime: 0, endTime: 9, from: [0, 0, 0], to: [1, 0, 0], easing: "linear" });',
      { duration: 4, loop: false }
    )).toMatchObject({ ok: false, code: "invalid-track" });
    expect(executeWorldAnimationScript(
      'motion.instance.tween("actor", { property: "warp", startTime: 0, endTime: 1, from: [0], to: [1], easing: "linear" });',
      { duration: 4, loop: false }
    )).toMatchObject({ ok: false, code: "invalid-track" });
    expect(executeWorldAnimationScript(
      'motion.instance.tween("actor", { property: "scale", startTime: 0, endTime: 1, from: [Math.random()], to: [2], easing: "linear" });',
      { duration: 4, loop: false }
    )).toMatchObject({ ok: false, code: "non-deterministic" });
    expect(executeWorldAnimationScript("motion.instance.tween(", { duration: 4, loop: false }))
      .toMatchObject({ ok: false, stage: "compile" });
  });

  it("persists and strictly decodes the script definition", () => {
    const script = createWorldAnimationScript({ script: SCRIPT, duration: 4, loop: true });
    expect(decodeWorldAnimationScript(script)).toEqual({ ok: true, value: script });
    expect(decodeWorldAnimationScript({ ...script, scriptVersion: "woohaa-world-animation-js-v1" }).ok).toBe(false);
    expect(decodeWorldAnimationScript({ ...script, duration: 0 }).ok).toBe(false);
    expect(decodeWorldAnimationScript({ ...script, extra: 1 }).ok).toBe(false);
  });
});

it("counts repeated tween segments as one logical target-property track", () => {
  const compiled=executeWorldAnimationScript('for(let i=0;i<360;i++){motion.part.tween("a","knee",{property:"rotation",startTime:i/20,endTime:(i+1)/20,from:[0,0,0],to:[1,0,0]});}',{duration:18,loop:false});
  expect(compiled.ok).toBe(true);
  if(!compiled.ok)throw new Error(compiled.message);
  expect(countWorldAnimationChannels(compiled.ir)).toBe(1);
  const many=executeWorldAnimationScript('for(let i=0;i<257;i++){motion.part.tween("a","joint"+i,{property:"rotation",startTime:0,endTime:1,from:[0,0,0],to:[1,0,0]});}',{duration:1,loop:false});
  expect(many).toMatchObject({ok:false,code:"too-many-tracks"});
});

it("reuses compact cycles with phase offsets, seamless boundaries and end-pose hold", () => {
  const compiled=executeWorldAnimationScript([
    'motion.part.cycle("actor","left",{property:"rotation",startTime:1,endTime:18,period:1,keyframes:[{time:0,value:[-30,0,0]},{time:0.5,value:[30,0,0]},{time:1,value:[-30,0,0]}]});',
    'motion.part.cycle("actor","right",{property:"rotation",startTime:1,endTime:2.25,period:1,phase:0.5,keyframes:[{time:0,value:[-30,0,0]},{time:0.5,value:[30,0,0]},{time:1,value:[-30,0,0]}]});'
  ].join("\n"),{duration:18,loop:true});
  if(!compiled.ok)throw new Error(compiled.message);
  expect(compiled.ir.partTracks).toHaveLength(2);
  expect(countWorldAnimationChannels(compiled.ir)).toBe(2);
  const pose=(t:number,id:string)=>sampleWorldAnimation(compiled.ir,t).instances.get("actor")?.partRotations?.[id];
  expect(pose(0,"left")).toBeUndefined();
  expect(pose(1,"left")?.[0]).toBeCloseTo(-Math.sin(Math.PI/12));
  expect(pose(1,"right")?.[0]).toBeCloseTo(Math.sin(Math.PI/12));
  expect(pose(1.25,"left")?.[0]).toBeCloseTo(0);
  expect(pose(1,"left")).toEqual(pose(18,"left"));
  expect(pose(3,"right")).toEqual(pose(2.25,"right"));
  const again=executeWorldAnimationScript(serializeWorldAnimationScript(compiled.ir),{duration:18,loop:true});
  expect(again.ok && again.json).toBe(compiled.json);
});

it("rejects malformed or discontinuous cycles", () => {
  const valid={property:"rotation",startTime:0,endTime:18,period:1,keyframes:[{time:0,value:[0,0,0]},{time:0.5,value:[30,0,0]},{time:1,value:[0,0,0]}]};
  for(const invalid of [
    {...valid,period:0},{...valid,phase:"bad"},{...valid,unknown:true},
    {...valid,keyframes:[]},{...valid,keyframes:[{time:0.1,value:[0,0,0]},{time:1,value:[0,0,0]}]},
    {...valid,keyframes:[{time:0,value:[0,0,0]},{time:1,value:[30,0,0]}]},
    {...valid,keyframes:[{time:0,value:[0,0,0]},{time:0.5,value:[30,0,0]},{time:0.5,value:[20,0,0]},{time:1,value:[0,0,0]}]},
    {...valid,keyframes:[{time:0,value:[0,"bad",0]},{time:1,value:[0,0,0]}]}
  ]) expect(executeWorldAnimationScript(`motion.part.cycle("a","knee",${JSON.stringify(invalid)});`,{duration:18,loop:false}).ok).toBe(false);
});

it("keeps normalized cycle phases finite for extreme finite periods", () => {
 const result=executeWorldAnimationScript('motion.part.cycle("a","knee",{property:"rotation",startTime:0,endTime:18,period:1e308,phase:9e307,keyframes:[{time:0,value:[0,0,0]},{time:5e307,value:[30,0,0]},{time:1e308,value:[0,0,0]}]});',{duration:18,loop:false});
 if(!result.ok)throw new Error(result.message);
 expect(sampleWorldAnimation(result.ir,1).instances.get("a")?.partRotations?.knee.every(Number.isFinite)).toBe(true);
});

it("matches an expanded 18-second eight-joint gait with compact period sampling", () => {
 const cycleLines:string[]=[],tweenLines:string[]=[];
 for(let joint=0;joint<8;joint++){
  const angle=10+joint,phase=joint%2 ? 0.5 : 0;
  cycleLines.push(`motion.part.cycle("a","joint${joint}",{property:"rotation",startTime:0,endTime:18,period:1,phase:${phase},keyframes:[{time:0,value:[${-angle},0,0]},{time:0.5,value:[${angle},0,0]},{time:1,value:[${-angle},0,0]}],easing:"easeInOut"});`);
  for(let step=0;step<36;step++){
   const from=(step+joint)%2 ? angle : -angle;
   tweenLines.push(`motion.part.tween("a","joint${joint}",{property:"rotation",startTime:${step/2},endTime:${(step+1)/2},from:[${from},0,0],to:[${-from},0,0],easing:"easeInOut"});`);
  }
 }
 const compact=executeWorldAnimationScript(cycleLines.join("\n"),{duration:18,loop:true});
 const expanded=executeWorldAnimationScript(tweenLines.join("\n"),{duration:18,loop:true});
 if(!compact.ok||!expanded.ok)throw new Error("Gaits must compile");
 expect(compact.ir.partTracks).toHaveLength(8);
 expect(expanded.ir.partTracks).toHaveLength(288);
 for(const time of [0,0.125,0.5,0.999,1,7.25,17.875,18]){
  const a=sampleWorldAnimation(compact.ir,time).instances.get("a")!.partRotations!;
  const b=sampleWorldAnimation(expanded.ir,time).instances.get("a")!.partRotations!;
  for(const joint of Object.keys(a))a[joint]!.forEach((v,i)=>expect(v).toBeCloseTo(b[joint]![i]!));
 }
});

it("samples opposite extreme finite keyframe angles without overflow", () => {
 const result=executeWorldAnimationScript('motion.part.cycle("a","knee",{property:"rotation",startTime:0,endTime:1,period:1,keyframes:[{time:0,value:[-1e308,0,0]},{time:0.5,value:[1e308,0,0]},{time:1,value:[-1e308,0,0]}]});',{duration:1,loop:false});
 if(!result.ok)throw new Error(result.message);
 for(const t of [0,0.125,0.25,0.5,0.75,1])expect(sampleWorldAnimation(result.ir,t).instances.get("a")?.partRotations?.knee.every(Number.isFinite)).toBe(true);
});
