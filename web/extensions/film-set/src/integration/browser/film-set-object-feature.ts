/**
 * 片场对象编辑 feature 装配
 * （change: refactor-frontend-file-size；从 `model-editor-plugin.tsx` 拆出以遵守体积守卫）。
 *
 * 创建 `FilmSetObjectSession` 与对象模式手势，绑定权威提交、聚焦开合与画布 reconcile；返回
 * 供宿主注册/回收的闭包。只组合注入的依赖，不直接持有渲染状态。
 */
import type { FilmSetContext as Context } from "./context.js";
import { FilmSetObjectSession } from "../../authoring/browser/object-session.js";
import { readFilmSetContentForSession } from "../../state/browser/object-state.js";
import { createFilmSetObjectGesture } from "../../authoring/browser/film-set-object-gesture.js";
import type { FilmSetItemPatchOp } from "@woohaa3/contracts";
import { filmSetGroupBindingPatchCommand, isFilmSetGroupNode, readFilmSetGroupMarker } from "@woohaa3/contracts";
import type { FilmSetObjectAction } from "../../authoring/browser/object-action.js";

/** 片场对象局部键盘 action（与按钮共用；UI 只调用它，不直接操作手势）。 */

export type { FilmSetObjectAction } from "../../authoring/browser/object-action.js";

export type FilmSetObjectFeature = {
  session: FilmSetObjectSession;
  /** 与画布键盘路由共用同一 action；对象列表也经它做分层 Escape。 */
  action: FilmSetObjectAction;
  dispose(): void;
};

export function installFilmSetObjectFeature(
  ctx: Context,
  isHistoryMode: () => boolean,
  filmSetPreview: Map<string, { itemId: string; transform: import("@woohaa3/contracts").FilmSetLocalTransform }>
): FilmSetObjectFeature {
  const objectSession = new FilmSetObjectSession({
    readContent: (nodeId) => {
      const canvas = ctx.compositeAssets.projectCanvas(ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas());
      return readFilmSetContentForSession(canvas, nodeId);
    },
    isWritable: () => ctx.canvasSession.isWritable() && !isHistoryMode(),
    pausePlayback: () => ctx.canvasRuntime.pauseAnimation?.(),
    // 对象 transform/delete 经现有页面 CanvasEditService 的受保护操作记录（可撤销），
    // 不建独立对象 undo 栈（change: 2026-10-10-improve-film-set-editing-and-inspector，任务 4.4）。
    submitItemOp: ({ nodeId, itemId, op, label }) => submitProtectedItemOp(ctx, nodeId, itemId, op, label)
  });

  const surfaceOf = (): { width: number; height: number } => {
    const surface = ctx.canvasRuntime.controller()?.surface?.() ?? { width: 1, height: 1, pixelRatio: 1 };
    return { width: surface.width, height: surface.height };
  };

  const objectGesture = createFilmSetObjectGesture({
    session: objectSession,
    projection: () => {
      const projection = ctx.canvasRuntime.controller()?.focusProjection?.();
      if (!projection) return null;
      return {
        target: projection.target,
        yaw: projection.yaw,
        pitch: projection.pitch,
        distance: projection.distance,
        flySpeed: 6
      };
    },
    surface: surfaceOf,
    compositionBasis: () => {
      const { nodeId, selectedItemId } = objectSession.getState();
      const entry = nodeId ? ctx.canvasRuntime.queryCompositeAssetItemBounds(nodeId).find(item => item.itemId === selectedItemId) : null;
      return entry && entry.unit > 0 ? { unit: entry.unit, yaw: entry.yaw, center: entry.center, worldToLocal: entry.worldToLocal } : null;
    },
    pick: (point) => {
      const nodeId = objectSession.getState().nodeId;
      if (!nodeId) return null;
      const projection = ctx.canvasRuntime.modelFocusProjection?.();
      if (!projection) return null;
      const surface = surfaceOf();
      const hit = ctx.canvasRuntime.queryCompositeAssetItemPick?.({
        nodeId,
        x: point.x,
        y: point.y,
        width: surface.width,
        height: surface.height,
        projection: {
          target: projection.target,
          yaw: projection.yaw,
          pitch: projection.pitch,
          distance: projection.distance
        }
      });
      return hit?.itemId ?? null;
    },
    hitObjectGizmo: (point) => {
      const editor = ctx.canvasRuntime.modelEditorState?.();
      const projection = ctx.canvasRuntime.modelFocusProjection?.();
      if (!editor || editor.toolMode !== "object" || !projection) return null;
      const result = ctx.canvasRuntime.queryGizmoHit?.({
        kind: "object",
        editor,
        projection,
        surface: surfaceOf(),
        point
      });
      if (!result?.available || !result.handle) return null;
      const handle = result.handle;
      if (handle !== "x" && handle !== "y" && handle !== "z" && handle !== "center" && handle !== "yaw-ring" && handle !== "scale") return null;
      return {
        handle,
        ...(result.yawConstraint ? { yawConstraint: result.yawConstraint } : {}),
        ...(result.layoutId ? { layoutId: result.layoutId } : {}),
        ...(result.constraint ? { direction: result.constraint.direction, worldPerPixel: result.constraint.worldPerPixel } : {})
      };
    },
    nodeId: () => objectSession.getState().nodeId,
    invalidationKey: () => JSON.stringify([ctx.canvasRuntime.runtime()?.generation(), ctx.canvasRuntime.modelFocusMode(), objectSession.selectedItem(),
      (ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas())?.nodeData[objectSession.getState().nodeId ?? ""]]),
    blocked: () => isHistoryMode() || !ctx.canvasSession.isWritable() || ctx.canvasRuntime.animationPlaybackState()?.viewMode === "focus-preview"
  });
  ctx.canvasRuntime.setFilmSetObjectGesture?.(objectGesture.handler);
  // 片场对象局部 keyboard action（change: 2026-10-10-improve-film-set-editing-and-inspector，
  // 任务 4.1）：与删除按钮共用 session action；读取时按当前状态判断，不持久保存 item 快照。
  const objectAction: FilmSetObjectAction = {
    active: () => objectSession.getState().nodeId !== null && !isHistoryMode() && ctx.canvasSession.isWritable(),
    hasSelection: () => objectSession.getState().selectedItemId !== null,
    pending: () => objectSession.getState().pendingItemId !== null,
    deleteSelected: () => {
      // 删除前先取消活动手势（丢弃 preview/释放 capture），并暂停播放，避免旧 pointerup
      // 再次提交半成品变换；清理后仍由会话的 pending 生命周期结算（任务 4.3 / design D4）。
      objectGesture.handler.cancelIfDragging();
      ctx.canvasRuntime.pauseAnimation?.();
      return objectSession.deleteSelected();
    },
    clearSelection: () => {
      if (!objectSession.getState().selectedItemId) return false;
      objectSession.select(null);
      return true;
    },
    cancelGesture: () => {
      // 取消活动对象拖动（丢弃 preview、释放 capture），不提交半成品（design D4）。
      const dragging = objectGesture.handler.cancelIfDragging();
      if (dragging) return true;
      return false;
    }
  };
  ctx.canvasRuntime.setFilmSetObjectAction?.(objectAction);

  const unsubscribeFocus = ctx.canvasRuntime.subscribeModelFocus(() => {
    objectGesture.handler.cancelIfDragging();
    objectSession.setHover(null);
    const candidate = ctx.canvasRuntime.modelFocusProjection()?.nodeId ?? null;
    const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
    const node = candidate ? canvas?.document.nodes.find((entry) => entry.id === candidate) : undefined;
    const isFilmSet = isFilmSetGroupNode(node, canvas?.nodeData?.[candidate ?? ""]);
    if (isFilmSet && candidate && objectSession.getState().nodeId !== candidate) {
      objectSession.enter(candidate);
    }
    if (!isFilmSet && objectSession.getState().nodeId) {
      objectSession.exit();
    }
  });
  let previewNode: string | null = null;
  const unsubscribePreview = objectSession.subscribe(() => {
    if (previewNode) filmSetPreview.delete(previewNode);
    const state = objectSession.getState();
    previewNode = state.nodeId;
    if (state.nodeId && state.selectedItemId && state.preview) filmSetPreview.set(state.nodeId, { itemId: state.selectedItemId, transform: state.preview });
    // 片场对象预览是瞬时态：只请求失效，由唯一帧账本合并提交（design D2）。
    ctx.canvasRuntime.controller()?.invalidate("film-set-object-preview");
  });
  const unsubscribeCanvas = ctx.canvasState.subscribe(() => objectSession.reconcile());
  const unsubscribePermission = ctx.canvasSession.subscribe(() => objectSession.reconcile());
  const unsubscribePlayback = ctx.filmSetPlayback.subscribe(() => {
    if (!ctx.filmSetPlayback.getSnapshot().preview) return;
    objectGesture.handler.cancelIfDragging();
    objectSession.cancelEdit();
    objectSession.setTool("move");
  });
  let runtimeGeneration = ctx.canvasRuntime.runtime()?.generation();
  const unsubscribeRuntime = ctx.canvasRuntime.subscribe(() => {
    const generation = ctx.canvasRuntime.runtime()?.generation();
    if (generation === runtimeGeneration) return;
    runtimeGeneration = generation;
    objectGesture.handler.cancelIfDragging();
    objectSession.cancelEdit();
    objectSession.setTool("move");
  });

  return {
    session: objectSession,
    action: objectAction,
    dispose: () => {
      unsubscribeFocus();
      unsubscribePreview();
      if (previewNode) filmSetPreview.delete(previewNode);
      ctx.canvasRuntime.controller()?.invalidate("film-set-object-dispose");
      unsubscribeCanvas();
      unsubscribePermission();
      unsubscribeRuntime();
      unsubscribePlayback();
      objectGesture.handler.dispose();
      ctx.canvasRuntime.setFilmSetObjectGesture?.(null);
    }
  };
}

/**
 * 把一次对象操作交给页面 CanvasEditService：它用共享 reducer 模拟真实 after，再规划
 * forward/inverse 受保护编辑并提交，committed 后才入页面 journal（任务 4.4 / design D6）。
 * 返回带 `settled` 的回执，供会话区分 pending/committed/rejected。
 */
function submitProtectedItemOp(
  ctx: Context,
  nodeId: string,
  itemId: string,
  op: FilmSetItemPatchOp,
  label: string
): { ok: true; handle: { settled: Promise<{ state: string; error: string | null }> } } | { ok: false; reason: string } {
  if (!ctx.canvasSession.isWritable()) return { ok: false, reason: "当前不可写，无法编辑片场对象" };
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  const group = readFilmSetGroupMarker(canvas?.nodeData[nodeId]);
  if (group) {
    if (itemId === "film-set-ground" && group.ground) {
      if (op.kind === "replace-model") return { ok: false, reason: "地面不支持模型替换" };
      const marker = { ...group };
      if (op.kind === "delete") delete marker.ground;
      else { const t = op.localTransform; marker.ground = { ...group.ground, transform: { x: t.offset.x, y: t.offset.y, z: t.offset.z, yaw: t.yaw, scale: t.scale } }; }
      const settled = ctx.canvasEdit.record([{ type: "nodeData.patch", nodeId, expectedNodeData: { [nodeId]: canvas!.nodeData[nodeId] }, value: { filmSetGroup: marker } as import("@woohaa3/contracts").CanvasNodeData }], label)
        .then(result => result.ok ? { state: "committed", error: null } : { state: "rejected", error: result.reason });
      return { ok: true, handle: { settled } };
    }
    const binding = group.sceneBindings.find(entry => entry.bindingId === itemId);
    if (!binding) return { ok: false, reason: "片场 binding 不存在" };
    if (op.kind === "delete") {
      const marker = { ...group, sceneBindings: group.sceneBindings.filter(entry => entry.bindingId !== itemId), clips: group.clips?.map(clip => ({ ...clip, bindings: clip.bindings?.filter(binding => binding.itemId !== itemId) })) };
      const settled = ctx.canvasEdit.record([{ type: "nodeData.patch", nodeId, expectedNodeData: { [nodeId]: canvas!.nodeData[nodeId] }, value: { filmSetGroup: marker } as import("@woohaa3/contracts").CanvasNodeData }], label)
        .then(result => result.ok ? { state: "committed", error: null } : { state: "rejected", error: result.reason });
      return { ok: true, handle: { settled } };
    }
    if (op.kind !== "transform") return { ok: false, reason: "请直接编辑来源资源卡片以替换内容" };
    const transform = op.localTransform;
    const patch = { transform: { x: transform.offset.x, y: transform.offset.y, z: transform.offset.z, yaw: transform.yaw, scale: transform.scale } };
    const settled = ctx.canvasEdit.record([filmSetGroupBindingPatchCommand({ groupId: nodeId, bindingId: itemId, expectedContentKey: binding.contentKey, patch })], label)
      .then(result => result.ok ? { state: "committed", error: null } : { state: "rejected", error: result.reason });
    return { ok: true, handle: { settled } };
  }
  return { ok: false, reason: "对象编辑仅支持 film-set group，请先迁移旧片场" };
}
