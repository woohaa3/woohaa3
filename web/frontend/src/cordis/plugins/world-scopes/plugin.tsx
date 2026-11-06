import type { Context, Plugin } from "@deepseek-ai/cordis";
import { canvasGroupAcceptsMember, decodeWorkflowGroupData } from "@woohaa3/contracts";
import { definePlugin } from "../../plugin.js";
import { installWorldScopeGestureControls } from "./gesture-controls.js";
import { SceneAreaTimeline } from "./scene-area-timeline.js";
import { currentGroupActions, type GroupArrangeMode } from "./group-actions.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";

export const WORLD_SCOPES_PLUGIN_ID = "world-scopes";

// Existing tests and page wiring import the component from the plugin entry.
export { ScopeContext } from "./presentation.js";

export function worldScopesExtension(canvasId: string | undefined): Plugin.Function<void> {
  return definePlugin((ctx: Context) => {
    // 动画时间轴常驻右下地面边，选中时高亮；不再在执行面板旁挂第二个播放器。
    const remove = ctx.slots.register("canvas.overlay", {
      id: WORLD_SCOPES_PLUGIN_ID, owner: WORLD_SCOPES_PLUGIN_ID, priority: 25,
      render: () => <SceneAreaTimeline ctx={ctx} canvasId={canvasId} />
    });
    ctx.effect(() => remove, "world-scopes-overlay");
    // Scene-area gestures and 2D-group controls are an independent module owned by the
    // gestures package; this plugin only installs and disposes them with the page scope.
    const disposeGestures = installWorldScopeGestureControls(ctx, canvasId);
    ctx.effect(() => disposeGestures, "world-scope-gesture-controls");

    /** 组卡片的顶部栏：宫格 / 竖排 / 横排，全部纯图标。 */
    const groupView = (nodeId: string) => {
      const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
      const decoded = decodeWorkflowGroupData(canvas?.nodeData[nodeId]?.workflowGroup2d);
      return { canvas, decoded };
    };
    const arrangeAction = (mode: GroupArrangeMode) => {
      const label = mode === "grid" ? "宫格整理" : mode === "vertical" ? "竖排" : "横排";
      return {
        id: `group-arrange-${mode}`,
        owner: WORLD_SCOPES_PLUGIN_ID,
        order: mode === "grid" ? 10 : mode === "vertical" ? 11 : 12,
        available: ({ nodeType }: { nodeType: string }) => nodeType === "workflow-group-2d",
        describe: ({ nodeId, writable }: { nodeId: string; writable: boolean }) => {
          const { canvas, decoded } = groupView(nodeId);
          if (!canvas || !decoded.ok) return null;
          const members = decoded.value.memberNodeIds.length;
          return {
            icon: mode === "grid" ? "arrange-grid" as const : mode === "vertical" ? "arrange-vertical" as const : "arrange-horizontal" as const,
            iconOnly: true,
            label,
            enabled: writable && members > 0,
            ...(members === 0 ? { reason: "2D 组还没有成员" } : {})
          };
        },
        activate: ({ nodeId }: { nodeId: string }) => { void currentGroupActions()?.arrange(nodeId, mode); }
      };
    };
    for (const mode of ["grid", "vertical", "horizontal"] as const) {
      const removeAction = ctx.slots.register("canvas.node-action", arrangeAction(mode));
      ctx.effect(() => removeAction, `world-scopes-group-arrange-${mode}`);
    }

    // 拖动卡片进入组：拖动时点亮组框，松手把来源卡片加入成员表；位置移动仍走普通拖动，
    // 因此 onDrop 返回 false，让画布提交原有的位置更新。
    const removeDrop = ctx.slots.register("canvas.node-drop", {
      id: "world-scopes-group-drop",
      owner: WORLD_SCOPES_PLUGIN_ID,
      nodeType: "workflow-group-2d",
      // 只保留边框高亮，不在组上叠文字提示。
      dropLabel: "",
      acceptsSources: ({ canvas, targetNodeId, sourceNodeIds }) => sourceNodeIds.length > 0
        && sourceNodeIds.every((nodeId) => nodeId !== targetNodeId && canvasGroupAcceptsMember(canvas, nodeId)),
      onPreview: () => null,
      // 成员表由拖动提交批次写入（见 `drag-gesture`）：这里只负责高亮与提示，
      // 不在释放时单独记录命令，避免和位置更新抢 revision。
      onDrop: () => false
    });
    ctx.effect(() => removeDrop, "world-scopes-group-drop");
  }, {
    name: WORLD_SCOPES_PLUGIN_ID,
    inject: ["slots", "canvasRemote", "canvasRuntime", "canvasSession", "canvasEdit"]
  });
}
