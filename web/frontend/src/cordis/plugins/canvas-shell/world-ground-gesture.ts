/**
 * 共享世界模型的直接地面拖拽手势（从 `interaction-2d-input` 拆出，保持文件体积守卫）。
 *
 * 指针路径只负责「开始 / 移动 / 释放 / 取消」的编排，具体规则在 `world-ground-drag.ts`：
 * 移动期间只改瞬时 `worldGroundPreviews`，释放时一次 `nodeData.patch` 提交新的地面位置。
 *
 * 一次手势只移动按下的那个实例；多个世界对象的批量地面搬动属于导演区手势，不在这里
 * 静默拖走同选区的其他对象（卡片的 `position` 与世界变换也互不影响）。
 */
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import {
  beginWorldGroundDragMany,
  planWorldGroundMoveWithAnimationParts,
  worldGroundDelta,
  type WorldGroundDragStart
} from "./world-ground-drag.js";
import type { InteractionCore } from "./interaction-core.js";
import { confirmWorldUnbind } from "./world-unbind-confirm.js";

export type WorldGroundGestureFamily = {
  /**
   * 尝试开始世界模型拖动；未命中地面（聚焦/过渡/模态）或节点不是世界实例时返回 `null`。
   */
  begin: (event: PointerEvent, nodeId: string) => WorldGroundDragStart | null;
  /** 指针移动：更新预览；实例被改写或节点消失时取消手势并返回 `false`。 */
  move: (event: PointerEvent) => boolean;
  /** 正常释放：提交一次 `nodeData.patch`；返回是否真的提交了位置。 */
  commit: (event: PointerEvent) => boolean;
  /** 取消：清预览、复位手势，不提交。 */
  cancel: () => void;
};

export function createWorldGroundGestureFamily(core: InteractionCore): WorldGroundGestureFamily {
  const { state, submit, schedule, writable } = core;

  const clearPreview = () => {
    core.clearWorldGroundPreviews();
  };

  const begin = (event: PointerEvent, nodeId: string) => {
    if (!writable()) return null;
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    // 点击已在选区内的世界模型时，整个选区的世界实例一起移动；未选中则只选/拖这一个。
    const selected = state.selected.includes(nodeId) ? state.selected : [nodeId];
    const start = beginWorldGroundDragMany(
      canvas,
      selected,
      nodeId,
      core.queryWorldGround({ x: event.clientX, y: event.clientY })
    );
    if (!start) return null;
    clearPreview();
    // 先落位手势再清 hover：清 hover 会触发一帧，帧里必须已经看到新手势。
    state.gesture = {
      kind: "world-ground",
      pointerId: event.pointerId,
      start,
      delta: { u: 0, v: 0 }
    };
    core.canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    return start;
  };

  const move = (event: PointerEvent) => {
    const gesture = state.gesture;
    if (gesture.kind !== "world-ground" || gesture.pointerId !== event.pointerId) return false;
    const delta = worldGroundDelta(
      gesture.start,
      workingCanvasOf(woohaa3CanvasStore.getState()),
      core.queryWorldGround({ x: event.clientX, y: event.clientY })
    );
    if (!delta) {
      cancel();
      return false;
    }
    gesture.delta = delta;
    // 同一地面增量写到本轮全部目标；预览按 nodeId 复用导演区搬动的同一通道。
    for (const target of gesture.start.targets) core.setWorldGroundPreview(target.nodeId, delta);
    schedule("world-ground-preview");
    return true;
  };

  const applyPlan = (plan: NonNullable<ReturnType<typeof planWorldGroundMoveWithAnimationParts>>) => {
    if (!plan.animated) {
      submit(plan.forward);
      return;
    }
    // 动画拖动同时改 sceneArea；绕开只认识少数 nodeData 字段的编辑计划，直接提交整批，
    // 并用外部撤销条目保证一次撤销能同时恢复基础变换与动画轨道。
    const session = core.options.getSession();
    if (!session) {
      submit(plan.forward);
      return;
    }
    const commandId = `web-world-ground-animation-${core.nextSeq()}`;
    const result = session.submitCommands(plan.forward, commandId);
    if (!result.ok) {
      schedule("world-ground-preview");
      return;
    }
    const replay = (commands: typeof plan.forward) => {
      const id = `web-world-ground-animation-${core.nextSeq()}`;
      const replayResult = session.submitCommands(commands, id);
      if (!replayResult.ok) return Promise.resolve({ ok: false as const, reason: replayResult.reason });
      return replayResult.handle.settled.then(settled => settled.state === "committed"
        ? { ok: true as const }
        : { ok: false as const, reason: settled.error ?? "移动未提交" });
    };
    core.options.recordExternal?.({
      id: commandId,
      label: "移动世界对象",
      undo: () => replay(plan.inverse),
      redo: () => replay(plan.forward)
    });
  };

  const commit = (event: PointerEvent) => {
    const gesture = state.gesture;
    if (gesture.kind !== "world-ground") return false;
    // 释放那一帧可能没有 pointermove：用释放点重算增量。拿不到地面点或实例已被
    // 外部改写时 `worldGroundDelta` 返回 null——此时必须放弃，不能用上一帧增量覆盖
    // 别人刚写入的变换。
    const delta = gesture.pointerId === event.pointerId
      ? worldGroundDelta(
          gesture.start,
          workingCanvasOf(woohaa3CanvasStore.getState()),
          core.queryWorldGround({ x: event.clientX, y: event.clientY })
        )
      : null;
    if (!delta) {
      clearPreview();
      schedule("world-ground-preview");
      return false;
    }
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const times = core.options.getWorldAnimationTimes?.();
    const plan = planWorldGroundMoveWithAnimationParts(canvas, gesture.start, delta, times);
    if (!plan) {
      clearPreview();
      schedule("world-ground-preview");
      return false;
    }
    gesture.delta = delta;
    if (plan.unbindCandidates.length === 0) {
      clearPreview();
      applyPlan(plan);
      return true;
    }
    // 模型移出动画所属导演区：保留拖动预览，等用户确认后再决定提交或复原。
    const candidates = plan.unbindCandidates;
    void (async () => {
      const confirmed = await confirmWorldUnbind({
        title: "模型移出导演区",
        description: `移出后${candidates.map(candidate => `「${candidate.title}」`).join("、")}的动画脚本将与模型解绑。是否继续？`,
        confirmLabel: "移出并解绑"
      });
      if (!confirmed) {
        clearPreview();
        schedule("world-ground-preview");
        return;
      }
      const latest = planWorldGroundMoveWithAnimationParts(
        workingCanvasOf(woohaa3CanvasStore.getState()),
        gesture.start,
        delta,
        core.options.getWorldAnimationTimes?.(),
        new Set(candidates.map(candidate => candidate.areaNodeId))
      );
      clearPreview();
      if (latest) applyPlan(latest);
      else schedule("world-ground-preview");
    })();
    return true;
  };

  const cancel = () => {
    clearPreview();
    if (state.gesture.kind === "world-ground") state.gesture = { kind: "none" };
    schedule("world-ground-preview");
  };

  return { begin, move, commit, cancel };
}
