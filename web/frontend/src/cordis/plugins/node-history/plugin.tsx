import { applyModelOverride, currentNodeHasOutput, createRemoteClient } from "./history-adapters.js";
import { installInlineVersions } from "./inline-versions.js";
/**
 * Node History Plugin（optional）
 * （change: add-canvas-node-generation-history；
 *   change: unify-canvas-presentation-navigation，task 5.3 / design D7）。
 *
 * open/close identity 由 Canvas Navigation 决定：本插件注册 `node-history` panel definition，
 * controller 只保存 loading/list/detail/pagination/apply 等内容状态；模型历史走统一
 * `open-node-history` intent（节点聚焦 + 历史 panel 原子建立）。
 *
 * 模型选择从受保护详情读取权威脚本，在受限 executor 中生成并校验 Scene IR，作为当前聚焦
 * ModelRoot 的本地 snapshot override（selection generation 丢弃迟到结果）；不提交 Canvas 命令。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import {
  nodeHistoryKindForNodeType
} from "@woohaa3/contracts";
import { NodeHistoryController, type NodeHistoryClient, CURRENT_PRESENTATION_ID } from "./controller.js";
import type { CanvasHistoryController, CanvasHistoryClient } from "./canvas-history-controller.js";
import type { DialogRendererProps } from "../../services/dialogs/renderer-registry.js";
import { lazy, Suspense } from "react";
const NodeHistoryPanel = lazy(() => import("./panel.js").then(module => ({ default: module.NodeHistoryPanel })));
// The canvas-wide browser is only needed when its dialog opens, not at canvas startup.
type CanvasHistoryRendererArgs = Parameters<typeof import("./canvas-history-browser.js")["createCanvasHistoryRenderer"]>;
function createCanvasHistoryRenderer(getController: () => Promise<CanvasHistoryController>, ...args: CanvasHistoryRendererArgs extends [unknown, ...infer Rest] ? Rest : never) {
  const Renderer = lazy(async () => {
    const [module, controller] = await Promise.all([import("./canvas-history-browser.js"), getController()]);
    return { default: module.createCanvasHistoryRenderer(controller, ...args) };
  });
  return function CanvasHistoryDialog(props: DialogRendererProps) {
    return <Suspense fallback={<div className="canvas-history__state">正在加载生成历史…</div>}><Renderer {...props} /></Suspense>;
  };
}
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { NODE_HISTORY_SERVICE, INLINE_HISTORY_SERVICE, RUN_STATE_SERVICE, IMAGE_EDIT_SERVICE, VIDEO_FOCUS_SERVICE, type InlineHistoryService, type RunStateService, type ImageEditService, type VideoFocusService } from "../service-keys.js";
import { definePlugin } from "../../plugin.js";
import { DEFAULT_CANVAS_ID } from "../../services/canvas-session.js";
import { GenerationHistoryIcon } from "../../../shared/ui/icons.js";
import { objectPayload } from "../../services/dialogs/registry.js";
import type { DialogDefinition } from "../../services/dialogs/types.js";

export const NODE_HISTORY_PLUGIN_ID = "node-history";
export const NODE_HISTORY_PANEL_TYPE = "node-history";
export const CANVAS_HISTORY_DIALOG_ID = "canvas-generation-history";
const CANVAS_HISTORY_ACTION_ID = "node-history-all";

/** 只读画布历史弹窗的 payload：无必需字段。 */
const canvasHistoryDefinition: DialogDefinition = {
  dismissible: true,
  singleton: true,
  size: "lg",
  variant: "standard",
  validatePayload: objectPayload<Record<string, never>>(CANVAS_HISTORY_DIALOG_ID, () => ({}))
};

export type NodeHistoryExtensionOptions = {
  canvasId?: string;
  /** 测试注入：替身 client。 */
  client?: NodeHistoryClient;
};

export function nodeHistoryExtension(options: NodeHistoryExtensionOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const canvasId = options.canvasId ?? DEFAULT_CANVAS_ID;
      const client = options.client ?? createRemoteClient(ctx);
      const disposeInlineVersions = installInlineVersions(ctx, canvasId, client);
      const controller = new NodeHistoryController(client);
      const runState = ctx.get(RUN_STATE_SERVICE as never) as RunStateService | undefined;
      const syncOperations = () => controller.setOperations(runState?.snapshot().records ?? []);
      const offOperations = runState?.subscribe(syncOperations);
      const inline = ctx.get(INLINE_HISTORY_SERVICE as never) as InlineHistoryService | undefined;
      const offHistoryRefresh = inline?.subscribe(() => { void controller.refresh(); });
      /** 总览传递的待选记录；只消费一次，不自动恢复。 */
      let pendingEntryId: string | null = null;
      const selectTarget = (target: string) => {
        const nodeId = controller.getState()?.nodeId;
        const item = nodeId ? inline?.snapshot().get(nodeId)?.find(item => item.entryId === target) : undefined;
        if (item) controller.includeHistory(item);
        void controller.select(target);
      };
      let canvasHistoryController: CanvasHistoryController | undefined;
      /** 已投影 override 的条目（避免重复执行/覆盖新选择）。 */
      let appliedOverrideEntryId: string | null = null;

      // 右下角控件面板：打开「全部生成历史」只读弹窗。
      const removeHistoryAction = ctx.slots.register("canvas.toolbar-action", {
        id: CANVAS_HISTORY_ACTION_ID,
        owner: NODE_HISTORY_PLUGIN_ID,
        priority: 20,
        label: "作品生成历史",
        icon: GenerationHistoryIcon,
        onActivate: () => {
          ctx.canvasNavigation.openDialog({ dialogId: CANVAS_HISTORY_DIALOG_ID, payload: {} });
        }
      });
      ctx.effect(() => () => removeHistoryAction(), "node-history-canvas-action");

      const disposeCanvasHistoryDialog = ctx.dialogs.registerDialog(CANVAS_HISTORY_DIALOG_ID, {
        definition: canvasHistoryDefinition,
        renderer: createCanvasHistoryRenderer(
          async () => {
            const { CanvasHistoryController } = await import("./canvas-history-controller.js");
            return canvasHistoryController ??= new CanvasHistoryController(client as unknown as CanvasHistoryClient);
          },
          canvasId,
          // 显式跳转到节点版本（任务 6.3）：先关闭总览，再定位并打开节点版本面板。
          (item) => {
            const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
            const node = canvas?.document.nodes.find((entry) => entry.id === item.nodeId);
            const kind = node ? nodeHistoryKindForNodeType(node.type) : null;
            if (!node || !kind) return;
            ctx.canvasNavigation.openPanel({
              type: NODE_HISTORY_PANEL_TYPE,
              nodeId: item.nodeId
            });
            // 传递 entryId 作为待选记录（不自动恢复、不覆盖当前草稿）。
            pendingEntryId = item.entryId;
          },
          // 目标校验：节点存在且类型受版本支持；否则禁用并说明原因。
          (nodeId) => {
            const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
            const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
            if (!node) return { ok: false, reason: "该作品已被删除，无法查看版本" };
            if (!nodeHistoryKindForNodeType(node.type)) return { ok: false, reason: "该类型暂不支持节点版本" };
            return { ok: true };
          }
        )
      });
      ctx.effect(() => () => disposeCanvasHistoryDialog(), "node-history-canvas-dialog");

      // 事件入口 → 显式 navigation intent（不直接改 controller/聚焦）。
      // 当前输出不可用时直接显示通用历史面板，避免聚焦目标校验阻断入口。
      const openNodeHistoryEntry = (nodeId: string, kind: "model" | "image" | "video") => {
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        if (!currentNodeHasOutput(canvas, nodeId, kind)) {
          ctx.canvasNavigation.openPanel({ type: NODE_HISTORY_PANEL_TYPE, nodeId });
          return;
        }
        void ctx.canvasNavigation.requestOpenNodeHistory({ nodeId, kind }).then((result) => {
          if (!result.ok && kind === "video") {
            ctx.canvasNavigation.openPanel({ type: NODE_HISTORY_PANEL_TYPE, nodeId });
          }
        });
      };
      const offEvent = ctx.on("ui.node-history.open-requested", (payload) => {
        const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : "";
        if (!nodeId) return;
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
        if (!node) return;
        const kind = nodeHistoryKindForNodeType(node.type);
        if (!kind) return;
        if (kind === "model" || kind === "image" || kind === "video") openNodeHistoryEntry(nodeId, kind);
        else ctx.canvasNavigation.openPanel({ type: NODE_HISTORY_PANEL_TYPE, nodeId });
      });
      ctx.effect(() => () => offEvent(), "node-history-event");

      // navigation route → controller 内容状态。route 变为 node-history 时加载；否则关闭。
      const unsubscribeNav = ctx.canvasNavigation.subscribe(() => {
        const route = ctx.canvasNavigation.getSnapshot().panel;
        const state = controller.getState();
        if (route?.type === NODE_HISTORY_PANEL_TYPE) {
          if (!state || state.nodeId !== route.nodeId) {
            const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
            const node = canvas?.document.nodes.find((entry) => entry.id === route.nodeId);
            const kind = node ? nodeHistoryKindForNodeType(node.type) : null;
            if (kind) {
              void controller.open({ canvasId, nodeId: route.nodeId, kind, writable: ctx.canvasSession.isWritable() }).then(() => {
                syncOperations();
                // 消费总览跳转传递的待选记录（不自动恢复；仅选中）。
                if (pendingEntryId) {
                  const target = pendingEntryId;
                  pendingEntryId = null;
                  selectTarget(target);
                }
              });
            }
          }
        } else if (state) {
          controller.close();
        }
        syncCurrentDraftState();
      });
      ctx.effect(() => () => unsubscribeNav(), "node-history-nav-sync");

      /**
       * 面板关闭入口（design D3）：UI 只提交 Navigation intent。
       *
       * 模型历史：`closeModelHistory`（direct 进入恢复 direct，overview 进入退出）；
       * 其它类型：关闭通用 panel route。controller `close()` 仅由 route cleanup 调用。
       */
      const closeFromPanel = () => {
        const route = ctx.canvasNavigation.getSnapshot().panel;
        if (route?.type !== NODE_HISTORY_PANEL_TYPE) return;
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        const node = canvas?.document.nodes.find((entry) => entry.id === route.nodeId);
        const kind = node ? nodeHistoryKindForNodeType(node.type) : null;
        if ((kind === "model" || kind === "image" || kind === "video")
          && ctx.canvasNavigation.getSnapshot().mode.type === "node-focus") void ctx.canvasNavigation.requestCloseNodeHistory();
        else ctx.canvasNavigation.closePanel(NODE_HISTORY_PANEL_TYPE);
      };

      // 历史 panel definition：注入 close intent（不直接改 controller open identity）。
      const disposePanel = ctx.canvasNavigation.registerPanel({
        type: NODE_HISTORY_PANEL_TYPE,
        owner: NODE_HISTORY_PLUGIN_ID,
        render: ({ writable }) => (
          <Suspense fallback={<p>正在加载生成历史…</p>}><NodeHistoryPanel
            controller={controller}
            writable={writable}
            onClose={closeFromPanel}
            onWidthChange={(width) => {
              if (ctx.canvasNavigation.getSnapshot().mode.type === "overview") ctx.canvasRuntime.setContentRect({ right: width });
            }}
          /></Suspense>
        )
      });
      ctx.effect(() => () => disposePanel(), "node-history-panel-definition");

      // 权威画布回流：重算 current 标记并清理失效目标。
      const unsubscribeCanvas = woohaa3CanvasStore.subscribe(() => {
        const canvas = woohaa3CanvasStore.getState().canvas;
        controller.reconcile(canvas ?? null);
        const working = workingCanvasOf(woohaa3CanvasStore.getState());
        ctx.canvasNavigation.reconcile(new Set(working?.document.nodes.map((node) => node.id) ?? []));
        syncCurrentDraftState();
      });
      ctx.effect(() => () => unsubscribeCanvas(), "node-history-canvas-subscribe");

      /**
       * 把当前编辑草稿状态与「当前是否有可用输出」投影到固定首项
       * （change: 图片聚焦编辑，任务 8.1；change: 2026-10-10-add-video-node-focus-workspace，设计 D5）。
       *
       * `hasOutput` 依权威 canonical 内容判定（媒体类要求自身输出 asset ready）；当前无输出时
       * 首项显示明确空态，绝不把 input mapping / 缓存 URL 当作当前输出。
       */
      function syncCurrentDraftState(): void {
        const imageEdit = ctx.get(IMAGE_EDIT_SERVICE as never) as ImageEditService | undefined;
        const state = controller.getState();
        if (!state) return;
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        const active = imageEdit?.isActive() === true && imageEdit.nodeId() === state.nodeId;
        controller.setCurrentPresentation({
          draftState: active ? imageEdit!.draftState() : "saved",
          hasOutput: currentNodeHasOutput(canvas, state.nodeId, state.kind)
        });
      }

      // 聚焦退出（Escape / 清除选择 / 目标失效）时同步关闭历史面板。
      // 以 Navigation mode（图片/模型统一）判断关闭；模型额外监听 runtime 投影失效，
      // 因为模型投影恒为 null 时（图片聚焦）不能误关图片历史面板
      // （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D1/D8）。
      const reconcileHistoryWithFocus = () => {
        const route = ctx.canvasNavigation.getSnapshot().panel;
        if (route?.type !== NODE_HISTORY_PANEL_TYPE) return;
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        if (mode.type === "overview") return;
        // 独立文件文档没有节点身份，也永远不承载节点历史面板。
        if (mode.type === "document-workspace") {
          ctx.canvasNavigation.closePanel(NODE_HISTORY_PANEL_TYPE);
          return;
        }
        if (mode.nodeId !== route.nodeId) {
          ctx.canvasNavigation.closePanel(NODE_HISTORY_PANEL_TYPE);
          return;
        }
        if (mode.kind === "model") {
          const focusedNodeId = ctx.canvasRuntime.modelFocusProjection()?.nodeId ?? null;
          if (focusedNodeId !== route.nodeId) ctx.canvasNavigation.closePanel(NODE_HISTORY_PANEL_TYPE);
        }
        // 视频聚焦投影直到解码 metadata 就绪才产生（异步），不能用它判断聚焦是否仍有效，
        // 否则打开历史后瞬间被误判为「失去聚焦」而关闭面板。目标失效由 video-focus 的
        // target reconcile 走 invalidateNodeFocus（原子清理 mode + panel）。
      };
      const unsubscribeFocus = ctx.canvasNavigation.subscribe(reconcileHistoryWithFocus);
      const unsubscribeModelFocus = ctx.canvasRuntime.subscribeModelFocus(reconcileHistoryWithFocus);
      ctx.effect(() => () => {
        unsubscribeFocus();
        unsubscribeModelFocus();
      }, "node-history-focus-close");

      // 模型选择：详情回流后本地生成并校验 Scene IR，原子覆盖同一 ModelRoot。
      let previousApplyingEntryId: string | null = null;
      /** 当前本地 override 的节点（关闭/失效时据此清除，避免丢失 nodeId）。 */
      let overrideNodeId: string | null = null;
      const clearOverride = () => {
        if (overrideNodeId !== null) {
          ctx.compositeAssets.resolve(ctx.canvasState.getCanvas(), overrideNodeId)?.history?.(overrideNodeId, null);
          ctx.canvasRuntime.setModelSceneOverride({ nodeId: overrideNodeId, override: null });
          overrideNodeId = null;
        }
        appliedOverrideEntryId = null;
      };

      /**
       * 图片历史选择：在同一聚焦工作区安装只读媒体 override
       * （change: 图片聚焦编辑，任务 8.3/8.4 / design D8）。
       *
       * 选择旧版本 → history owner；点击首项 → direct，清除 override。中央内容只读切换，
       * 迟到解码由 request generation 保护（image-edit workspace 负责）。
       */
      let appliedImageOverrideEntryId: string | null = null;
      const applyImageOverride = (state: NonNullable<ReturnType<typeof controller.getState>>) => {
        const imageEdit = ctx.get(IMAGE_EDIT_SERVICE as never) as ImageEditService | undefined;
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        if (state.selectedEntryId === CURRENT_PRESENTATION_ID || state.selectedEntryId === null) {
          if (appliedImageOverrideEntryId !== null) {
            imageEdit?.setHistoryOverride?.(null);
            appliedImageOverrideEntryId = null;
            if (mode.type === "node-focus" && mode.kind === "image") {
              ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "image", owner: "direct" });
            }
          }
          return;
        }
        if (state.selectedEntryId === appliedImageOverrideEntryId) return;
        const detail = state.detail;
        if (!detail || detail.entryId !== state.selectedEntryId) return;
        if (detail.kind === "failure") return;
        if (detail.kind !== "image" && detail.kind !== "video" && detail.kind !== "audio") return;
        const href = ctx.canvasRemote.nodeHistoryPreviewUrl({
          canvasId: state.canvasId,
          nodeId: state.nodeId,
          entryId: detail.entryId,
          variant: "preview"
        });
        imageEdit?.setHistoryOverride?.({ url: href });
        appliedImageOverrideEntryId = state.selectedEntryId;
        // 中央内容切到 history owner（原子；禁用写工具）。
        if (mode.type === "node-focus" && mode.kind === "image" && mode.owner === "direct") {
          ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "image", owner: "history" });
        } else if (mode.type !== "node-focus") {
          ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "image", owner: "history" });
        }
      };

      /**
       * 视频历史选择：在同一聚焦工作区安装只读历史媒体 override
       * （change: 2026-10-10-add-video-node-focus-workspace，design D5）。
       *
       * 选择旧版本 → history owner，中央只读播放该条目；点击首项 → direct，清除 override 并
       * 恢复当前现场。当前来源变化时保留帧与回执、重新取景/暂停（feature 会话负责）。
       */
      let appliedVideoOverrideEntryId: string | null = null;
      const applyVideoOverride = (state: NonNullable<ReturnType<typeof controller.getState>>) => {
        const videoFocus = ctx.get(VIDEO_FOCUS_SERVICE as never) as VideoFocusService | undefined;
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        if (state.selectedEntryId === CURRENT_PRESENTATION_ID || state.selectedEntryId === null) {
          if (appliedVideoOverrideEntryId !== null) {
            videoFocus?.setHistoryOverride?.(null);
            appliedVideoOverrideEntryId = null;
            if (mode.type === "node-focus" && mode.kind === "video") {
              ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "video", owner: "direct" });
            }
          }
          return;
        }
        if (state.selectedEntryId === appliedVideoOverrideEntryId) return;
        const detail = state.detail;
        if (!detail || detail.entryId !== state.selectedEntryId || detail.kind !== "video") return;
        const href = ctx.canvasRemote.nodeHistoryPreviewUrl({
          canvasId: state.canvasId,
          nodeId: state.nodeId,
          entryId: detail.entryId,
          variant: "preview"
        });
        videoFocus?.setHistoryOverride?.({ url: href });
        appliedVideoOverrideEntryId = state.selectedEntryId;
        if (mode.type === "node-focus" && mode.kind === "video" && mode.owner === "direct") {
          ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "video", owner: "history" });
        } else if (mode.type !== "node-focus") {
          ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "video", owner: "history" });
        }
      };

      const unsubscribeController = controller.subscribe(() => {
        const state = controller.getState();
        if (!state) {
          if (ctx.canvasNavigation.getSnapshot().mode.type === "overview") ctx.canvasRuntime.setContentRect({ right: 0 });
          clearOverride();
          if (appliedImageOverrideEntryId !== null) {
            const imageEdit = ctx.get(IMAGE_EDIT_SERVICE as never) as ImageEditService | undefined;
            imageEdit?.setHistoryOverride?.(null);
            appliedImageOverrideEntryId = null;
          }
          if (appliedVideoOverrideEntryId !== null) {
            const videoFocus = ctx.get(VIDEO_FOCUS_SERVICE as never) as VideoFocusService | undefined;
            videoFocus?.setHistoryOverride?.(null);
            appliedVideoOverrideEntryId = null;
          }
          previousApplyingEntryId = null;
          return;
        }
        // 应用成功（applying 从非空回落且无错误）→ 原子切到同一模型 direct focus
        // （change: fix-model-focus-navigation-and-camera-parity，task 2.4）。
        if (
          state.kind === "model" &&
          previousApplyingEntryId !== null &&
          state.applyingEntryId === null &&
          state.applyError === null
        ) {
          const route = ctx.canvasNavigation.getSnapshot().panel;
          if (route?.type === NODE_HISTORY_PANEL_TYPE && route.nodeId === state.nodeId) {
            ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "model", owner: "direct" });
          }
        }
        // 视频恢复成功：清 override、切 direct、保留历史面板（等待 canonical 回流由 reconcile 驱动）。
        if (
          state.kind === "video" &&
          previousApplyingEntryId !== null &&
          state.applyingEntryId === null &&
          state.applyError === null
        ) {
          const videoFocus = ctx.get(VIDEO_FOCUS_SERVICE as never) as VideoFocusService | undefined;
          videoFocus?.setHistoryOverride?.(null);
          appliedVideoOverrideEntryId = null;
          videoFocus?.refreshFromCanonical?.();
          const mode = ctx.canvasNavigation.getSnapshot().mode;
          if (mode.type === "node-focus" && mode.kind === "video") {
            ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "video", owner: "direct" });
          }
        }
        previousApplyingEntryId = state.applyingEntryId;
        if (state.kind === "image") {
          applyImageOverride(state);
          return;
        }
        if (state.kind === "video") {
          applyVideoOverride(state);
          return;
        }
        if (state.kind !== "model") return;
        if (state.selectedEntryId === CURRENT_PRESENTATION_ID || state.selectedEntryId === null) {
          const mode = ctx.canvasNavigation.getSnapshot().mode;
          if (mode.type === "node-focus" && mode.owner === "history") {
            clearOverride();
            ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "model", owner: "direct" });
          }
        }
        if (state.selectedEntryId === null || state.selectedEntryId === CURRENT_PRESENTATION_ID) {
          if (appliedOverrideEntryId !== null) clearOverride();
          return;
        }
        if (state.selectedEntryId === appliedOverrideEntryId) return;
        const detail = state.detail;
        if (!detail || detail.entryId !== state.selectedEntryId || detail.kind !== "model") return;
        const applied = applyModelOverride({ ctx, nodeId: state.nodeId, detail });
        if (applied) {
          appliedOverrideEntryId = state.selectedEntryId;
          overrideNodeId = state.nodeId;
          ctx.canvasNavigation.enterNodeFocus({ nodeId: state.nodeId, kind: "model", owner: "history" });
        }
      });
      ctx.effect(() => () => unsubscribeController(), "node-history-model-override");

      // feature capability：供其它 feature（测试）读取/关闭/选择。
      ctx.provide(NODE_HISTORY_SERVICE as never, {
        close: () => {
          closeFromPanel();
          appliedOverrideEntryId = null;
        },
        getState: () => controller.getState(),
        select: (entryId: string) => controller.select(entryId)
      } as never);

      // E2E/排障镜像：确定性打开历史面板（生产无副作用）。
      (globalThis as unknown as { __openNodeHistory?: unknown }).__openNodeHistory = (nodeId: string) => {
        const canvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
        const kind = node ? nodeHistoryKindForNodeType(node.type) : null;
        if (kind === "model" || kind === "image" || kind === "video") openNodeHistoryEntry(nodeId, kind);
        else ctx.canvasNavigation.openPanel({ type: NODE_HISTORY_PANEL_TYPE, nodeId });
      };
      (globalThis as unknown as { __nodeHistoryState?: unknown }).__nodeHistoryState = () => controller.getState();

      return () => {
        offOperations?.(); offHistoryRefresh?.();
        disposeInlineVersions();
        removeHistoryAction();
        disposeCanvasHistoryDialog();
        canvasHistoryController?.close();
        offEvent();
        disposePanel();
        unsubscribeNav();
        unsubscribeCanvas();
        unsubscribeFocus();
        unsubscribeController();
      };
    },
    {
      name: NODE_HISTORY_PLUGIN_ID,
      inject: ["canvasState", "compositeAssets", "slots", "canvasRuntime", "canvasRemote", "canvasSession", "dialogs", "canvasNavigation"]
    }
  );
}
