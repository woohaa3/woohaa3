/** 将共享聚焦区域投影到交互控制器，并在首次布局按世界包围盒重取景。 */
import type { InteractionController } from "../canvas-shell/interaction-controller.js";
import type { FocusContentRect } from "../../focus/types.js";
import type { ModelFocusProjection } from "@woohaa3/contracts";
export function projectFocusContentRect(controller: InteractionController | null, rect: FocusContentRect | null, contentRectRight: number, initial: boolean, modelFocus: ModelFocusProjection | null): void {
    const surface = controller?.surface();
    controller?.setContentRect({
      right: rect && surface ? Math.max(0, surface.width - rect.x - rect.width) : contentRectRight,
      left: rect?.x ?? 0,
      top: rect?.y ?? 0,
      bottom: rect && surface ? Math.max(0, surface.height - rect.y - rect.height) : 0
    });
    // 首次拿到聚焦内容矩形时按可见工作区自动取景：模型没有卡片视角可恢复，
    // 首次与再次进入使用同一规则（change: 2026-11-10-remove-legacy-model-card-nodes）。
    if (initial && modelFocus) controller?.reframeModelFocus(modelFocus.nodeId);
}
