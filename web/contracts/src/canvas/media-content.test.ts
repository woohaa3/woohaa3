import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
import { expect, it } from "vitest";
import { decodeMediaContentRef } from "./media-content.js";

import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
it("validates an open JSON envelope without importing provider payloads", () => {
  const ref = { providerId: "other.plugin", schemaVersion: 9, payload: { future: [null, 2, "ok"] } };
  expect(decodeMediaContentRef(ref)).toEqual({ ok: true, value: ref });
  for (const value of [{ ...ref, schemaVersion: 0 }, { ...ref, providerId: "../bad" }, { ...ref, payload: { callback() {} } }, { ...ref, payload: { date: new Date() } }, { ...ref, payload: { nan: NaN } }]) expect(decodeMediaContentRef(value).ok).toBe(false);
});
it("rejects invalid envelopes atomically and fences late provider results by all dependency data", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("c", "2026-10-25");
  canvas.document.nodes = [{ id: "image", type: "image", position: { x: 0, y: 0 } }, { id: "source", type: "text", position: { x: 0, y: 0 } }];
  canvas.nodeData = { source: { title: "newer" }, image: {} };
  const result = applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: "image", value: { title: "partial" } }, { type: "nodeData.patch", nodeId: "image", value: { mediaContent: { providerId: "bad", schemaVersion: 0, payload: {} } } }]);
  expect(result.ok).toBe(false); expect(canvas.nodeData.image.title).toBeUndefined();
  expect(applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: "image", value: { outputAssetId: "late" }, expectedNodeData: { source: { title: "older" } } }])).toMatchObject({ ok: false, rejection: { code: "edit-precondition-failed" } });
});
