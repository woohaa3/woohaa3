/**
 * 画布双击分派：片场模型徽标进入聚焦。
 *
 * 只有自带模型聚焦工作区的容器（group + focus kind=model）在双击徽标时进入聚焦；
 * 普通 group 徽标仍只负责选择/拖动，缩放把手不进入聚焦。
 */
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetGroupMarker } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { createDoubleClickHandler } from "./interaction-double-click.js";
import type { InteractionCore } from "./interaction-core.js";

afterEach(() => vi.restoreAllMocks());

function setup(actionId: string, data: unknown) {
  const canvas = createEmptyWoohaa3ServerCanvas("badge-focus");
  canvas.document.nodes = [{ id: "film", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300 }];
  canvas.nodeData.film = data as never;
  vi.spyOn(woohaa3CanvasStore, "getState").mockReturnValue({ ...woohaa3CanvasStore.getState(), canvas });
  const enter = vi.fn(), select = vi.fn(), preventDefault = vi.fn();
  const core = {
    focusInputBlocked: () => false,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    options: { onModelFocusIntent: enter, getRuntime: () => null },
    model: {},
    setSelection: select,
    activeViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    surfaceSize: () => ({ width: 1000, height: 800 }),
    queryPoint: () => ({ ok: true, value: { kind: "node-action", nodeId: "film", actionId, menu: false } })
  } as unknown as InteractionCore;
  const fire = () => createDoubleClickHandler(core).onDoubleClick({ clientX: 200, clientY: 360, preventDefault } as unknown as MouseEvent);
  return { enter, select, preventDefault, fire };
}

it("双击片场模型徽标进入模型聚焦并选中该容器", () => {
  const f = setup("group-badge-select", { filmSetGroup: createFilmSetGroupMarker() });
  f.fire();
  expect(f.enter).toHaveBeenCalledWith({ type: "enter", nodeId: "film", kind: "model" });
  expect(f.select).toHaveBeenCalledWith(["film"]);
  expect(f.preventDefault).toHaveBeenCalled();
});

it("普通 group 徽标双击不进入聚焦", () => {
  const f = setup("group-badge-select", { title: "普通组" });
  f.fire();
  expect(f.enter).not.toHaveBeenCalled();
  expect(f.select).not.toHaveBeenCalled();
});

it("组操作双击不进入聚焦", () => {
  const f = setup("group-collapse", { filmSetGroup: createFilmSetGroupMarker() });
  f.fire();
  expect(f.enter).not.toHaveBeenCalled();
  expect(f.select).not.toHaveBeenCalled();
});
