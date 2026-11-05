/**
 * 3D 世界对象的按下分流（世界模型 / 世界镜头），从 2D 输入层拆出以保持文件体积。
 *
 * 卡片命中走普通 2D 拖拽；只有渲染器拾取到的 3D 对象（模型表面/空模型锚点或镜头机位/
 * 线框）才进入这里。镜头默认沿地面平移机位，Alt 拖动旋转。
 *
 * 选择规则与 2D 卡片共用 `selection/press.ts`；这里只保留世界对象自己的手势分流。
 */
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { commitPressSelection } from "./input/selection/apply.js";
import { resolvePressSelection } from "./input/selection/press.js";
import type { PressSelectionPlan } from "./input/selection/types.js";
import { isWorldCameraTarget } from "./world-camera-drag.js";
import type { WorldCameraGestureFamily } from "./world-camera-gesture.js";
import type { WorldGroundGestureFamily } from "./world-ground-gesture.js";
import type { InteractionState } from "./interaction-core.js";

export function createWorldObjectPress(deps: {
  state: InteractionState;
  setSelection: (nodeIds: string[]) => void;
  schedule: (reason?: string) => void;
  worldGround: WorldGroundGestureFamily;
  worldCamera: WorldCameraGestureFamily;
  beginGesture: () => void;
  beginPerfGesture: (kind: string) => void;
}) {
  return (event: PointerEvent, nodeId: string, preset?: PressSelectionPlan): void => {
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const plan = preset ?? resolvePressSelection({
      canvas,
      nodeId,
      selected: deps.state.selected,
      additive: event.shiftKey
    });
    commitPressSelection({
      state: deps.state,
      nodeId,
      plan,
      setSelection: deps.setSelection,
      x: event.clientX,
      y: event.clientY
    });
    // Shift 只切换选择；容器优先则由调用方提前处理。两者都不开始世界拖动。
    if (event.shiftKey || plan.gesture === "toggle" || plan.gesture === "scope") {
      deps.schedule();
      event.preventDefault();
      return;
    }
    const started = isWorldCameraTarget(canvas, nodeId)
      ? deps.worldCamera.begin(event, nodeId, event.altKey ? "rotate" : "move")
      : deps.worldGround.begin(event, nodeId);
    if (started) {
      deps.beginGesture();
      deps.beginPerfGesture("drag");
    }
    deps.schedule();
    event.preventDefault();
  };
}
