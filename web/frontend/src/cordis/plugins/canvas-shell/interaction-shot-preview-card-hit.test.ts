/**
 * 拍摄镜头预览卡片的**内容区**命中必须按卡片本体分派
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D2/D6/D8）。
 *
 * 内容区在 Rust 命中里是独立类别 `shot-preview`（为拍摄播放入口分类），但缩略图占卡片绝大
 * 部分面积，宿主选择/拖动/双击必须和 `node` 一样作用于该卡片。否则按下会穿透成空白框选
 * （清空选择、卡片拖不动），双击会落到空白菜单（进不了所属片场聚焦）。
 */
import { afterEach, expect, it, vi } from "vitest";
import type { PointHit } from "../canvas-runtime/bevy-runtime.js";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import {
  canvasWith, getSession, harness, installSharedSession, runtimeCapturing, submitted
} from "./test-support/controller-harness.js";

installSharedSession();
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); nodeSelectionStore.reset(); });

function setup(hit: PointHit | null) {
  const canvas = canvasWith([{ id: "film", x: 0, y: 0 }, { id: "preview", x: 300, y: 0 }]);
  canvas.document.nodes[0].type = "composite-asset";
  // 迁移后的形态：托管 image/video 节点（`managedBy` + `mediaContent`）。
  canvas.document.nodes[1].type = "image";
  (canvas.nodeData as Record<string, unknown>)["preview"] = {
    managedBy: { schemaVersion: 1, extensionId: "film-set", ownerNodeId: "film", entityId: "clip-1", lifecycle: "owner-managed" },
    mediaContent: { providerId: "film-set.shot", schemaVersion: 1, payload: { filmSetNodeId: "film", clipId: "clip-1" } }
  };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const capture = runtimeCapturing({ pointHit: () => hit });
  const enter = vi.fn();
  const menus: unknown[] = [];
  const controller = installInteractionController({
    canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => capture.runtime, getSession: () => getSession() as never,
    onShotPreviewEnterIntent: enter, onContextMenu: request => menus.push(request)
  });
  cleanups.push(() => controller.dispose());
  controller.flush();
  return { dom, controller, capture, enter, menus };
}

it("内容区按下开始拖拽卡片，而不是穿透成空白框选", () => {
  const f = setup({ kind: "shot-preview", nodeId: "preview" });
  f.dom.fire("pointerdown", { clientX: 320, clientY: 20 });
  f.controller.flush();
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["preview"]);
  f.dom.fire("pointermove", { clientX: 380, clientY: 60 });
  f.controller.flush();
  f.dom.fire("pointerup", { clientX: 380, clientY: 60 });
  f.controller.flush();
  // 拖动提交一次纯移动；若是框选分支，这里既没有命令也会改选择。
  expect(submitted).toEqual([
    expect.objectContaining({ type: "node.update", nodeId: "preview", position: { x: 360, y: 40 } })
  ]);
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["preview"]);
});

it("内容区双击请求进入所属片场并选中该镜头，而不是打开空白菜单", () => {
  const f = setup({ kind: "shot-preview", nodeId: "preview" });
  f.dom.fire("dblclick", { clientX: 320, clientY: 20 });
  f.controller.flush();
  expect(f.enter).toHaveBeenCalledWith({ previewNodeId: "preview", filmSetNodeId: "film", clipId: "clip-1" });
  expect(f.menus).toEqual([]);
  expect(submitted).toEqual([]);
});

it("命中不可用或其它控件类别时不伪造卡片命中", () => {
  const f = setup({ kind: "resize", nodeId: "preview", handle: "se" });
  f.dom.fire("dblclick", { clientX: 320, clientY: 20 });
  f.controller.flush();
  expect(f.enter).not.toHaveBeenCalled();
});
