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
import { nodeSelectionStore } from "../../services/selection-store.js";
import { definePlugin } from "../../plugin.js";
import { NodeDownloadService } from "../../services/node-download.js";
import { NodeDownloadStatus } from "./node-download-status.js";
import { resolveNodeDownloadAvailability, resolveContainerFocusEdit, resolveNodeActionToolbarView, resolveSelectionActionToolbarView } from "./node-action-toolbar-view.js";
import { describeNodeActions, describeSelectionActions, nodeActionSettingsStore, routeNodeActionHit, routeSelectionActionHit } from "./node-action-host.js";
import { setNodeActionBridge } from "./node-action-bridge.js";
import type { BevyNodeActionsPresentation } from "@woohaa3/contracts";
import { isFilmSetGroupNode } from "@woohaa3/contracts";
import type { NodeActionContribution, NodeActionContext, SelectionActionContribution, SelectionActionContext } from "../../contract/platform.js";
import { guardContributionMethods } from "../../contribution-guard.js";
import type { ExtensionFaultService } from "../../extension-faults.js";

export const CANVAS_SHELL_PLUGIN_ID = "canvas-shell";

function groupToolbarSummary(canvas: NonNullable<ReturnType<typeof workingCanvasOf>>, nodeId: string): string | null {
  const node = canvas.document.nodes.find(entry => entry.id === nodeId);
  if (!node || node.type !== "group") return null;
  const descendants = new Set<string>();
  const visit = (parentId: string) => {
    for (const child of canvas.document.nodes) if (child.parentId === parentId && !descendants.has(child.id)) {
      descendants.add(child.id);
      if (child.type === "group") visit(child.id);
    }
  };
  visit(nodeId);
  const data = canvas.nodeData[nodeId];
  const title = typeof data?.title === "string" && data.title.trim() ? data.title.trim() : "未命名组";
  const kind = isFilmSetGroupNode(node, data) ? "片场" : "组";
  return `${kind} · ${descendants.size} 个节点 · ${title}`;
}

export function canvasShellExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const downloads = new NodeDownloadService({ getCanvas: () => workingCanvasOf(woohaa3CanvasStore.getState()), mediaContent: ctx.mediaContent });
      const offDownload = ctx.on("ui.node-download.save-requested", ({ nodeId }) => { void downloads.download(nodeId); });
      // 组徽标只负责选中/拖动；展开与收起都是选中后出现在组背板上方的明确动作。
      // 两个动作按 group 能力工作，片场 marker 只改变摘要文案，不改变宿主分支。
      const removeCollapsedGroupAction = ctx.slots.register("canvas.node-action", {
        id: "group-expand",
        owner: CANVAS_SHELL_PLUGIN_ID,
        order: -30,
        available: ({ nodeId, nodeType }) => {
          if (nodeType !== "group") return false;
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          return canvas?.nodeData[nodeId]?.groupCollapsed === true;
        },
        describe: ({ nodeId, nodeType, writable }) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const summary = canvas ? groupToolbarSummary(canvas, nodeId) : null;
          if (!canvas || nodeType !== "group" || canvas.nodeData[nodeId]?.groupCollapsed !== true || !summary) return null;
          // 图标 + 文字：与其它横条动作同一栅格，不占用主色调强调。
          return { label: "展开", icon: "expand-groups" as const, enabled: writable,
            ...(writable ? {} : { reason: "当前画布只读" }), summary };
        },
        activate: ({ nodeId, nodeType, writable }) => {
          if (!writable || nodeType !== "group") return;
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const data = canvas?.nodeData[nodeId];
          if (!canvas || data?.groupCollapsed !== true) return;
          void ctx.canvasEdit.record([{ type: "nodeData.patch", nodeId,
            value: { groupCollapsed: false }, expectedNodeData: { [nodeId]: data ?? null } }], "展开组");
        }
      });
      const removeExpandedGroupAction = ctx.slots.register("canvas.node-action", {
        id: "group-collapse",
        owner: CANVAS_SHELL_PLUGIN_ID,
        order: -30,
        available: ({ nodeId, nodeType }) => {
          if (nodeType !== "group") return false;
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          return canvas?.nodeData[nodeId]?.groupCollapsed !== true;
        },
        describe: ({ nodeId, nodeType, writable }) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const summary = canvas ? groupToolbarSummary(canvas, nodeId) : null;
          if (!canvas || nodeType !== "group" || canvas.nodeData[nodeId]?.groupCollapsed === true || !summary) return null;
          return { label: "收起", icon: "collapse-groups" as const, enabled: writable,
            ...(writable ? {} : { reason: "当前画布只读" }), summary };
        },
        activate: ({ nodeId, nodeType, writable }) => {
          if (!writable || nodeType !== "group") return;
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const data = canvas?.nodeData[nodeId];
          if (!canvas || data?.groupCollapsed === true) return;
          void ctx.canvasEdit.record([{ type: "nodeData.patch", nodeId,
            value: { groupCollapsed: true }, expectedNodeData: { [nodeId]: data ?? null } }], "收起组");
        }
      });
      // 片场（自带模型聚焦工作区的容器）在画布横条上提供明确的「编辑」入口（图标 + 文字）；
      // 它与徽标双击进入同一个聚焦工作区。普通 group 不出现该动作，宿主不按业务 ID 分支。
      const containerFocusEdit = (nodeId: string) => resolveContainerFocusEdit({
        canvas: workingCanvasOf(woohaa3CanvasStore.getState()) ?? null,
        nodeId,
        nodeCapabilities: ctx.nodeImplementations
      });
      const removeContainerFocusEditAction = ctx.slots.register("canvas.node-action", {
        id: "container-focus-edit",
        owner: CANVAS_SHELL_PLUGIN_ID,
        order: -20,
        available: ({ nodeId, nodeType }) => nodeType === "group" && containerFocusEdit(nodeId) !== null,
        describe: ({ nodeId }) => containerFocusEdit(nodeId) === null
          ? null
          : { label: "编辑", icon: "edit" as const, enabled: true },
        activate: ({ nodeId }) => {
          const kind = containerFocusEdit(nodeId);
          if (!kind) return;
          void ctx.canvasNavigation.requestEnterNodeFocus({ nodeId, kind, owner: "direct" });
        }
      });
      // 节点顶部操作横条的**宿主下载贡献**（change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.2）。
      // 横条由 Bevy 绘制、Rust 命中：本贡献只提供**纯数据描述**与命中派发，复用同一
      // `NodeDownloadService` 与同一事件总线（发出 `save-requested`）；不依赖画布写权限，
      // film-set 停用也不移除。
      const removeDownloadAction = ctx.slots.register("canvas.node-action", {
        id: "node-download",
        owner: CANVAS_SHELL_PLUGIN_ID,
        order: 0,
        contentAction: "download",
        // 下载门禁只读**内容就绪性**，MUST NOT 被只读拒绝（design D7）。
        available: () => true,
        describe: ({ nodeId, nodeType }) => {
          // group 横条只显示分组动作（批量执行/整理/解组，change: 2026-10-16-add-group-selection-toolbar
          // design D1）；下载是媒体内容动作，不属于分组。
          if (nodeType === "group" || nodeType === "audio" || nodeType === "composite-asset") return null;
          const readiness = resolveNodeDownloadAvailability({
            canvas: workingCanvasOf(woohaa3CanvasStore.getState()),
            nodeId,
            nodeType,
            mediaContent: ctx.mediaContent,
            content: ctx.compositeAssets.contentContributions
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
            mediaContent: ctx.mediaContent,
            content: ctx.compositeAssets.contentContributions
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
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
        return {
          selectedNodeIds: target.nodeIds,
          writable: ctx.canvasSession.isWritable(),
          content: ctx.compositeAssets.contentContributions,
          ...(canvas ? { nodeData: canvas.nodeData, nodes: canvas.document.nodes } : {})
        };
      };
      const offBridge = setNodeActionBridge({
        toolbars: () => {
          const target = toolbarTarget();
          if (!target) return new Map();
          const description = describeNodeActions({
            contributions: contributions(),
            context: {
              nodeId: target.nodeId,
              nodeType: target.nodeType,
              writable: target.writable,
              content: ctx.compositeAssets.contentContributions,
              nodeData: workingCanvasOf(woohaa3CanvasStore.getState())?.nodeData[target.nodeId]
            }
          });
          return description ? new Map<string, BevyNodeActionsPresentation>([[target.nodeId, description.presentation]]) : new Map();
        },
        activate: ({ nodeId, actionId, menu }) => {
          const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
          const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
          if (!node) return;
          const context: NodeActionContext = {
            nodeId,
            nodeType: node.type,
            writable: ctx.canvasSession.isWritable(),
            content: ctx.compositeAssets.contentContributions,
            nodeData: canvas?.nodeData[nodeId]
          };
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
        offBridge(); offActionSlots(); offSelectionActionSlots(); offDownload(); removeDownloadAction(); removeContainerFocusEditAction(); removeCollapsedGroupAction(); removeExpandedGroupAction(); removeDownloadStatus();
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
    { name: CANVAS_SHELL_PLUGIN_ID, inject: ["mediaContent", "nodeImplementations", "slots", "canvasRuntime", "canvasLocate", "canvasEdit", "canvasSession", "canvasNavigation", "compositeAssets"] }
  );
}
