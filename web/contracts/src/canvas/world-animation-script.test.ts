import { describe, expect, it } from "vitest";
import {
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
    expect(decodeWorldAnimationScript({ ...script, scriptVersion: "woohaa-world-animation-js-v2" }).ok).toBe(false);
    expect(decodeWorldAnimationScript({ ...script, duration: 0 }).ok).toBe(false);
    expect(decodeWorldAnimationScript({ ...script, extra: 1 }).ok).toBe(false);
  });
});
