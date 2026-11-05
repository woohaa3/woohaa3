import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildCanvasRenderScene, createEmptyWoohaa3ServerCanvas, worldToRendererPosition, worldToRendererRotation } from "@woohaa3/contracts";

it("projects canonical world data into the shared Rust scene fixture independently of card layout", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../bevy/tests/fixtures/shared-world/render-scene.json", import.meta.url), "utf8"));
  const instance = fixture.nodes[0].sharedWorldInstance;
  const canvas = createEmptyWoohaa3ServerCanvas("shared-wire");
  canvas.document.nodes.push({ id: "model", type: "model3d", position: { x: 100, y: 200 } });
  canvas.nodeData.model = { sharedWorldInstance: instance };
  const scene = buildCanvasRenderScene({ canvas });
  expect(JSON.parse(JSON.stringify(scene))).toEqual(fixture);
  expect(worldToRendererPosition(instance.transform.position)).toEqual([160, 80, 192]);
  expect(worldToRendererRotation(instance.transform.rotation)).toEqual([0.5, 0.5, -0.5, 0.5]);
  canvas.document.nodes[0]!.position = { x: -20, y: 900 };
  const moved = buildCanvasRenderScene({ canvas, positionOverrides: new Map([["model", { x: 7, y: 8 }]]), modelPlacements: new Map([["model", { offset: { x: 4, y: 5, z: 6 }, yaw: 1, scale: 3 }]]) });
  expect(moved.nodes[0]!.sharedWorldInstance).toEqual(instance);
  canvas.nodeData.model = {};
  expect(buildCanvasRenderScene({ canvas }).nodes[0]!.sharedWorldInstance).toBeUndefined();
  canvas.nodeData.model = { sharedWorldInstance: { ...instance, version: "future" } };
  expect(() => buildCanvasRenderScene({ canvas })).toThrow();
});
