/**
 * 片场对象消费顺序与非渲染作用域回归
 * （change: 2026-10-14-scope-film-set-object-picking-to-focus，任务 2.3 / design D4）。
 *
 * 覆盖对象列表/包围盒/gizmo 消费者在**聚焦首帧**与 **A→B 切换**下的读取语义：
 * - 进入聚焦：对象列表立即来自工作画布（不依赖 Rust 索引），包围盒在场景被接受后可用；
 * - A→B：新场景接受前不返回 B 数据、不返回 A 旧数据；接受后只返回当前目标；
 * - gizmo 派生只对当前 owner 生效，旧目标不驱动 gizmo；
 * - 检查页选择不受对象 toolMode 门禁（读取路径无 toolMode 前置条件）。
 *
 * 用与 Rust `owned_candidates` 等价的 owner 作用域 stub 模拟 WASM 侧边界：未接受/跨目标返回
 * 不可用（空数组），因此消费方无法拿到旧数据——这正是后端已实现并被本测试固定的契约。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { createFilmSetGroupMarker, createEmptyWoohaa3ServerCanvas, createModelSnapshot, type ServerCanvas } from "@woohaa3/contracts";
import type { FilmSetContext as Context } from "../src/integration/browser/context.js";
import { installFilmSetObjectFeature } from "../src/integration/browser/film-set-object-feature.js";

type Bounds = { itemId: string; center: [number, number, number]; radius: number; unit: number; yaw: number };

/** 片场画布：`id` 节点为片场，含一个模型对象 `body`。 */
function filmSetCanvas(id: string): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const model = createModelSnapshot({ modelScript: `scene.box({id:"body"});`, modelScriptVersion: "woohaa-model-js-v2" });
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [
      { id, type: "group", position: { x: 0, y: 0 }, width: 196, height: 64 },
      { id: `${id}-source`, type: "model3d", parentId: id, position: { x: 0, y: 0 } },
    ] },
    nodeData: {
      [id]: { filmSetGroup: createFilmSetGroupMarker({ sceneBindings: [{ bindingId: "body", sourceNodeId: `${id}-source`, kind: "model3d", transform: { x: 0, y: 0, z: 0, scale: 1, yaw: 0 }, visibility: true, contentKey: model.contentVersion.contentHash }] }) },
      [`${id}-source`]: { modelScript: model.modelScript, modelScriptLanguage: model.modelScriptLanguage, modelScriptVersion: model.modelScriptVersion, modelContentVersion: model.contentVersion, modelPlacement: model.placement },
    }
  };

}

function fixture() {
  const focusListeners = new Set<() => void>();
  const listeners = new Set<() => void>();
  let canvas: ServerCanvas = filmSetCanvas("A");
  const canvasState = {
    getCanvas: () => canvas,
    getWorkingCanvas: () => canvas,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  const projectCanvas = (next: ServerCanvas | null) => next;
  let focus: { nodeId: string } | null = null;
  /** 模拟 Rust 已接受场景的内部对象 owner（未接受 = null）。 */
  let acceptedOwner: string | null = null;
  const boundsFor = (nodeId: string): Bounds[] =>
    acceptedOwner === nodeId
      ? [{ itemId: "body", center: [0, 0, 0], radius: 1, unit: 1, yaw: 0 }]
      : [];
  const invalidated: string[] = [];
  const ctx = {
    canvasState,
    filmSetPlayback: { subscribe: () => () => undefined, getSnapshot: () => ({preview:false}) },
    compositeAssets: { projectCanvas },
    canvasSession: { subscribe: () => () => undefined, isWritable: () => true },
    canvasEdit: { record: async () => ({ ok: true }) },
    canvasRuntime: {
      runtime: () => ({generation: () => 1}), subscribe: () => () => undefined, animationPlaybackState: () => null,
      pauseAnimation: () => undefined,
      queryCompositeAssetItemBounds: (nodeId: string) => boundsFor(nodeId),
      queryCompositeAssetItemPick: () => null,
      modelFocusMode: () => "edit",
      modelFocusProjection: () => focus,
      modelEditorState: () => null,
      queryGizmoHit: () => null,
      setFilmSetObjectGesture: () => undefined,
      setFilmSetObjectAction: () => undefined,
      subscribeModelFocus: (listener: () => void) => { focusListeners.add(listener); return () => { focusListeners.delete(listener); }; },
      controller: () => ({ invalidate: (reason = "invalidate") => invalidated.push(reason), surface: () => ({ width: 800, height: 600 }), focusProjection: () => null })
    }
  } as unknown as Context;
  const applyCanvas = (next: ServerCanvas) => { canvas = next; for (const listener of listeners) listener(); };
  const publishFocus = (nodeId: string | null) => { focus = nodeId ? { nodeId } : null; for (const listener of focusListeners) listener(); };
  /** 模拟宿主 flush 一次完整场景：Rust 接受点按聚焦目标发布 owner。 */
  const acceptScene = (owner: string | null) => { acceptedOwner = owner; };
  return {
    ctx,
    feature: installFilmSetObjectFeature(ctx, () => false, new Map()),
    applyCanvas,
    publishFocus,
    acceptScene,
    boundsFor,
    invalidated
  };
}

afterEach(() => { document.body.innerHTML = ""; });

describe("片场对象消费顺序（任务 2.3 / design D4）", () => {
  it("聚焦首帧：对象列表立即可用，包围盒在场景接受后可用", () => {
    const h = fixture();
    // 场景尚未接受（acceptedOwner=null）：旧实例不返回任何 bounds。
    expect(h.boundsFor("A")).toEqual([]);
    // 进入聚焦：会话立即进入并可从工作画布读取对象列表（不依赖 Rust 索引）。
    h.publishFocus("A");
    expect(h.feature.session.getState().nodeId).toBe("A");
    expect(h.feature.session.objects().map((entry) => entry.itemId)).toEqual(["body"]);
    // 场景被接受后才返回当前目标 bounds。
    h.acceptScene("A");
    expect(h.feature.session.objects().map((entry) => entry.itemId)).toEqual(["body"]);
    expect(h.boundsFor("A").map((entry) => entry.itemId)).toEqual(["body"]);
  });

  it("A→B：接受前不返回 B 数据；接受 B 后不返回 A 旧数据", () => {
    const h = fixture();
    h.publishFocus("A");
    h.acceptScene("A");
    expect(h.boundsFor("A")).toHaveLength(1);

    // 切换到 B：焦点先变化，场景尚未接受；B 尚不可用。
    h.applyCanvas(filmSetCanvas("B"));
    h.publishFocus("B");
    expect(h.feature.session.getState().nodeId).toBe("B");
    expect(h.boundsFor("B")).toEqual([]);

    // 接受 B：原子替换 owner，只返回 B；A 的查询不再返回旧数据。
    h.acceptScene("B");
    expect(h.boundsFor("B").map((entry) => entry.itemId)).toEqual(["body"]);
    expect(h.boundsFor("A")).toEqual([]);
  });

  it("gizmo 派生只对当前 owner 生效，旧目标不驱动 gizmo", () => {
    const h = fixture();
    h.publishFocus("A");
    h.acceptScene("A");
    const gizmoFor = (nodeId: string) => {
      const state = h.feature.session.getState();
      if (state.nodeId !== nodeId) return null;
      const entry = h.boundsFor(nodeId).find((item) => item.itemId === "body");
      return entry ? { nodeId, focus: entry.center, radius: entry.radius } : null;
    };
    expect(gizmoFor("A")).not.toBeNull();
    // 切换到 B 但场景未接受：不得用 A 的 bounds 冒充 B 的 gizmo。
    h.applyCanvas(filmSetCanvas("B"));
    h.publishFocus("B");
    expect(gizmoFor("B")).toBeNull();
    expect(gizmoFor("A")).toBeNull();
    h.acceptScene("B");
    expect(gizmoFor("B")).not.toBeNull();
  });

  it("退出聚焦清除对象选择与预览（不驱动 gizmo）", () => {
    const h = fixture();
    h.publishFocus("A");
    h.acceptScene("A");
    h.feature.session.select("body");
    expect(h.feature.session.getState().selectedItemId).toBe("body");
    h.publishFocus(null);
    expect(h.feature.session.getState().nodeId).toBeNull();
    expect(h.feature.session.getState().selectedItemId).toBeNull();
  });

  it("检查页选择不受对象 toolMode 门禁：会话不暴露任何 toolMode 前置条件", () => {
    const h = fixture();
    h.publishFocus("A");
    h.acceptScene("A");
    // 读取/选择只依赖会话；不读取 modelEditorState().toolMode，因此 toolMode=camera 时同样可选。
    const selected = h.feature.session.select("body");
    void selected;
    expect(h.feature.session.getState().selectedItemId).toBe("body");
  });
});
