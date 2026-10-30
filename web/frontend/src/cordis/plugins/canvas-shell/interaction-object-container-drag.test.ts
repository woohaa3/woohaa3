import { migrateFilmSetFixture } from "../../../../../test-support/film-set-groups.js";
import { applyCanvasCommands } from "../../../../../test-support/managed-shot-commands.js";
import { afterEach, expect, it } from "vitest";
import { canonicalFilmSetFields, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, getWoohaa3CanvasNodeAbsolutePosition, type CanvasRenderScene } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";

installSharedSession();
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); nodeSelectionStore.reset(); });
const modelId = "film-model3d-1";

function setup(selected: string[] = [], kind: "node" | "model-preview" = "node") {
  const canvas = createEmptyWoohaa3ServerCanvas("objects");
  canvas.document.nodes = [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }];
  canvas.nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "片场", modelItemId: "actor",
    model: { modelScript: "scene.box({id:'body',size:[1,1,1]});", modelScriptVersion: "woohaa-model-js-v2" }, timeline: { duration: 0, loop: false } })) as never;
  const result = applyCanvasCommands(migrateFilmSetFixture(canvas, "film"), []);
  if (!result.ok) throw new Error(result.rejection.message);
  // 迁移后组贴合唯一成员（成员 + 12 内边距），成员没有可移动的余量，释放会被夹回原位。
  // 本用例守的是「拖动卡片并保持组绑定」，所以把组放大出足够余量（change: canvas-grouping-redesign）。
  const roomy = { ...result.canvas, document: { ...result.canvas.document, nodes: result.canvas.document.nodes.map(node =>
    node.id === "film" ? { ...node, width: 600, height: 500 } : node) } };
  woohaa3CanvasStore.getState().applyRemoteCanvas(roomy);
  const original = roomy.document.nodes.find(node => node.id === modelId)!;
  nodeSelectionStore.setFromRuntime({ nodeIds: selected, primaryNodeId: selected[0] ?? null, editingFocus: false }, new Set(roomy.document.nodes.map(node => node.id)));
  const dom = harness();
  const { runtime, scenes } = runtimeCapturing({ pointHit: () => ({ kind, nodeId: modelId }) });
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => runtime, getSession: () => getSession() as never });
  cleanups.push(() => controller.dispose());
  dom.fire("pointerdown", { clientX: original.position.x + 24, clientY: original.position.y + 24 });
  dom.fire("pointermove", { clientX: original.position.x + 84, clientY: original.position.y + 64 });
  controller.flush();
  const preview = scenes.at(-1) as unknown as CanvasRenderScene;
  expect(preview.nodes.find(node => node.id === modelId)).toMatchObject({ x: original.position.x + 60, y: original.position.y + 40 });
  expect(preview.nodes.some(node => node.id.startsWith("film-object:"))).toBe(false);
  return { dom, controller, original };
}

it.each([
  { selected: [], kind: "node" as const },
  { selected: [modelId], kind: "node" as const },
  { selected: [], kind: "model-preview" as const },
  { selected: [modelId], kind: "model-preview" as const }
])("dragging the live resource card moves the card and preserves its group binding ($kind, $selected)", ({ selected, kind }) => {
  const { dom, controller, original } = setup(selected, kind);
  dom.fire("pointerup", { clientX: original.position.x + 84, clientY: original.position.y + 64 });
  controller.flush();
  const canvas = (woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas)!;
  const moved = canvas.document.nodes.find(node => node.id === modelId)!;
  expect(getWoohaa3CanvasNodeAbsolutePosition(moved, new Map(canvas.document.nodes.map(node => [node.id, node])))).toEqual({ x: original.position.x + 60, y: original.position.y + 40 });
  expect(canvas.nodeData.film.filmSetGroup!.sceneBindings[0]!.transform).toEqual({ x: 0, y: 0, z: 0, yaw: 0, scale: 1 });
  // 释放后父组会贴合成员（change: canvas-grouping-redesign）：组向成员收缩并前移，成员的相对坐标
  // 因此回到内边距 (12,12)，世界坐标已由上面的断言守住。所以不再要求「恰好一条成员 update」，
  // 只要求这次拖动确实提交了命令，且卡片自身没有被摘出组。
  expect(submitted.some(command => command.type === "node.update")).toBe(true);
  expect(moved.parentId).toBe("film");
  expect(nodeSelectionStore.getSnapshot().nodeIds).toContain(modelId);
});

it("cancelling a card drag preserves the resource card and group orchestration", () => {
  const { dom, controller, original } = setup();
  dom.fire("pointercancel", {}); controller.flush();
  const canvas = (woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas)!;
  expect(canvas.document.nodes.find(node => node.id === modelId)?.position).toEqual(original.position);

  expect(submitted).toEqual([]);
});
