import { contributionLifetime } from "../contributions.js";
import { createElement, type ReactNode } from "react";
import type { CanvasLocateService, AgentConversationService, CanvasNavigationService, CanvasRemoteService, CanvasRuntimeService, CanvasScopeService, CanvasStoreFacade, ContextMenuContext, DialogsService, SlotsService } from "@woohaa3/frontend/extension-api";
import { FilmSetConversionAction, type FilmSetConversionActionDependencies } from "../../../authoring/browser/film-set-conversion/action.js";
import { createFilmSetConversionDialog, FILM_SET_CREATION_DIALOG_ID } from "../../../authoring/browser/film-set-conversion/settings.js";
import { createFilmSetConversionClient } from "../../../authoring/browser/film-set-conversion/client.js";
import { createFilmSetConversionController, type FilmSetConversionController } from "../../../authoring/browser/film-set-conversion/controller.js";
import { resolveFilmSetConversionAvailability } from "../../../authoring/browser/film-set-conversion/view.js";
import { createFilmSetConversionPreferenceStore } from "../../../authoring/browser/film-set-conversion/preference.js";
import { ownsShotMedia } from "../../../state/shared/managed-shot-media.js";

/**
 * 「转为片场」入口注册（toolbar / 右键菜单 / 聚焦标题栏）
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.4/3.5 / design D6）。
 *
 * film-set 通过**通用宿主接缝**贡献同一转换动作：`canvas.node-action`（节点顶部横条）、
 * `canvas.context-menu`（右键菜单）与 `canvas.focus-header`（聚焦工作区）。三者共享同一个
 * **控制器**（同一转换客户端、偏好与请求身份工厂），因此不会产生不同目标或重复请求。宿主
 * MUST NOT import 本实现；本模块也不按宿主内部路径拼请求。
 */
import { readFilmSetConversionNodeStatus, readFilmSetConversionSourceKind } from "@woohaa3/contracts";
import { presentFilmSetConversionStatus } from "../../../authoring/browser/film-set-conversion/presentation.js";

/** 右键菜单项稳定 ID。 */
export const FILM_SET_CONVERSION_MENU_ID = "film-set-conversion";

type ConversionContext = {
  get?(key: never): unknown;
  canvasScope: CanvasScopeService;
  canvasRemote: CanvasRemoteService;
  canvasLocate: CanvasLocateService;
  canvasNavigation: CanvasNavigationService;
  canvasState: CanvasStoreFacade;
  canvasRuntime: CanvasRuntimeService;
  slots: SlotsService;
  dialogs: DialogsService;
  canvasSession: { isWritable(): boolean };
};

/** 组装共享依赖：同一控制器（内部同一 client 与偏好 store）与同一画布读取。 */
export function createFilmSetConversionActions(ctx: ConversionContext): {
  deps: FilmSetConversionActionDependencies;
  controller: FilmSetConversionController;
} {
  const client = createFilmSetConversionClient(ctx.canvasRemote);
  const assistant = ctx.get?.("agentConversationService" as never) as AgentConversationService | undefined;
  const preferences = createFilmSetConversionPreferenceStore();
  const getCanvas = () => ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  const openFilmSet = (nodeId: string) => { ctx.canvasLocate.locateNodes([nodeId]); };
  const controller = createFilmSetConversionController({
    canvasId: ctx.canvasScope.canvasId(),
    getDataScopeId: () => assistant?.getDataScopeId?.() ?? "page",
    client,
    preferences,
    getCanvas,
    isWritable: () => ctx.canvasSession.isWritable(),
    openFilmSet,
    openCreationDialog: ({ nodeId, nodeType }) => { ctx.canvasNavigation.openDialog({ dialogId: FILM_SET_CREATION_DIALOG_ID, payload: { nodeId, nodeType } }); }
  });
  const deps: FilmSetConversionActionDependencies = {
    assistant,
    canvasId: ctx.canvasScope.canvasId(),
    controller,
    preferences,
    getCanvas,
    subscribeCanvas: ctx.canvasState.subscribe,
    // 复用既有授权/Provider 设置入口；配置返回原草稿，不自动开始（组件在「开始转换」时才提交）。
    openConnectChatGpt: () => { ctx.canvasNavigation.openDialog({ dialogId: "provider-credentials", payload: {} }); },
    openConfigureModel: () => { ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: {} }); },
    openFilmSet
  };
  return { deps, controller };
}

/** 渲染同一转换动作（宿主 slot 只提供通用 props）。 */
function renderAction(deps: FilmSetConversionActionDependencies) {
  return (props: { nodeId: string; nodeType: string; writable: boolean }): ReactNode =>
    createElement(FilmSetConversionAction, { nodeId: props.nodeId, nodeType: props.nodeType, writable: props.writable, deps });
}

/**
 * 注册三个入口；返回释放函数。释放只移除本扩展贡献与本地订阅，不清除已创建片场，也不改变
 * 宿主的下载贡献（design D6：film-set 停用只移除转换动作）。
 */
export function installFilmSetConversionEntries(ctx: ConversionContext): () => void {
  const { deps } = createFilmSetConversionActions(ctx);
  const lifetime = contributionLifetime();
  const disposers = { push: lifetime.own };
  try {
  const Action = renderAction(deps);
  disposers.push(ctx.dialogs.registerDialog(FILM_SET_CREATION_DIALOG_ID, {
    definition: {
      singleton: true, size: "md", dismissible: true,
      validatePayload: payload => {
        const value = payload as { nodeId?: unknown; nodeType?: unknown } | null;
        return value && typeof value.nodeId === "string" && (value.nodeType === "image" || value.nodeType === "video")
          ? { ok: true, payload: { nodeId: value.nodeId, nodeType: value.nodeType } }
          : { ok: false, error: "请选择图片或视频素材" };
      }
    },
    renderer: createFilmSetConversionDialog(deps, ctx.dialogs)
  }));

  // 1) 节点顶部横条：横条本体由 Bevy 绘制、Rust 命中，此处只提供**纯数据描述**、命中派发与
  //    创建 Dialog（order -10 使其位于宿主下载之前）。
  disposers.push(ctx.slots.register("canvas.node-action", {
    id: "film-set-conversion",
    owner: "film-set",
    order: -10,
    contentAction: "convert",
    // Hide the action for the extension's own managed shot media; other supported
    // sources remain visible while readiness and write permission only disable it.
    available: ({ nodeId, nodeType }) => {
      if (readFilmSetConversionSourceKind(nodeType) === null) return false;
      return !ownsShotMedia(deps.getCanvas(), nodeId);
    },
    describe: ({ nodeId, nodeType, writable }) => {
      const availability = resolveFilmSetConversionAvailability({ canvas: deps.getCanvas(), nodeId, nodeType, writable });
      return {
        label: "创建片场",
        enabled: availability.available,
        tone: "primary" as const,
        ...(availability.available ? {} : { reason: availability.reason })
      };
    },
    activate: ({ nodeId, nodeType }) => {
      if (!resolveFilmSetConversionAvailability({ canvas: deps.getCanvas(), nodeId, nodeType, writable: deps.controller.state.isWritable() }).available) return;
      void deps.controller.activate({ nodeId, nodeType, writable: deps.controller.state.isWritable() });
    }
  }));

  // 2) 右键菜单：与横条共用同一动作与请求身份（不产生不同目标）。
  disposers.push(ctx.slots.register("canvas.context-menu", {
    id: `${FILM_SET_CONVERSION_MENU_ID}-menu`,
    owner: "film-set",
    priority: 12,
    items: ({ nodeId, connectFrom }: ContextMenuContext) => {
      if (!nodeId || connectFrom) return [];
      if (ownsShotMedia(deps.getCanvas(), nodeId)) return [];
      const node = deps.getCanvas()?.document.nodes.find((entry) => entry.id === nodeId);
      if (!node) return [];
      const availability = resolveFilmSetConversionAvailability({ canvas: deps.getCanvas(), nodeId, nodeType: node.type, writable: deps.controller.state.isWritable() });
      if (!availability.available && availability.reason === "此类节点暂不支持转为片场") return [];
      return [{ id: FILM_SET_CONVERSION_MENU_ID, label: "创建片场", disabled: !availability.available }];
    },
    onSelect: (itemId, context) => {
      if (itemId !== FILM_SET_CONVERSION_MENU_ID || !context.nodeId) return;
      const node = deps.getCanvas()?.document.nodes.find((entry) => entry.id === context.nodeId);
      if (!node) return;
      void deps.controller.activate({ nodeId: context.nodeId, nodeType: node.type, writable: deps.controller.state.isWritable() });
    }
  }));

  // 3) 聚焦标题栏：图片/视频/3D 聚焦时提供同一动作（不强制退出聚焦、不打开聊天）。
  disposers.push(ctx.slots.register("canvas.focus-header", {
    id: "film-set-conversion-focus",
    owner: "film-set",
    position: "after-title",
    render: ({ nodeId }: { nodeId: string }) => {
      const node = deps.getCanvas()?.document.nodes.find((entry) => entry.id === nodeId);
      if (!node || !resolveFilmSetConversionAvailability({ canvas: deps.getCanvas(), nodeId, nodeType: node.type, writable: deps.controller.state.isWritable() }).available) return null;
      return Action({ nodeId, nodeType: node.type, writable: deps.controller.state.isWritable() });
    }
  }));

  // Delivery status is contributed as data to the host execution panel; no artwork overlay.
  disposers.push(ctx.slots.register("authoring.delivery", {
    id: "film-set-conversion-delivery", owner: "film-set",
    resolve: ({ canvasId, nodeId, data }) => {
      if (canvasId !== deps.canvasId) return null;
      const status = readFilmSetConversionNodeStatus(data);
      if (!status) return null;
      const presentation = presentFilmSetConversionStatus(status);
      const execution = status.execution?.canvasId === canvasId && status.execution.targetNodeId === nodeId ? status.execution : undefined;
      return { execution, domain: { requestId: status.requestId, sourceNodeId: status.sourceNodeId, targetNodeId: nodeId,
          ...(status.status === "completed" ? { commandId: status.commandId } : {}) },
        status: status.status === "completed" ? "succeeded" : status.status === "running" ? status.step === "validate-and-save" ? "committing" : "running" : status.status,
        stage: status.status === "running" ? presentation.step ?? presentation.label : presentation.label,
        ...(status.status === "failed" ? { reason: status.message } : {}),
        query: () => deps.controller.queryRequest({ requestId: status.requestId }),
        ...(presentation.cancellable ? { cancel: () => deps.controller.cancelRequest({ requestId: status.requestId }) } : {}),
        ...(presentation.retryable ? { retry: () => deps.controller.retryRequest({ requestId: status.requestId }) } : {}),
      };
    },
  }));

  disposers.push(deps.controller.subscribe(() => { ctx.canvasRuntime.controller()?.invalidate(); }));

  return () => lifetime.dispose();
  } catch (error) { lifetime.dispose(); throw error; }
}
