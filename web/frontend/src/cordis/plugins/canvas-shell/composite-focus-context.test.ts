import { afterEach, expect, it, vi } from "vitest";
import { buildCanvasRenderScene, type CanvasRenderScene, type ModelFocusProjection } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
import { CLOSE_FOCUS_REFERENCE_ACTION, compositeFocusContextIds, projectCompositeFocusContext } from "./composite-focus-context.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { targetFor } from "./test-support/model-focus-harness.js";

installSharedSession();
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(fn => fn()); nodeSelectionStore.reset(); });
const focus: ModelFocusProjection = { version: "woohaa-model-focus-v1", nodeId: "m1", target: [0, 0, 0], yaw: 0, pitch: 0, distance: 5, radius: 1, fov: 0.87 };
function fixture() {
  const canvas = canvasWith([{ id: "m1", x: 200, y: 100 }, { id: "container", x: 200, y: -200 }, { id: "card", x: 12, y: 12 }, { id: "shot", x: 800, y: 100 }, { id: "other", x: 900, y: 100 }]);
  canvas.document.nodes[0].type = canvas.document.nodes[1].type = "composite-asset";
  canvas.document.nodes[1].width = 248; canvas.document.nodes[1].height = 232;
  canvas.document.nodes[2] = { ...canvas.document.nodes[2], parentId: "container", type: "model3d", width: 224, height: 208 };
  canvas.nodeData.m1 = { extensionId: "test" };
  const registry = new CompositeAssetRegistry();
  registry.register({ extensionId: "test", owner: "test", executionKey: () => "", prepare: () => null, closeChild: vi.fn(),
    children: (_, ownerNodeId) => ownerNodeId === "m1" ? [{ nodeId: "container", ownerNodeId, kind: "container", role: "object-entry", closable: true }, { nodeId: "shot", ownerNodeId, kind: "entity", role: "preview" }] : [] });
  const scene = buildCanvasRenderScene({ canvas, selection: { nodes: ["card"], edge: null }, modelFocus: focus,
    surface: { width: 1200, height: 800, pixelRatio: 1, contentRect: { x: 40, y: 60, width: 900, height: 620 } } });
  return { canvas, registry, scene };
}
it("projects legible identity tags without nested cards, preserving canonical render geometry", () => {
  const { canvas, registry, scene } = fixture();
  const original = JSON.stringify(scene.nodes);
  projectCompositeFocusContext(scene, canvas, registry);
  expect(scene.modelFocusContext?.map(n => n.nodeId)).toEqual(["container", "shot"]);
  expect(JSON.stringify(scene.nodes)).toBe(original);
  const [container, shot] = scene.modelFocusContext!;
  expect(container.width).toBeGreaterThanOrEqual(168);
  expect(container.height).toBe(36);
  expect(shot.y).toBe(container.y);
  expect(shot.x).toBeGreaterThan(container.x + container.width);
  expect(scene.nodeActions?.container.actions[0].enabled).toBe(false);
  expect(scene.nodeActions?.shot?.actions.some(a => a.id === CLOSE_FOCUS_REFERENCE_ACTION)).not.toBe(true);
  for (const rect of scene.modelFocusContext!) {
    expect(rect.x).toBeGreaterThanOrEqual(40); expect(rect.y).toBeGreaterThanOrEqual(60);
    expect(rect.x + rect.width).toBeLessThanOrEqual(940); expect(rect.y + rect.height).toBeLessThanOrEqual(680);
  }
});
it("hidden/deleted children disappear immediately, and focus switch/exit exposes no unrelated nodes", () => {
  const { canvas, registry, scene } = fixture();
  canvas.document.nodes = canvas.document.nodes.filter(n => !["container", "card"].includes(n.id));
  expect([...compositeFocusContextIds(canvas, registry, "m1")]).toEqual(["shot"]);
  scene.nodes = scene.nodes.filter(n => !["container", "card"].includes(n.id));
  projectCompositeFocusContext(scene, canvas, registry);
  expect(scene.modelFocusContext?.map(n => n.nodeId)).toEqual(["shot"]);
  expect([...compositeFocusContextIds(canvas, registry, "other")]).toEqual([]);
  scene.modelFocus = { ...focus, nodeId: "other" };
  projectCompositeFocusContext(scene, canvas, registry);
  expect(scene.modelFocusContext).toBeUndefined();
  expect([...compositeFocusContextIds(canvas, registry, null)]).toEqual([]);
  delete scene.modelFocus; delete scene.modelFocusContext;
  projectCompositeFocusContext(scene, canvas, registry);
  expect(scene.modelFocusContext).toBeUndefined();
});
it("focus references consume pointer, double click, context menu and wheel without commands or navigation", () => {
  const { canvas, registry } = fixture();
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness(), capture = runtimeCapturing({ pointHit: () => ({ kind: "node", nodeId: "shot" }) });
  let projection: ModelFocusProjection | null = focus;
  const edits: unknown[] = [], intents: unknown[] = [], menus: unknown[] = [];
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => capture.runtime, getSession: () => getSession() as never, compositeAssets: registry,
    getModelFocus: () => projection, getModelFocusTargets: () => [targetFor(canvas)],
    onModelFocusChange: p => { projection = p; }, onModelFocusIntent: p => intents.push(p), onShotPreviewEnterIntent: p => intents.push(p),
    onContextMenu: p => menus.push(p), onEditCommands: p => { edits.push(p); } });
  disposers.push(() => controller.dispose());
  controller.applyFocusTarget({ nodeId: "m1", kind: "extension", owner: "direct" }, { preserveSession: false });
  controller.flush();
  const context = (capture.scenes.at(-1) as CanvasRenderScene).modelFocusContext![0];
  const point = { clientX: context.x + context.width / 2, clientY: context.y + context.height / 2 };
  const before = JSON.stringify(projection);
  dom.fire("pointerdown", { ...point, button: 2 });
  dom.fire("pointermove", { clientX: point.clientX + 20, clientY: point.clientY + 20, buttons: 2 });
  dom.fire("pointerup", { ...point, button: 2 });
  dom.fire("dblclick", point); dom.fire("contextmenu", point);
  dom.fire("wheel", { ...point, deltaY: 100 });
  dom.fire("gesturestart", { ...point, scale: 1 });
  dom.fire("gesturechange", { ...point, scale: 2 });
  dom.fire("gestureend", point);
  controller.flush();
  expect(JSON.stringify(projection)).toBe(before);
  expect(edits).toEqual([]); expect(intents).toEqual([]); expect(menus).toEqual([]);
});

it("wraps tags at desktop/Pad sizes without shrinking their text", () => {
  const { canvas, registry, scene } = fixture();
  const adapter = registry.resolve(canvas, "m1")!;
  const closeChild = vi.fn(); adapter.closeChild = closeChild;
  scene.surface!.contentRect = { x: 0, y: 0, width: 750, height: 600 };
  for (let i = 0; i < 6; i++) {
    const id = `extra-${i}`;
    canvas.document.nodes.push({ ...canvas.document.nodes[3], id });
    scene.nodes.push({ ...scene.nodes[3], id });
  }
  adapter.children = (_, ownerNodeId) => canvas.document.nodes.filter(n => n.id.startsWith("extra-") || n.id === "container" || n.id === "shot").map(n => ({ nodeId: n.id, ownerNodeId, kind: n.id === "container" ? "container" : "entity", role: n.id === "container" ? "object-entry" : "preview", closable: n.id === "container" }));
  projectCompositeFocusContext(scene, canvas, registry, true);
  expect(scene.modelFocusContext).toHaveLength(8);
  expect(scene.modelFocusContext!.every(r => r.width >= 168 && r.height === 36 && r.x + r.width <= 730)).toBe(true);
  expect(scene.modelFocusContext![4].y).toBeGreaterThan(scene.modelFocusContext![0].y);
  expect(scene.nodeActions?.container.actions[0]).toMatchObject({ id: CLOSE_FOCUS_REFERENCE_ACTION, enabled: true });
});

it("only a Rust close hit can close a managed reference; readonly and stale ownership are inert", () => {
  const { canvas, registry } = fixture();
  const close = vi.fn(); registry.resolve(canvas, "m1")!.closeChild = close;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  let writable = true;
  let hit: any = { kind: "node-action", nodeId: "container", actionId: CLOSE_FOCUS_REFERENCE_ACTION, menu: false };
  const dom = harness(), capture = runtimeCapturing({ pointHit: () => hit });
  let projection: ModelFocusProjection | null = focus;
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => capture.runtime, getSession: () => getSession() as never, compositeAssets: registry, isWritable: () => writable,
    getModelFocus: () => projection, getModelFocusTargets: () => [targetFor(canvas)], onModelFocusChange: p => { projection = p; } });
  disposers.push(() => controller.dispose());
  controller.applyFocusTarget({ nodeId: "m1", kind: "extension", owner: "direct" }, { preserveSession: false });
  controller.flush();
  const rect = (capture.scenes.at(-1) as CanvasRenderScene).modelFocusContext![0];
  const point = { clientX: rect.x + rect.width - 18, clientY: rect.y + 18, button: 0 };
  dom.fire("pointerdown", point); dom.fire("pointerup", point);
  expect(close).toHaveBeenCalledTimes(1);
  expect(close.mock.calls[0][1]).toBe("container");
  expect(registry.closeChild(canvas, "shot")).toBe(false);
  expect(close).toHaveBeenCalledTimes(1);
  hit = { ...hit, nodeId: "shot" };
  dom.fire("pointerdown", point); dom.fire("pointerup", point);
  expect(close).toHaveBeenCalledTimes(1);
  hit = { ...hit, nodeId: "container" };
  writable = false;
  dom.fire("pointerdown", point); dom.fire("pointerup", point);
  expect(close).toHaveBeenCalledTimes(1);
  writable = true; hit = { ...hit, nodeId: "other" };
  dom.fire("pointerdown", point); dom.fire("pointerup", point);
  expect(close).toHaveBeenCalledTimes(1);
  hit = { kind: "node", nodeId: "container" };
  dom.fire("pointerdown", point); dom.fire("pointerup", point);
  expect(close).toHaveBeenCalledTimes(1);
});
