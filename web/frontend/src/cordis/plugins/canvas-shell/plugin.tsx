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
import { CanvasSearchPanel } from "../../ui/CanvasSearchPanel.js";
import { CanvasUndoControls } from "./canvas-undo-controls.js";
import { CanvasUndoToast } from "./canvas-undo-toast.js";
import { SearchIcon } from "../../../shared/ui/icons.js";
import { canvasSearchStore } from "../../services/canvas-search-store.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { definePlugin } from "../../plugin.js";
import { NodeDownloadService } from "../../services/node-download.js";
import { NodeDownloadStatus } from "./node-download-status.js";
import { resolveNodeDownloadAvailability, resolveNodeActionToolbarView, resolveSelectionActionToolbarView } from "./node-action-toolbar-view.js";
import { describeNodeActions, describeSelectionActions, nodeActionSettingsStore, routeNodeActionHit, routeSelectionActionHit } from "./node-action-host.js";
import { setNodeActionBridge } from "./node-action-bridge.js";
import type { BevyNodeActionsPresentation } from "@woohaa3/contracts";
import type { NodeActionContribution, NodeActionContext, SelectionActionContribution, SelectionActionContext } from "../../contract/platform.js";
import { guardContributionMethods } from "../../contribution-guard.js";
import type { ExtensionFaultService } from "../../extension-faults.js";

export const CANVAS_SHELL_PLUGIN_ID = "canvas-shell";

export function canvasShellExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const downloads = new NodeDownloadService({ getCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()) });
      const offDownload = ctx.on("ui.node-download.save-requested", ({ nodeId }) => { void downloads.download(nodeId); });
      // 节点顶部操作横条的**宿主下载贡献**（change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.2）。
      // 横条由 Bevy 绘制、Rust 命中：本贡献只提供**纯数据描述**与命中派发，复用同一
      // `NodeDownloadService` 与同一事件总线（发出 `save-requested`）；不依赖画布写权限，
      // film-set 停用也不移除。
      const removeDownloadAction = ctx.slots.register("canvas.node-action", {
        id: "node-download",
        owner: CANVAS_SHELL_PLUGIN_ID,
        order: 0,
        // 下载门禁只读**内容就绪性**，MUST NOT 被只读拒绝（design D7）。
        available: () => true,
        describe: ({ nodeId, nodeType }) => {
          // group 横条只显示分组动作（批量执行/整理/解组，change: 2026-10-16-add-group-selection-toolbar
          // design D1）；下载是媒体内容动作，不属于分组。
          if (nodeType === "group" || nodeType === "audio" || nodeType === "composite-asset") return null;
          const readiness = resolveNodeDownloadAvailability({
            canvas: workingCanvasOf(woohaa3CanvasStore.getState()),
            nodeId,
            nodeType
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
            nodeType
          });
          if (!availability.available) return;
          ctx.emit("ui.node-download.save-requested", { nodeId });
        }
      });
      // 下行桥：canvas-runtime 每帧据此下发 `nodeActions`；上行：Rust 命中回传派发。
      // 目标是当前**单选**的适用类型节点（横条显隐与 selection/focus 一致）。
      // 扩展动作的 available/describe/activate 抛错：归因并计入熔断，再交回横条既有的跳过逻辑
      // （change: 2026-10-21-harden-extension-fault-isolation）。
      const faults = () => ctx.get?.("extensionFaults" as never) as ExtensionFaultService | undefined;
      const contributions = () => (ctx.slots.list("canvas.node-action") as unknown as NodeActionContribution[])
        .map((entry) => guardContributionMethods(entry, "canvas.node-action", faults(), ["available", "describe", "activate"]));
      const selectionContributions = () => (ctx.slots.list("canvas.selection-action") as unknown as SelectionActionContribution[])
        .map((entry) => guardContributionMethods(entry, "canvas.selection-action", faults(), ["available", "describe", "activate"]));
      /** 当前 working 画布节点的 `{ id, type }` 轻量视图（横条判定共用）。 */
      const workingNodes = () => workingCanvasOf(woohaa3CanvasStore.getState())?.document.nodes.map((node) => ({ id: node.id, type: node.type })) ?? [];
      const focused = () => ctx.canvasNavigation.getSnapshot().mode.type === "node-focus";
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
      // 多选横条：选中 ≥2 个节点时按同一选区解析稳定目标；与单节点横条互斥（选择数决定谁呈现）。
      const selectionToolbarContext = (): SelectionActionContext | null => {
        const selection = nodeSelectionStore.getSnapshot();
        const target = resolveSelectionActionToolbarView({
          selectedNodeIds: selection.nodeIds,
          nodes: workingNodes(),
          focused: focused()
        });
        if (!target) return null;
        return { selectedNodeIds: target.nodeIds, writable: ctx.canvasSession.isWritable() };
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
          if (!node) return;
          const context: NodeActionContext = { nodeId, nodeType: node.type, writable: ctx.canvasSession.isWritable() };
          routeNodeActionHit({
            hit: { nodeId, actionId, menu },
            context,
            contributions: contributions(),
            openSettings: (state) => { nodeActionSettingsStore.open(state); }
          });
        },
        selectionToolbar: () => {
          const context = selectionToolbarContext();
          if (!context) return null;
          return describeSelectionActions({ contributions: selectionContributions(), context })?.presentation ?? null;
        },
        activateSelection: ({ actionId, menu }) => {
          const context = selectionToolbarContext();
          if (!context) return;
          routeSelectionActionHit({ hit: { actionId, menu }, context, contributions: selectionContributions() });
        }
      });
      // 贡献注册/撤销（例如 film-set 停用）时描述可能变化：请求一帧重建，避免画布残留旧横条。
      const offActionSlots = ctx.slots.subscribe("canvas.node-action", () => {
        ctx.canvasRuntime.controller()?.invalidate("node-action-slots");
      });
      const offSelectionActionSlots = ctx.slots.subscribe("canvas.selection-action", () => {
        ctx.canvasRuntime.controller()?.invalidate("selection-action-slots");
      });
      const removeDownloadStatus = ctx.slots.register("canvas.overlay", {
        id: "node-download-status", owner: CANVAS_SHELL_PLUGIN_ID, priority: 26,
        render: () => <NodeDownloadStatus service={downloads} />
      });
      ctx.effect(() => () => {
        offBridge(); offActionSlots(); offSelectionActionSlots(); offDownload(); removeDownloadAction(); removeDownloadStatus();
        nodeActionSettingsStore.close();
        downloads.dispose();
      }, "canvas-shell-downloads");
      // 缩放控件作为 toolbar contribution（原 App 直接渲染；现由 Plugin 注册）。
      // 百分比刷新由控件内部订阅本地视口完成，不依赖画布 revision
      // （change: fix-viewport-zoom-range）。
      const removeToolbar = ctx.slots.register("canvas.toolbar", {
        id: "canvas-zoom",
        owner: CANVAS_SHELL_PLUGIN_ID,
        priority: 0,
        render: ({ revision }) => (
          <CanvasZoomControls getController={() => ctx.canvasRuntime.controller()} revision={revision} />
        )
      });

      ctx.effect(() => () => removeToolbar(), "canvas-shell-toolbar");

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
    { name: CANVAS_SHELL_PLUGIN_ID, inject: ["nodeImplementations", "slots", "canvasRuntime", "canvasLocate", "canvasEdit", "canvasSession", "canvasNavigation"] }
  );
}
