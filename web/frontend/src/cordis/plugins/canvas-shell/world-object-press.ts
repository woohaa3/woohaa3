/**
 * 3D 世界对象的按下分流（世界模型 / 世界镜头），从 2D 输入层拆出以保持文件体积。
 *
 * 卡片命中走普通 2D 拖拽；只有渲染器拾取到的 3D 对象（模型表面/空模型锚点或镜头机位/
 * 线框）才进入这里。镜头默认沿地面平移机位，Alt 拖动旋转。
 */
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
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
  return (event: PointerEvent, nodeId: string): void => {
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    if (event.shiftKey) {
      deps.setSelection(deps.state.selected.includes(nodeId)
        ? deps.state.selected.filter((id) => id !== nodeId)
        : [...deps.state.selected, nodeId]);
      deps.schedule();
      event.preventDefault();
      return;
    }
    if (!deps.state.selected.includes(nodeId)) deps.setSelection([nodeId]);
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
