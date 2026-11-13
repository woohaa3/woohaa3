import { expect, it } from "vitest";
import { rotateGroundBoundsQuarterTurn, rotateGroundQuarterTurns, rotateWorldTransformQuarterTurn, rotateWorldQuarterTurn } from "./world-quarter-turn.js";
import { worldModelGroundAnchor } from "./world-animation-spatial.js";
import { quatRotate } from "./model-transform.js";
import { createWorldAnimationScript, executeWorldAnimationScript, sampleWorldAnimationInArea } from "./world-animation-script.js";
import { decodeSceneAreaData } from "./creation-scope-codec.js";
import { planSceneAreaOperation } from "./scene-area-operation-plan.js";
import { SCENE_AREA_PLAN_FIXTURES } from "./scene-area-plan-contract.js";
import type { WorldTransform } from "./shared-world.js";

it("rotates clockwise around the fixed ground anchor and preserves tilt, height and scale", () => {
  const original: WorldTransform = { version: "shared-world-v1", position: { u: 12, v: -3, h: 2 },
    rotation: [Math.sin(0.2), 0, 0, Math.cos(0.2)], scale: 2 };
  const local: [number, number, number] = [2, -1, 3];
  const pivot = worldModelGroundAnchor(local, original);
  const rotated = rotateWorldTransformQuarterTurn(original, pivot);
  expect(worldModelGroundAnchor(local, rotated).u).toBeCloseTo(pivot.u, 12);
  expect(worldModelGroundAnchor(local, rotated).v).toBeCloseTo(pivot.v, 12);
  expect(rotated.position.h).toBe(original.position.h);
  expect(rotated.scale).toBe(original.scale);
  const forward = quatRotate([...rotated.rotation], [1, 0, 0]);
  expect(forward[0]).toBeCloseTo(0);
  expect(forward[1]).toBeCloseTo(-1);
  let restored = original;
  for (let i = 0; i < 4; i++) restored = rotateWorldTransformQuarterTurn(restored, pivot);
  expect(restored.position.u).toBeCloseTo(original.position.u, 12);
  expect(restored.position.v).toBeCloseTo(original.position.v, 12);
  expect(Math.abs(restored.rotation.reduce((sum, value, index) => sum + value * original.rotation[index]!, 0))).toBeCloseTo(1, 12);
});

it("swaps rectangular area dimensions without shifting the center, including four-turn restoration", () => {
  const bounds = { min: { u: 2, v: 4 }, max: { u: 10, v: 8 } };
  expect(rotateGroundBoundsQuarterTurn(bounds)).toEqual({ min: { u: 4, v: 2 }, max: { u: 8, v: 10 } });
  let current = bounds;
  for (let i = 0; i < 4; i++) current = rotateGroundBoundsQuarterTurn(current);
  expect(current).toEqual(bounds);
  expect(rotateGroundQuarterTurns({ u: 8, v: 7 }, { u: 6, v: 6 })).toEqual({ u: 7, v: 4 });
});

it("rotates model and camera animation paths in the same frame without editing their script", () => {
  const script = createWorldAnimationScript({ duration: 4, loop: true, script: `
    motion.instance.tween("i", { property: "position", startTime: 0, endTime: 4, from: [2, 1, 3], to: [4, 3, 5] });
    motion.camera.tween({ cameraId: "c", property: "position", startTime: 0, endTime: 4, from: [2, 1, 8], to: [4, 3, 10] });
    motion.camera.tween({ cameraId: "c", property: "rotation", startTime: 0, endTime: 4, from: [10, 20, 30], to: [20, 30, 40] });
  ` });
  const compiled = executeWorldAnimationScript(script.script, script);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) return;
  const sample = sampleWorldAnimationInArea(compiled.ir, 2, { u: 10, v: 20 }, 1);
  expect(sample.instances.get("i")?.position).toEqual({ u: 12, v: 17, h: 4 });
  expect(sample.cameras.get("c")?.position).toEqual({ u: 12, v: 17, h: 9 });
  const original = sampleWorldAnimationInArea(compiled.ir, 2, { u: 0, v: 0 }).cameras.get("c")!.rotation!;
  expect(sample.cameras.get("c")!.rotation).toEqual(rotateWorldQuarterTurn(original));
  const area = { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "s",
    bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }, animationQuarterTurns: 1, animationScript: script };
  expect(decodeSceneAreaData(area)).toMatchObject({ ok: true, value: { animationQuarterTurns: 1, animationScript: script } });
  expect(decodeSceneAreaData({ ...area, animationQuarterTurns: 4 }).ok).toBe(false);
  expect(decodeSceneAreaData({ ...area, animationQuarterTurns: 0.5 }).ok).toBe(false);
});

it("plans one atomic area rotation with the exact source poses available for undo", () => {
  const fixture = SCENE_AREA_PLAN_FIXTURES.find(item => item.request.intent === "move")!;
  const result = planSceneAreaOperation({ ...fixture.request, intent: "rotate" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const plan = result.plan;
  expect(plan.intent).toBe("rotate");
  expect(plan.commands).toHaveLength(1 + fixture.request.members.instances.length + fixture.request.members.cameras.length);
  const bounds = fixture.request.area.bounds;
  const pivot = { u: (bounds.min.u + bounds.max.u) / 2, v: (bounds.min.v + bounds.max.v) / 2 };
  for (const member of fixture.request.members.instances) {
    expect(plan.commands).toContainEqual({ kind: "set-instance-transform", target: member.identity, expectedVersion: member.version,
      transform: rotateWorldTransformQuarterTurn(member.transform, pivot) });
    expect(plan.inverse).toContainEqual({ kind: "restore-instance", target: member.identity, version: member.version, transform: member.transform });
  }
});
