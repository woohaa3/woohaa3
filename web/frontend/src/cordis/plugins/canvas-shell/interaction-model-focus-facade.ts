/**
 * 模型聚焦对外门面
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，从 `interaction-controller` 拆出以
 * 保持业务单文件 ≤500 行的体积守卫）。
 *
 * 把 `ModelGestureFamily` 的聚焦/编辑能力收敛成一个对外 API：controller 的返回对象与
 * `InteractionCore.model` 都只经此处访问，闭包避免 controller 主体承载全部转发样板。
 */
import type { ModelGestureFamily } from "./model-gesture-family.js";

/**
 * 构造模型聚焦/编辑对外门面；`settleViewportBeforeFocus` 用于进入聚焦时先结算 2D 视口，
 * `releaseOverviewInput` 用于聚焦切换时复位**仅属于 overview** 的 held 输入（Space 临时平移）。
 */
export function createModelFocusFacade(
  model: ModelGestureFamily,
  settleViewportBeforeFocus: () => void,
  releaseOverviewInput: () => void = () => {}
) {
  return {
    focusProjection: () => model.projection(),
    exitModelFocus: () => model.exitModelFocus(),
    isModelFocused: () => model.active,
    enterModelFocusForNode: (nodeId: string) => model.enterModelFocusForNode(nodeId),
    applyFocusTarget: (
      target: Parameters<ModelGestureFamily["applyFocusTarget"]>[0],
      transition: Parameters<ModelGestureFamily["applyFocusTarget"]>[1]
    ) => {
      const entering = target !== null && target.kind !== "document" && !model.active;
      // 聚焦切换（进入 / 离开 / 换节点）复位 overview 的 Space 临时平移：聚焦里的 Space 是
      // 播放或输入，残留闩锁会让返回画布后每次左键按下都变成平移、节点无法点选
      // （change: fix-space-pan-latch-after-focus-exit）。
      releaseOverviewInput();
      const result = model.applyFocusTarget(
        target && (target.kind === "document" ? target : { kind: target.kind, nodeId: target.nodeId, owner: target.owner }),
        transition
      );
      if (result.ok && entering) settleViewportBeforeFocus();
      return result;
    },
    setContentRect: model.setContentRect,
    reframeModelFocus: (nodeId: string) => model.reframeModelFocus(nodeId),
    setFocusedModelView: model.setFocusedModelView,
    zoomFocusedModel: (factor: number) => model.zoomFocusedModel(factor),
    setShotGesture: (handler: Parameters<ModelGestureFamily["setShotGesture"]>[0]) =>
      model.setShotGesture(handler),
    setFocusGesture: (handler: Parameters<ModelGestureFamily["setFocusGesture"]>[0]) =>
      model.setFocusGesture(handler),
    setShotWheel: (handler: Parameters<ModelGestureFamily["setShotWheel"]>[0]) =>
      model.setShotWheel(handler)
  };
}

export type ModelFocusFacade = ReturnType<typeof createModelFocusFacade>;
