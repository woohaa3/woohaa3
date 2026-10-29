import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetGroupMarker } from "@woohaa3/contracts";
import { readFilmSetContentForSession } from "../src/state/browser/object-state.js";

it("reads group objects from current source cards with binding-owned transforms", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("group-session");
  canvas.document.nodes.push(
    { id: "group", type: "group", position: { x: 0, y: 0 } },
    { id: "image", type: "image", parentId: "group", position: { x: 10, y: 20 } },
  );
  canvas.nodeData.group = { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "photo", sourceNodeId: "image", kind: "image", transform: { x: 2, y: 3, z: 4, yaw: 0.5, scale: 2 }, visibility: true, contentKey: "image:first" }] }) };
  canvas.nodeData.image = { title: "Photo", outputAssetId: "first" };
  const before = JSON.stringify(canvas);
  expect(readFilmSetContentForSession(canvas, "group").items[0]).toMatchObject({ id: "photo", kind: "image", assetId: "first", localTransform: { offset: { x: 2, y: 3, z: 4 }, scale: 2, yaw: 0.5 } });
  expect(JSON.stringify(canvas)).toBe(before);
  canvas.nodeData.image.outputAssetId = "second";
  expect(readFilmSetContentForSession(canvas, "group").items[0]).toMatchObject({ assetId: "second" });
  expect(canvas.nodeData.group.filmSetGroup?.sceneBindings[0]?.contentKey).toBe("image:first");
});
