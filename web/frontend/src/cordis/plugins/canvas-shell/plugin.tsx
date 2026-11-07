/**
 * Canvas Shell Plugin
 * （change: adopt-frontend-cordis-plugin-runtime，design D3/D5；
 *   change: 2026-09-28-split-frontend-god-plugins，task 2）。
 *
 * 只拥有画布壳：DOM canvas 挂载（由 CanvasHost 调用 `canvasRuntime.attach`）、右下角
 * 缩放控件与模型聚焦返回按钮等 canvas.toolbar/canvas.overlay slot 贡献，以及画布输入门禁。
 * 页面级运行时（Bevy、controller、纹理同步）由 required `canvas-runtime` Plugin 持有；
 * 模型编辑能力由 optional `model-editor` Plugin 持有。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { CanvasZoomControls } from "./canvas-zoom-controls.js";
import { CanvasMinimap } from "./canvas-minimap.js";
import { CanvasSearchPanel } from "../../ui/CanvasSearchPanel.js";
import { CanvasUndoControls } from "./canvas-undo-controls.js";
import { CanvasUndoToast } from "./canvas-undo-toast.js";
import { SearchIcon } from "@woohaa3/ui/icons";
import { canvasSearchStore } from "../../services/canvas-search-store.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { worldCameraEditorStore } from "../../services/world-camera-editor-store.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { definePlugin } from "../../plugin.js";
import { NodeDownloadService } from "../../services/node-download.js";
import { NodeDownloadStatus } from "./node-download-status.js";
import { resolveNodeDownloadAvailability, resolveModelFocusView, resolveNodeActionToolbarView } from "./node-action-toolbar-view.js";
import { describeNodeActions, nodeActionSettingsStore, routeNodeActionHit } from "./node-action-host.js";
import { NodeActionToolbarHost } from "./node-action-toolbar-host.js";
import { SelectionToolbarHost } from "./selection-toolbar-host.js";
import { setNodeActionBridge } from "./node-action-bridge.js";
import type { BevyNodeActionsPresentation } from "@woohaa3/contracts";
import type { NodeActionContribution, NodeActionContext } from "../../contract/platform.js";
import { guardContributionMethods } from "../../contribution-guard.js";
import type { ExtensionFaultService } from "../../extension-faults.js";

export const CANVAS_SHELL_PLUGIN_ID = "canvas-shell";

export function canvasShellExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const downloads = new NodeDownloadService({ getCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()), mediaContent: ctx.mediaContent });
      const offDownload = ctx.on("ui.node-download.save-requested", ({ nodeId }) => { void downloads.download(nodeId); });
      // 模型卡片的「查看 3D」：卡片内交互关闭后（`CARD_MODEL_INTERACTION`），这是普通
      // `model3d` 卡片唯一的查看入口。单独注册。
      const modelFocusView = (nodeId: string) => resolveModelFocusView({
        canvas: workingCanvasOf(woohaa3CanvasStore.getState()) ?? null,
        nodeId,
        nodeCapabilities: ctx.nodeImplementations
      });
      const removeModelFocusViewAction = ctx.slots.register("canvas.node-action", {
        id: "model-focus-view",
        owner: CANVAS_SHELL_PLUGIN_ID,
        order: -20,
        available: ({ nodeId }) => modelFocusView(nodeId) !== null,
        describe: ({ nodeId }) => modelFocusView(nodeId) === null
          ? null
          : { label: "查看 3D", tone: "primary" as const, enabled: true },
        activate: ({ nodeId }) => {
          const kind = modelFocusView(nodeId);
          if (!kind) return;
          void ctx.canvasNavigation.requestEnterNodeFocus({ nodeId, kind, owner: "direct" });
        }
      });
      // 节点顶部操作横条的**宿主下载贡献**（change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.2）。
      // 横条由 Web 渲染：本贡献提供纯数据描述与动作派发，复用同一
      // `NodeDownloadService` 与同一事件总线（发出 `save-requested`）；不依赖画布写权限，
      // film-set 停用也不移除。
      const removeDownloadAction = ctx.slots.register("canvas.node-action", {
        id: "node-download",
        owner: CANVAS_SHELL_PLUGIN_ID,
        order: 0,
        // 下载门禁只读**内容就绪性**，MUST NOT 被只读拒绝（design D7）。
        available: () => true,
        describe: ({ nodeId, nodeType }) => {
          if (nodeType === "audio" || nodeType === "composite-asset" || nodeType === "world-camera") return null;
          // 2D 组/导演区没有可下载的作品内容，横条只保留各自的组织动作。
          if (nodeType === "workflow-group-2d" || nodeType === "scene-area") return null;
          const readiness = resolveNodeDownloadAvailability({
            canvas: workingCanvasOf(woohaa3CanvasStore.getState()),
            nodeId,
            nodeType,
            mediaContent: ctx.mediaContent
          });
          return {
            label: "下载",
            tone: "neutral" as const,
            icon: "download" as const,
            iconOnly: true,
            enabled: readiness.available,
            ...(readiness.available ? {} : { reason: readiness.reason })
          };
        },
        activate: ({ nodeId, nodeType, menu }) => {
          if (menu) return;
          const availability = resolveNodeDownloadAvailability({
            canvas: workingCanvasOf(woohaa3CanvasStore.getState()),
            nodeId,
            nodeType,
            mediaContent: ctx.mediaContent
          });
          if (!availability.available) return;
          ctx.emit("ui.node-download.save-requested", { nodeId });
        }
      });
      // Web 动作栏读取描述并通过同一宿主派发，不再向 renderer 下发 nodeActions。
      // 目标是当前**单选**的适用类型节点（横条显隐与 selection/focus 一致）。
      // 扩展动作的 available/describe/activate 抛错：归因并计入熔断，再交回横条既有的跳过逻辑
      // （change: 2026-10-21-harden-extension-fault-isolation）。
      const faults = () => ctx.get?.("extensionFaults" as never) as ExtensionFaultService | undefined;
      const contributions = () => (ctx.slots.list("canvas.node-action") as unknown as NodeActionContribution[])
        .map((entry) => guardContributionMethods(entry, "canvas.node-action", faults(), ["available", "describe", "activate"]));
      /** 当前 working 画布节点的 `{ id, type }` 轻量视图（横条判定共用）。 */
      const workingNodes = () => workingCanvasOf(woohaa3CanvasStore.getState())?.document.nodes.map((node) => ({ id: node.id, type: node.type })) ?? [];
      const focused = () => ctx.canvasNavigation.getSnapshot().mode.type !== "overview"
        || worldCameraEditorStore.getSnapshot()?.canvasId === workingCanvasOf(woohaa3CanvasStore.getState())?.id;
      const toolbarTarget = () => {
        const selection = nodeSelectionStore.getSnapshot();
        return resolveNodeActionToolbarView({
          canvas: workingCanvasOf(woohaa3CanvasStore.getState()),
          nodeCapabilities: ctx.nodeImplementations,
          selectedNodeIds: selection.nodeIds,
          nodes: workingNodes(),
          focused: focused(),
          writable: ctx.canvasSession.isWritable()
        });
      };
      const offBridge = setNodeActionBridge({
        toolbars: () => {
          const target = toolbarTarget();
          if (!target) return new Map();
          const description = describeNodeActions({
            contributions: contributions(),
            context: { nodeId: target.nodeId, nodeType: target.nodeType, writable: target.writable }
          });
          return description ? new Map<string, BevyNodeActionsPresentation>([[target.nodeId, description.presentation]]) : new Map();
        },
        activate: ({ nodeId, actionId, menu }) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
          if (!node || toolbarTarget()?.nodeId !== nodeId) return;
          const description = describeNodeActions({ contributions: contributions(),
            context: { nodeId, nodeType: node.type, writable: ctx.canvasSession.isWritable() } });
          if (!description?.presentation.actions.some(action => action.id === actionId && (menu ? action.menu : action.enabled))) return;
          const context: NodeActionContext = { nodeId, nodeType: node.type, writable: ctx.canvasSession.isWritable() };
          routeNodeActionHit({
            hit: { nodeId, actionId, menu },
            context,
            contributions: contributions(),
            openSettings: (state) => { nodeActionSettingsStore.open(state); }
          });
        }
      });
      const removeNodeActionToolbar = ctx.slots.register("canvas.overlay", {
        id: "node-action-toolbar", owner: CANVAS_SHELL_PLUGIN_ID, priority: 25,
        render: () => <NodeActionToolbarHost ctx={ctx} />
      });
      const removeSelectionToolbar = ctx.slots.register("canvas.overlay", {
        id: "selection-toolbar", owner: CANVAS_SHELL_PLUGIN_ID, priority: 25,
        render: () => <SelectionToolbarHost ctx={ctx} />
      });
      const removeDownloadStatus = ctx.slots.register("canvas.overlay", {
        id: "node-download-status", owner: CANVAS_SHELL_PLUGIN_ID, priority: 26,
        render: () => <NodeDownloadStatus service={downloads} />
      });
      ctx.effect(() => () => {
        offBridge(); removeNodeActionToolbar(); removeSelectionToolbar(); offDownload(); removeDownloadAction(); removeModelFocusViewAction(); removeDownloadStatus();
        nodeActionSettingsStore.close();
        downloads.dispose();
      }, "canvas-shell-downloads");
      // 缩放控件排在小地图右侧的概览区（2026-10-26）：与工具行分离，行里只留动作图标。
      // 百分比刷新由控件内部订阅本地视口完成，不依赖画布 revision
      // （change: fix-viewport-zoom-range）。
      const removeToolbar = ctx.slots.register("canvas.minimap-side", {
        id: "canvas-zoom",
        owner: CANVAS_SHELL_PLUGIN_ID,
        position: "right",
        priority: 0,
        render: ({ revision }) => (
          <CanvasZoomControls getController={() => ctx.canvasRuntime.controller()} revision={revision} />
        )
      });

      ctx.effect(() => () => removeToolbar(), "canvas-shell-toolbar");

      // 右下角控件面板顶部的小地图（2026-10-26）：
      // 只读 working 画布与本地视口，点击/拖动经同一 InteractionController 平移；
      // 收起按钮浮在地图边缘，状态由宿主保存并经 onCollapse 注入。
      const removeMinimap = ctx.slots.register("canvas.minimap", {
        id: "canvas-minimap",
        owner: CANVAS_SHELL_PLUGIN_ID,
        priority: 0,
        render: ({ revision, onCollapse }) => (
          <CanvasMinimap
            getController={() => ctx.canvasRuntime.controller()}
            revision={revision}
            onCollapse={onCollapse}
          />
        )
      });
      ctx.effect(() => () => removeMinimap(), "canvas-shell-minimap");

      // 撤销/重做工具按钮（change: 2026-10-09-improve-canvas-workflow，任务 1.7）。
      // 与快捷键共用页面编辑历史；无记录时禁用并给出可读原因。
      const removeUndo = ctx.slots.register("canvas.toolbar", {
        id: "canvas-undo",
        owner: CANVAS_SHELL_PLUGIN_ID,
        priority: -10,
        render: () => <CanvasUndoControls edit={ctx.canvasEdit} />
      });
      ctx.effect(() => () => removeUndo(), "canvas-shell-undo");

      // 「查找作品」入口（change: 2026-10-09-improve-canvas-workflow，任务 4.2）：
      // 除 Ctrl/⌘+F 外提供可见图标入口（触屏/首次用户可发现）。
      const removeSearchAction = ctx.slots.register("canvas.toolbar-action", {
        id: "canvas-search-action",
        owner: CANVAS_SHELL_PLUGIN_ID,
        priority: 15,
        label: "查找作品",
        icon: SearchIcon,
        onActivate: () => canvasSearchStore.open()
      });
      ctx.effect(() => () => removeSearchAction(), "canvas-shell-search-action");

      // 删除后的撤销提示（任务 1.7）：绑定具体动作身份，栈顶变化时提示失效。
      const removeUndoToast = ctx.slots.register("canvas.overlay", {
        id: "canvas-undo-toast",
        owner: CANVAS_SHELL_PLUGIN_ID,
        priority: 25,
        render: () => <CanvasUndoToast edit={ctx.canvasEdit} />
      });
      ctx.effect(() => () => removeUndoToast(), "canvas-shell-undo-toast");

      // 查找作品面板（change: 2026-10-09-improve-canvas-workflow，任务 4.2）。
      const removeSearch = ctx.slots.register("canvas.overlay", {
        id: "canvas-search",
        owner: CANVAS_SHELL_PLUGIN_ID,
        priority: 20,
        render: () => (
          <CanvasSearchPanel
            store={canvasSearchStore}
            getCanvas={() => workingCanvasOf(woohaa3CanvasStore.getState()) ?? null}
            onLocate={(nodeId) => {
              const result = ctx.canvasLocate.locateNodes([nodeId]);
              return result.ok ? { ok: true } : { ok: false, reason: result.reason };
            }}
          />
        )
      });
      ctx.effect(() => () => removeSearch(), "canvas-shell-search");
      // page scope dispose 时关闭查找，避免跨画布残留（任务 4.2）。
      ctx.effect(() => () => canvasSearchStore.close(), "canvas-shell-search-reset");
    },
    { name: CANVAS_SHELL_PLUGIN_ID, inject: ["mediaContent", "nodeImplementations", "slots", "canvasRuntime", "canvasLocate", "canvasEdit", "canvasSession", "canvasNavigation"] }
  );
}
