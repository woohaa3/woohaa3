/** 将共享聚焦区域投影到交互控制器，并只在首次布局重取景非预览模型。 */
import type { InteractionController } from "../canvas-shell/interaction-controller.js";
import type { FocusContentRect } from "../../focus/types.js";
import type { ModelFocusProjection } from "@woohaa3/contracts";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { shouldReframeOnInitialLayout } from "../canvas-shell/model-preview-focus.js";

export function projectFocusContentRect(controller: InteractionController | null, rect: FocusContentRect | null, contentRectRight: number, initial: boolean, modelFocus: ModelFocusProjection | null, resolver?: import("@woohaa3/contracts").NodeCapabilityResolver): void {
    const surface = controller?.surface();
    controller?.setContentRect({
      right: rect && surface ? Math.max(0, surface.width - rect.x - rect.width) : contentRectRight,
      left: rect?.x ?? 0,
      top: rect?.y ?? 0,
      bottom: rect && surface ? Math.max(0, surface.height - rect.y - rect.height) : 0
    });
    // 首次拿到聚焦内容矩形时，non-preview 模型（如片场 composite-asset）按可用区域自动取景；
    // model3d 卡片预览已用卡片视角播种观察相机，重取景会覆盖其方向/距离，故只对非预览模型。
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
    if (initial && modelFocus && shouldReframeOnInitialLayout(canvas, modelFocus.nodeId, resolver)) {
      controller?.reframeModelFocus(modelFocus.nodeId);
    }
}
