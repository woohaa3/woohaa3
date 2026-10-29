import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { createModelSnapshot } from "./animation-snapshot.js";
import { prepareModelResource } from "./prepared-model.js";
import { buildCanvasRenderScene } from "./render-scene.js";
import { composeFilmSetScene } from "./film-set-composition.js";
import { filmSetLayoutBounds } from "./film-set-layout.js";
import { v2SceneAabb, type SceneV2Op } from "./scene-ir-v2.js";
import { modelAnchor, modelLayoutAabbRelative, filmSetFitFactor, worldToCanvasPoint } from "./model-focus.js";
import { filmSetMediaPlanesForNode } from "./render-scene/film-set-projection.js";
import type { FilmSetContent } from "./film-set-content.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "./domain/core/composite-asset-identity.js";
import { FILM_SET_EXTENSION_ID } from "./film-set-legacy-identity.js";
import type { Vec3 } from "./model-transform.js";

const box: SceneV2Op = { t: "box", id: "body", parent: null, position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material: null, color: "#ffaa33", size: [2, 2, 2] };
const identity = { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
const transforms = [{ offset: { x: -10, y: 0, z: 0 }, scale: 4, yaw: 0.6 }, { offset: { x: 14, y: 5, z: 8 }, scale: 2, yaw: -1 }];
const ops = composeFilmSetScene({ models: transforms.map((_, index) => ({ itemId: String(index), localTransform: identity, ops: [box] })) }).ops;
const content = { schemaVersion: 4, items: transforms.map((localTransform, index) => ({ id: String(index), kind: "model", localTransform })) } as FilmSetContent;

it("layout includes all saved object transforms, and updates without changing resource ops", () => {
  const bounds = filmSetLayoutBounds(ops, content);
  const expected = composeFilmSetScene({ models: transforms.map((localTransform, index) => ({ itemId: String(index), localTransform, ops: [box] })) }).ops;
  expect(bounds).toEqual(v2SceneAabb(expected));
  expect(filmSetLayoutBounds(ops, content)).toBe(bounds);
  const moved = { ...content, items: content.items.map(item => ({ ...item, localTransform: { ...item.localTransform, offset: { ...item.localTransform.offset, x: item.localTransform.offset.x * 3 } } })) };
  expect(filmSetLayoutBounds(ops, moved)).not.toEqual(bounds);
  expect(ops.filter(op => op.t === "group").every(op => op.position[0] === 0)).toBe(true);
});

it.each([0.2, 1, 4, 100])("whole scale %s and extreme offsets keep the complete model projection inside the frame", scale => {
  const bounds = filmSetLayoutBounds(ops, content)!;
  const input = { sceneVersion: "v2", ops, extent: 4, aabb: bounds, placement: { ...identity, scale, yaw: 37 }, filmSetFit: { width: 260, height: 195 } };
  const projected = modelLayoutAabbRelative(input)!;
  expect(projected.max[0] - projected.min[0]).toBeLessThanOrEqual(228.0001);
  expect(projected.max[1] - projected.min[1]).toBeLessThanOrEqual(163.0001);
  const anchor = modelAnchor({ nodeX: 100, nodeY: 200, nodeWidth: 260, nodeHeight: 195, centered: true, relativeAabb: projected, offset: { x: 100, y: -100, z: 0 } });
  // The inverse of the world embedding gives screen x/y, independent of pan/zoom.
  const q = worldPoint(anchor);
  expect(q[0] + projected.min[0]).toBeGreaterThanOrEqual(116 - 1e-5);
  expect(q[0] + projected.max[0]).toBeLessThanOrEqual(344 + 1e-5);
  expect(q[1] - projected.max[1]).toBeGreaterThanOrEqual(216 - 1e-5);
  expect(q[1] - projected.min[1]).toBeLessThanOrEqual(379 + 1e-5);
  expect(filmSetFitFactor(input, input.filmSetFit)).toBeGreaterThan(0);
});
function worldPoint(point: Vec3) { const p = worldToCanvasPoint(point); return [p.x, p.y]; }

it("media items frame the scene but never scale the fit with the object scale", () => {
  // change: 2026-10-11-extract-film-set-extension 回归：媒体是内容局部几何，其世界尺寸
  // = 内容高度 × 共同根 unit（已含 fit）。媒体必须按**基准尺寸**参与 layoutAabb，让纯媒体
  // 片场仍有可用适配基准；但若按对象当前 scale 参与，放大 item 会同时放大 bounds 与缩小
  // fit，两者相消，对象缩放对世界几何不再生效。
  const mediaOnly: FilmSetContent = {
    schemaVersion: 4,
    items: [{ id: "photo", kind: "image", name: "照片", assetId: "a", aspectRatio: 4 / 3, localTransform: { offset: { x: 0, y: 2, z: 0 }, scale: 1, yaw: 0.2 } }] as never
  };
  const base = filmSetLayoutBounds([], mediaOnly, 2);
  expect(base).not.toBeNull();

  const scaled: FilmSetContent = {
    ...mediaOnly,
    items: mediaOnly.items.map(item => ({ ...item, localTransform: { ...(item as any).localTransform, scale: 1.5 } }))
  };
  // 对象缩放 MUST NOT 改变适配基准（bounds 与 fit 保持稳定），否则世界尺寸被抵消。
  expect(filmSetLayoutBounds([], scaled, 2)).toEqual(base);

  // 媒体自身内容高度随 item scale 线性变化；因此世界尺寸真的随对象缩放放大。
  const heightOf = (content: FilmSetContent) =>
    filmSetMediaPlanesForNode({ nodeId: "film", data: { filmSetContent: content } as never, readyPlaneIds: new Set(), contentExtent: 2 })[0]!.height;
  expect(heightOf(scaled) / heightOf(mediaOnly)).toBeCloseTo(1.5, 6);
});

it("scene mapping publishes complete layout bounds while retaining the same model identity", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("film-layout");
  canvas.document.nodes = [{ id: "film", type: COMPOSITE_ASSET_NODE_TYPE, position: { x: 100, y: 200 }, width: 260, height: 195 }];
  const saved: FilmSetContent = { ...content, items: content.items.map(item => ({ ...item, name: item.id, kind: "model", model: createModelSnapshot({ modelScript: "scene.box({id:'body'});", modelScriptVersion: "woohaa-model-js-v2" }) })) };
  canvas.nodeData.film = { extensionId: FILM_SET_EXTENSION_ID, filmSetContent: saved } as never;
  const resource = prepareModelResource({ sceneVersion: "woohaa-model-scene-ir-v2", ops });
  const group = migrateFilmSetFixture(canvas, "film");
  const mapped = buildCanvasRenderScene({ canvas: group, modelResources: new Map([["film", resource]]) });
  expect(mapped.managedItemGroups?.[0]?.items.map(item => item.transform.x)).toEqual(transforms.map(transform => transform.offset.x));
  expect(mapped.nodes.find(node => node.id === "film")?.compositeAsset).toBeUndefined();
  expect(mapped.nodes.find(node => node.id === "film")?.model?.resourceKey).toBe(resource.resourceKey);
});
