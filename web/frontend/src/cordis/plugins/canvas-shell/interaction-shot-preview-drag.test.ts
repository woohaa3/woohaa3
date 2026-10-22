/**
 * 拍摄镜头预览拖动不进入片场导入分派（change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 预览卡片只能被移动（位置是它的唯一可变字段），不能作为「复制导入」的来源。因此拖动只含
 * 受保护预览的选择集时，宿主既不显示「放到此处加入片场」提示，也不消费释放：拖动是一次纯移动。
 */
import { afterEach, expect, it, vi } from "vitest";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeDrop } from "../../services/node-drop/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); nodeSelectionStore.reset(); });

function setup(nodeType: string, withOwnership: boolean) {
  const canvas = canvasWith([{ id: "film", x: 0, y: 0 }, { id: "preview", x: 300, y: 0 }]);
  canvas.document.nodes[0].type = "composite-asset";
  canvas.document.nodes[1].type = nodeType;
  if (withOwnership) {
    (canvas.nodeData as Record<string, unknown>)["preview"] = {
      shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "clip-1" }
    };
  }
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const { runtime } = runtimeCapturing({
    pointHit: () => ({ kind: "node", nodeId: "preview" } as never)
  });
  const preview = vi.fn();
  const drop = vi.fn(() => true);
  const unbind = nodeDrop.bind({ preview, drop });
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => runtime, getSession: () => getSession() as never });
  cleanups.push(() => { controller.dispose(); unbind(); });
  return { dom, controller, preview, drop };
}

function drag(dom: ReturnType<typeof harness>, controller: ReturnType<typeof installInteractionController>) {
  dom.fire("pointerdown", { clientX: 320, clientY: 20 });
  dom.fire("pointermove", { clientX: 380, clientY: 60 });
  controller.flush();
}

it("受保护预览的拖动不显示片场导入提示，也不消费释放", () => {
  const f = setup("film-set-shot-preview", true);
  drag(f.dom, f.controller);
  // 拖动期间从未请求接收方预览（否则会显示「放到此处加入片场」）。
  expect(f.preview.mock.calls.every(([drag]) => drag === null)).toBe(true);
  f.dom.fire("pointerup", { clientX: 380, clientY: 60 });
  f.controller.flush();
  // 释放不被 drop 分派消费，拖动按普通移动提交。
  expect(f.drop).not.toHaveBeenCalled();
});

it("普通节点拖动仍进入片场导入分派", () => {
  const f = setup("image", false);
  drag(f.dom, f.controller);
  expect(f.preview.mock.calls.some(([drag]) => drag?.sourceNodeIds.includes("preview"))).toBe(true);
  f.dom.fire("pointerup", { clientX: 380, clientY: 60 });
  f.controller.flush();
  expect(f.drop).toHaveBeenCalledOnce();
});

it("预览类型但缺归属不算受保护，仍按普通节点处理", () => {
  const f = setup("film-set-shot-preview", false);
  drag(f.dom, f.controller);
  expect(f.preview.mock.calls.some(([drag]) => drag?.sourceNodeIds.includes("preview"))).toBe(true);
  f.dom.fire("pointerup", { clientX: 380, clientY: 60 });
  f.controller.flush();
  expect(f.drop).toHaveBeenCalledOnce();
});
