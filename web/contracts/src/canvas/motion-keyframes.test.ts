import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { executeMotionScript } from "./motion-executor.js";
import { evaluateMotionIr } from "./motion-ir.js";
import { PARKOUR_MOTION_SCRIPT } from "./model-api-descriptor-motion.js";
import { quatFromEulerYXZDegrees } from "./model-transform.js";

const context = { duration: 12, partIds: new Set(["root"]), initialCamera: { azimuth: 0, elevation: 0, distance: 8, focusOffset: { x: 0, y: 0, z: 0 } } };
function sample(source: string, time: number) {
  const result = executeMotionScript(source, context);
  expect(result.ok, result.ok ? "" : result.message).toBe(true);
  if (!result.ok) throw new Error(result.message);
  const evaluated = evaluateMotionIr(result.ir, time, context);
  if (!evaluated.ok) throw new Error(evaluated.message);
  return evaluated.model.get("root")!;
}

describe("连续单人物运动", () => {
  it("Rust 验证的共享 fixture 与 JavaScript recorder 的输出一致", () => {
    const result = executeMotionScript(PARKOUR_MOTION_SCRIPT, { duration: 8, partIds: new Set(["root"]) });
    const fixture = JSON.parse(readFileSync(new URL("../../../../bevy/tests/fixtures/parkour-motion.json", import.meta.url), "utf8"));
    expect(result.ok && result.ir).toEqual(fixture);
  });

  it("同一个 root 同时跑、跳和转身，末态保持；seek 结果与历史无关", () => {
    expect(sample(PARKOUR_MOTION_SCRIPT, 2).translation).toEqual([4, 0, 0]);
    expect(sample(PARKOUR_MOTION_SCRIPT, 3).translation).toEqual([6, 3, 0]);
    expect(sample(PARKOUR_MOTION_SCRIPT, 4).translation).toEqual([8, 1, 0]);
    const landing = sample(PARKOUR_MOTION_SCRIPT, 8);
    expect(landing.translation).toEqual([16, 3, 0]);
    expect(landing.rotation[1]).toBeCloseTo(Math.sin(1.57 / 2));
    expect(sample(PARKOUR_MOTION_SCRIPT, 12)).toEqual(landing);
    expect(sample(PARKOUR_MOTION_SCRIPT, 0).translation).toEqual([0, 0, 0]);
  });

  it("同属性相接片段按时间接管，声明顺序不改变结果，不同属性不会互相覆盖", () => {
    const source = `
      motion.model.tween('root', { property:'position', from:[2,0,0], to:[4,1,0], startTime:2, endTime:4 });
      motion.model.tween('root', { property:'scale', from:[1,1,1], to:[2,2,2], startTime:0, endTime:4 });
      motion.model.tween('root', { property:'rotation', from:[0,0,0], to:[0,1,0], startTime:0, endTime:4 });
      motion.model.tween('root', { property:'position', from:[0,0,0], to:[2,0,0], startTime:0, endTime:2 });`;
    expect(sample(source, 2).translation).toEqual([2, 0, 0]);
    const after = sample(source, 10);
    expect(after.translation).toEqual([4, 1, 0]);
    expect(after.scale).toEqual([2, 2, 2]);
    expect(after.rotation[1]).toBeCloseTo(Math.sin(0.5));
  });

  it("平滑插值、三轴旋转遵循 Y-X-Z，区间结束后旧轨道也停住", () => {
    const source = `motion.model.tween('root', {property:'rotation',from:[0,0,0],to:[0.4,0.8,1.2],startTime:0,endTime:4,easing:'smoothstep'});`;
    sample(source, 1).rotation.forEach((v, i) => expect(v).toBeCloseTo(quatFromEulerYXZDegrees([0.4,0.8,1.2].map(a => a * 0.15625 * 180 / Math.PI) as [number,number,number])[i]!));
    for (const declaration of ["rotate('root', {speed:0.3,endTime:2})", "move('root', {speed:1,range:[0,7],endTime:2})", "oscillate('root', {speed:1,amplitude:1,endTime:2})"]) {
      expect(sample(`motion.model.${declaration}`, 10)).toEqual(sample(`motion.model.${declaration}`, 2));
    }
  });

  it.each([
    "motion.model.tween('root',{property:'position',from:[0,0,0],to:[1,0,0],startTime:0,endTime:4});motion.model.move('root',{speed:1,range:[0,1],startTime:2,endTime:5});",
    "motion.model.keyframes('root',{property:'position',frames:[{time:0,value:[0,0,0]},{time:0,value:[1,0,0]}]});",
    "motion.model.keyframes('root',{property:'position',frames:[{time:0,value:[0,0,0]},{time:2,value:[Infinity,0,0]}]});",
    "motion.model.keyframes('root',{property:'scale',frames:[{time:0,value:[1,1,1]},{time:2,value:[-1,1,1]}]});",
    "motion.model.tween('root',{property:'position',from:[0,0],to:[1,0,0]});",
    "motion.model.tween('unknown',{property:'position',from:[0,0,0],to:[1,0,0]});"
  ])("非法动作拒绝并带具体原因：%s", source => {
    const result = executeMotionScript(source, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

});
