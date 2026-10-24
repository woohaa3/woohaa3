import { afterEach, expect, it, vi } from "vitest";
import { canonicalFilmSetFields, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, filmSetObjectContainerData, filmSetObjectContainerId } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
import { createDoubleClickHandler } from "./interaction-double-click.js";
import type { InteractionCore } from "./interaction-core.js";

afterEach(() => vi.restoreAllMocks());
it("对象容器双击打开所属片场，避免进入独立空白工作区", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("objects");
  const id = filmSetObjectContainerId("film", "actor");
  canvas.document.nodes = [
    { id: "film", type: "composite-asset", position: { x: 0, y: 0 } },
    { id, type: "composite-asset", position: { x: 400, y: 0 } }
  ];
  canvas.nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "片场", modelItemId: "actor", model: { modelScript: "scene.box({id:'body',size:[1,1,1]});", modelScriptVersion: "woohaa-model-js-v2" }, timeline: { duration: 0, loop: false } })) as never;
  canvas.nodeData[id] = filmSetObjectContainerData("film", "actor");
  vi.spyOn(woohaa3CanvasStore, "getState").mockReturnValue({ ...woohaa3CanvasStore.getState(), canvas });
  const enter = vi.fn(), select = vi.fn(), preventDefault = vi.fn();
  const compositeAssets = new CompositeAssetRegistry();
  compositeAssets.register({ extensionId: "film-set", owner: "film-set", executionKey: () => "", prepare: () => null,
    children: (_canvas, ownerNodeId) => ownerNodeId === "film" ? [{ nodeId: id, ownerNodeId, kind: "container", focusOwner: true }] : [] });
  const core = {
    focusInputBlocked: () => false, canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    options: { onModelFocusIntent: enter, compositeAssets }, model: {}, setSelection: select,
    activeViewport: () => ({ x: 0, y: 0, zoom: 1 }), surfaceSize: () => ({ width: 1000, height: 800 }),
    queryPoint: () => ({ ok: true, value: { kind: "node", nodeId: id } })
  } as unknown as InteractionCore;
  createDoubleClickHandler(core).onDoubleClick({ clientX: 450, clientY: 50, preventDefault } as unknown as MouseEvent);
  expect(enter).toHaveBeenCalledWith({ type: "enter", nodeId: "film", kind: "model" });
  expect(select).toHaveBeenCalledWith(["film"]);
  expect(preventDefault).toHaveBeenCalled();
});
