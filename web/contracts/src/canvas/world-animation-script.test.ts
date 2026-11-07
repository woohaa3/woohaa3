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

  it.each([false, true])("plays successive segments and holds their endpoints regardless of declaration order (reverse=%s)", reverse => {
    const segments = [
      { startTime: 2, endTime: 4, from: [10, 0, 1], to: [20, 0, 1] },
      { startTime: 6, endTime: 8, from: [40, 0, 1], to: [50, 0, 1] }
    ];
    if (reverse) segments.reverse();
    const source = segments.flatMap(segment => [
      `motion.instance.tween("subject", ${JSON.stringify({ ...segment, property: "position" })});`,
      `motion.camera.tween(${JSON.stringify({ ...segment, cameraId: "subject", property: "position" })});`
    ]).join("\n");
    const compiled = executeWorldAnimationScript(source, { duration: 10, loop: false });
    if (!compiled.ok) throw new Error(compiled.message);
    for (const [time, u] of [[0, 10], [2, 10], [3, 15], [4, 20], [5, 20], [6, 40], [7, 45], [8, 50], [10, 50]]) {
      const sample = sampleWorldAnimation(compiled.ir, time!);
      expect(sample.instances.get("subject")?.position).toEqual({ u, v: 0, h: 1 });
      expect(sample.cameras.get("subject")?.position).toEqual({ u, v: 0, h: 1 });
    }
  });

  it("uses the latest starting overlapping segment and keeps other properties and targets independent", () => {
    const compiled = executeWorldAnimationScript([
      'motion.camera.tween({ cameraId: "a", property: "zoom", startTime: 2, endTime: 4, from: [10], to: [20] });',
      'motion.camera.tween({ cameraId: "a", property: "zoom", startTime: 0, endTime: 6, from: [1], to: [7] });',
      'motion.camera.tween({ cameraId: "a", property: "position", startTime: 0, endTime: 6, from: [0, 0, 0], to: [6, 0, 0] });',
      'motion.camera.tween({ cameraId: "b", property: "zoom", startTime: 0, endTime: 6, from: [1], to: [7] });'
    ].join("\n"), { duration: 6, loop: false });
    if (!compiled.ok) throw new Error(compiled.message);
    const atThree = sampleWorldAnimation(compiled.ir, 3);
    expect(atThree.cameras.get("a")).toEqual({ zoom: 15, position: { u: 3, v: 0, h: 0 } });
    expect(atThree.cameras.get("b")?.zoom).toBe(4);
    expect(sampleWorldAnimation(compiled.ir, 5).cameras.get("a")?.zoom).toBe(20);
  });

  it("keeps the last declaration when segments start together, including before their start", () => {
    const compiled = executeWorldAnimationScript([
      'motion.camera.tween({ cameraId: "a", property: "zoom", startTime: 2, endTime: 4, from: [1], to: [3] });',
      'motion.camera.tween({ cameraId: "a", property: "zoom", startTime: 2, endTime: 4, from: [10], to: [20] });'
    ].join("\n"), { duration: 4, loop: false });
    if (!compiled.ok) throw new Error(compiled.message);
    expect(sampleWorldAnimation(compiled.ir, 0).cameras.get("a")?.zoom).toBe(10);
    expect(sampleWorldAnimation(compiled.ir, 3).cameras.get("a")?.zoom).toBe(15);
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
