/**
 * 辅助对齐线扩展（browser-local）
 *
 * 拖动节点时把被拖动对象与其它可见对象做轴对齐匹配：命中就把预览位置吸过去，并画出参考线。
 * 几何求解是 contracts 的纯函数（`alignment-guides`），扩展只负责两件事：注入策略、渲染参考线。
 *
 * 开关就是**扩展本身**：启用即生效，禁用即完全回到"没有辅助线"的行为——不再额外提供运行期偏好，
 * 免得同一个能力出现两个作用重叠的开关。
 *
 * 为什么吸附必须由扩展"注入"而不是自己算：拖动预览位置是 `canvas-shell` 的宿主瞬时态，
 * 扩展没有写入口；宿主保留一个受控注入点（`canvasRuntime.setAlignmentSnapPolicy`）。
 */
import { createElement } from "react";
import {
  defineExtensionPlugin,
  type CanvasRuntimeService,
  type Context,
  type ExtensionFrontendDescriptor,
  type SlotsService
} from "@woohaa3/frontend/extension-api";
import { metadata } from "./metadata.js";
import { resolveAlignmentSnap } from "./solver.js";
import { AlignmentGuidesOverlay } from "./guides-overlay.js";

/** 覆盖层的稳定贡献 id。 */
const OVERLAY_ID = "alignment-guides-lines";

type AlignmentGuidesContext = Context & { slots: SlotsService; canvasRuntime: CanvasRuntimeService };

export const descriptor: ExtensionFrontendDescriptor = {
  ...metadata,
  plugin: () => defineExtensionPlugin<AlignmentGuidesContext>((ctx) => {
    // 策略常驻：扩展被装配就意味着开启，关掉能力由插件面板禁用扩展完成。
    ctx.canvasRuntime.setAlignmentSnapPolicy?.({
      resolve: input => resolveAlignmentSnap({
        moving: input.moving,
        candidates: input.candidates,
        threshold: input.threshold
      })
    });

    const removeOverlay = ctx.slots.register("canvas.overlay", {
      id: OVERLAY_ID,
      owner: metadata.extensionId,
      priority: 15,
      render: () => createElement(AlignmentGuidesOverlay, { runtime: ctx.canvasRuntime })
    });

    return () => {
      removeOverlay();
      // 禁用扩展时清掉策略：不留下"关不掉的吸附"。
      ctx.canvasRuntime.setAlignmentSnapPolicy?.(null);
    };
  }, { name: metadata.extensionId, inject: ["slots", "canvasRuntime"] })
};
