/**
 * Canvas Runtime Plugin（change: 2026-09-28-split-frontend-god-plugins，task 2）。
 *
 * 从 canvas-shell 拆出的页面级画布运行时：装载 Bevy、创建纹理/视频帧/本地视口同步与
 * 交互控制器，并以 `canvasRuntime` Service 提供给 canvas-shell / model-editor 等消费方。
 * 它拥有运行时唯一实例，dispose 时统一撤销 socket/timer/listener（design D2）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { bevyKindForNodeType, prepareModelResource } from "@woohaa3/contracts";
import { DEFAULT_CANVAS_ID } from "../../services/canvas-session.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { canvasSearchStore } from "../../services/canvas-search-store.js";
import {
  MODEL_SCENES_SERVICE,
  RUN_STATE_SERVICE,
  INLINE_HISTORY_SERVICE,
  type InlineHistoryService,
  type ModelScenesProvider,
  type RunStateService
} from "../service-keys.js";
import { hasModelFocusTarget, resolveModelFocusTargets } from "../canvas-shell/model-focus-targets.js";
import type { FocusTargetInput } from "../canvas-shell/model-focus-session.js";
import { CanvasRuntimeHost, type CanvasRuntimeOptions } from "./host.js";
import type { CanvasRuntimeService } from "../../contracts.js";
import type { CanvasLayoutAdapter } from "../../navigation/contracts.js";
import { definePlugin } from "../../plugin.js";
import { documentWorkspaceAvailable, resolveFocusWorkspace, watchFocusWorkspace } from "../../focus/host.js";
import type { CanvasSlotProps } from "../../contract/platform.js";

export const CANVAS_RUNTIME_PLUGIN_ID = "canvas-runtime";
export const CANVAS_CONTEXT_MENU_TYPE = "canvas-context";

export type CanvasRuntimeExtensionOptions = Pick<
  CanvasRuntimeOptions,
  "loadRuntime" | "createVideoSessions" | "createCompositeAssetMediaSessions" | "onViewportChange"
> & {
  /** 已构造的运行时 host（测试注入）；缺省新建。 */
  canvasRuntime?: CanvasRuntimeService;
  canvasId?: string;
};

export function canvasRuntimeExtension(options: CanvasRuntimeExtensionOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const canvasId = options.canvasId ?? DEFAULT_CANVAS_ID;
      const resolvedTargets = (): FocusTargetInput[] => {
        const provider = ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined;
        const controller = host.controller();
        const resources = new Map(provider?.getResources() ?? []);
        // 历史本地 snapshot override 参与聚焦目标解析（任务 4.3）；override ops 即时 prepare。
        const focusNode = host.modelFocusProjection()?.nodeId ?? null;
        if (focusNode) {
          const override = host.modelSceneOverride(focusNode);
          if (override) {
            resources.set(
              focusNode,
              prepareModelResource({ sceneVersion: override.version, ops: override.ops as never })
            );
          }
        }
        return resolveModelFocusTargets({
          canvas: workingCanvasOf(woohaa3CanvasStore.getState()),
          viewport: controller?.viewport() ?? { x: 0, y: 0, zoom: 1 },
          surface: controller?.surface() ?? { width: 1, height: 1, pixelRatio: 1 },
          resources,
          nonCanonicalNodes: provider?.nonCanonicalNodes?.() ?? new Set()
        });
      };
      const host: CanvasRuntimeService =
        options.canvasRuntime ??
        new CanvasRuntimeHost({
          canvasId,
          compositeAssets: ctx.compositeAssets,
          getSession: () => ctx.canvasSession,
          getModelResources: () => {
            const provider = ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined;
            const versions = ctx.get(INLINE_HISTORY_SERVICE) as InlineHistoryService | undefined;
            return new Map([...(provider?.getResources() ?? []), ...(versions?.preview?.models ?? [])]);
          },
          isModelLoading: nodeId => {
            const provider = ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined;
            return provider?.isLoading?.(nodeId) ?? false;
          },
          getModelFocusTargets: resolvedTargets,
          hasModelFocusTarget: (nodeId) => {
            const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
            const provider = ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined;
            // override 在完整解析中也会生成资源；这里只查存在性，不重复 prepare。
            const resources = provider?.getResources();
            const focusedOverride = host.modelFocusProjection()?.nodeId === nodeId
              && host.modelSceneOverride(nodeId);
            if (focusedOverride) {
              const node = canvas?.document.nodes.find(node => node.id === nodeId);
              return !!node && bevyKindForNodeType(node.type) === "model";
            }
            return hasModelFocusTarget({ canvas, resources }, nodeId);
          },
          getTheme: () => ctx.theme.getSnapshot(),
          subscribeTheme: (listener) => ctx.theme.subscribe(listener),
          subscribeModelScenes: (listener) => {
            const provider = ctx.get(MODEL_SCENES_SERVICE) as ModelScenesProvider | undefined;
            const stop = provider?.subscribe(listener);
            const stopComposite = ctx.compositeAssets.subscribe(listener);
            return () => { stop?.(); stopComposite(); };
          },
          getRunState: () => {
            const service = ctx.get(RUN_STATE_SERVICE) as RunStateService | undefined;
            const versions = ctx.get(INLINE_HISTORY_SERVICE) as InlineHistoryService | undefined;
            const snapshot = service?.snapshot();
            if (snapshot && snapshot.canvasId !== canvasId) return null;
            return {
              summaries: [...(snapshot?.summaries.values() ?? [])],
              records: snapshot?.records ?? [],
              currentOperationByNode: service?.currentOperationByNode(),
              versionsByNode: versions?.snapshot(),
              groupStatuses: new Map(ctx.get("canvasGroupRuns")?.getSnapshot().rows.map(row => [row.creation.rootGroupId, { label: row.label, state: row.status }]) ?? []),
              selectedByNode: versions?.preview?.selected
            };
          },
          projectHistoryCanvas: canvas => {
            const versions = ctx.get(INLINE_HISTORY_SERVICE) as InlineHistoryService | undefined;
            return versions?.preview?.project(canvas) ?? canvas;
          },
          subscribeRunState: (listener) => {
            const service = ctx.get(RUN_STATE_SERVICE) as RunStateService | undefined;
            const versions = ctx.get(INLINE_HISTORY_SERVICE) as InlineHistoryService | undefined;
            const unsubscribe = service?.subscribe(listener);
            const unsubscribeCurrent = service?.subscribeCurrentOperations(listener);
            const unsubscribeVersions = versions?.subscribe(listener);
            const unsubscribeGroups = ctx.get("canvasGroupRuns")?.subscribe(listener);
            return () => { unsubscribe?.(); unsubscribeCurrent?.(); unsubscribeVersions?.(); unsubscribeGroups?.(); };
          },
          isModalActive: () => ctx.inputScopes.blocksCanvas(),
          // Ctrl/⌘+F 打开查找（只读仍可；change: 2026-10-09，任务 4.2）。
          onFindRequest: () => canvasSearchStore.open(),
          // 撤销/重做快捷键路由到页面编辑历史（任务 1.7）。
          onUndoRequest: () => void ctx.canvasEdit.undo(),
          onRedoRequest: () => void ctx.canvasEdit.redo(),
          // 结构动作经编辑历史提交（可撤销；任务 1.5）。
          onEditCommands: (commands, label) => { void ctx.canvasEdit.record(commands, label); },
          // 提交/回调错误不静默：记录诊断（手势仍由输入层复位）。
          onInteractionError: (error) => {
            console.error("[canvas-runtime] interaction error", error);
          },
          // 聚焦相机输入只被真正 modal Dialog 阻断（design D6）。
          isFocusInputBlocked: () => ctx.inputScopes.blocksFocusInput() || ctx.compositeAssets.blocksFocusInput(),
          prefersReducedMotion: () => prefersReducedMotion(),
          // 宿主转发目录中的 UI 请求；使用字面量 emit 供架构审计。
          emit: (name, payload) => {
            switch (name) {
              case "ui.node-history.switch-requested":
                ctx.emit("ui.node-history.switch-requested", payload as never);
                return;
              case "ui.media-preview.open-requested":
                ctx.emit("ui.media-preview.open-requested", payload as never);
                return;
              case "ui.text-preview.open-requested":
                ctx.emit("ui.text-preview.open-requested", payload as never);
                return;
              case "ui.video-frame-capture.open-requested":
                ctx.emit("ui.video-frame-capture.open-requested", payload as never);
                return;
              case "ui.node-history.open-requested":
                ctx.emit("ui.node-history.open-requested", payload as never);
                return;
              case "ui.shot-preview.enter-requested":
                ctx.emit("ui.shot-preview.enter-requested", payload as never);
                return;
            }
          },
          onMenuIntent: (intent) => {
            // 菜单 identity 交给 Canvas Navigation 统一持有（design D6）。
            ctx.canvasNavigation.openMenu({
              type: CANVAS_CONTEXT_MENU_TYPE,
              nodeId: intent.nodeId,
              screen: intent.screen,
              world: { x: intent.world.x, y: intent.world.y },
              ...(intent.connectFrom ? { connectFrom: intent.connectFrom } : {})
            });
          },
          onModelFocusIntent: (intent) => {
            // 双击 / Escape 统一经 Canvas Navigation（design D7）；退出先经退出协调结算净变化。
            // 通用纯模型扩展节点聚焦到 extension 工作区（宿主按焦点类型泛化，无业务分支）
            // （change: 2026-10-10-add-game-furnace-extension）。
            if (intent.type === "enter") void ctx.canvasNavigation.requestEnterNodeFocus({ nodeId: intent.nodeId, kind: intent.kind ?? "model", owner: "direct" });
            else void ctx.canvasNavigation.requestExitNodeFocus();
          },
          onModelFocusInvalid: (reason) => {
            // runtime 目标/projection 失效 → Navigation 原子收敛（design D5）。
            ctx.canvasNavigation.invalidateNodeFocus(reason);
          },
          onImageFocusIntent: (request) => {
            // 双击图片进入图片聚焦（change: 图片聚焦编辑，design D1）。
            void ctx.canvasNavigation.requestEnterNodeFocus({ nodeId: request.nodeId, kind: "image", owner: "direct" });
          },
          onVideoFocusIntent: (request) => {
            // 双击视频进入视频聚焦（change: 2026-10-10-add-video-node-focus-workspace，design D1）。
            void ctx.canvasNavigation.requestEnterNodeFocus({ nodeId: request.nodeId, kind: "video", owner: "direct" });
          },
          onShotPreviewEnterIntent: (request) => {
            // 双击拍摄镜头预览卡片：进入所属片场聚焦并选择该镜头（任务 5.4 / design D8）。
            // 归属由输入层严格解码，这里只经 Navigation 进入片场 focus；具体选择哪一路镜头由
            // 片场扩展消费 `ui.shot-preview.enter-requested` 时决定（宿主不猜默认镜头）。
            void ctx.canvasNavigation
              .requestEnterNodeFocus({ nodeId: request.filmSetNodeId, kind: "model", owner: "direct" })
              .then(result => {
                if (result.ok) ctx.emit("ui.shot-preview.enter-requested", request as never);
              });
          },
          ...(options.loadRuntime ? { loadRuntime: options.loadRuntime } : {}),
          ...(options.createVideoSessions ? { createVideoSessions: options.createVideoSessions } : {}),
          ...(options.createCompositeAssetMediaSessions ? { createCompositeAssetMediaSessions: options.createCompositeAssetMediaSessions } : {}),
          ...(options.onViewportChange ? { onViewportChange: options.onViewportChange } : {})
        });

      ctx.provide("canvasRuntime" as never, host as never);

      // 向 Canvas Navigation 注册 model-focus adapter（design D2/D7）。
      let applyingFocusTarget = false;
      const workspaceProps = (nodeId?: string): CanvasSlotProps => {
        const mode = ctx.canvasNavigation.getSnapshot().mode;
        return { canvas: workingCanvasOf(woohaa3CanvasStore.getState()), revision: ctx.canvasSession.getStatus().remote.confirmedRevision ?? 0, writable: ctx.canvasSession.isWritable(),
          focus: nodeId ? { nodeId, kind: "extension" } : mode.type === "node-focus" ? { nodeId: mode.nodeId, kind: mode.kind } : null };
      };
      const focusAdapter: CanvasLayoutAdapter = {
        apply: (target, transition) => {
          applyingFocusTarget = true;
          try {
            // 独立文档目标由 CanvasRuntimeHost 统一处理（清空节点投影）；节点目标转交 controller。
            const result = host.applyFocusTarget(target, transition);
            if (!result.ok) return result;
            // 退出/切换时清除 content rect 投影，避免悬空遮挡。
            if (!target) {
              host.setContentRect({ right: 0 });
            }
            return { ok: true };
          } finally {
            applyingFocusTarget = false;
          }
        },
        isFocused: () => host.isFocused(),
        isTargetValid: (nodeId, kind) => {
          const target = resolvedTargets().find((entry) => entry.nodeId === nodeId);
          // 通用纯模型扩展节点走同一批已解析目标（bevyKind = model）。
          if (kind === "extension") return resolveFocusWorkspace(ctx.slots, workspaceProps(nodeId)).ok && target !== undefined;
          if (kind === "model") return target !== undefined;
          // 图片/视频聚焦目标由各自 feature 解析（image/video focus targets）。
          if (kind === "video") return host.isVideoFocusTargetValid?.(nodeId) ?? false;
          return host.isImageFocusTargetValid?.(nodeId) ?? false;
        },
        // 独立文件文档目标由编辑 feature 提供的 slot 声明可用性；没有贡献时不可进入。
        isDocumentTargetValid: (documentId) => documentWorkspaceAvailable(ctx.slots, documentId),
        targetUnavailableReason: (nodeId, kind) => {
          if (kind !== "extension") return null;
          const result = resolveFocusWorkspace(ctx.slots, workspaceProps(nodeId));
          return result.ok ? "模型尚未准备完成，请稍后重试或检查模型错误。" : result.reason;
        },
        mode: () => host.modelFocusMode()
      };
      ctx.effect(() => {
        const remove = ctx.canvasNavigation.setFocusAdapter(focusAdapter);
        const stopWatching = watchFocusWorkspace({ slots: ctx.slots, navigation: ctx.canvasNavigation,
          props: () => workspaceProps(), subscribeCanvas: woohaa3CanvasStore.subscribe });
        return () => {
          stopWatching();
          if (ctx.canvasNavigation.getSnapshot().mode.type === "node-focus") ctx.canvasNavigation.invalidateNodeFocus("画布运行时已释放。");
          remove();
        };
      }, "canvas-runtime-focus-adapter");

      // runtime projection 意外丢失（renderer 重建/内部失败）→ Navigation 原子收敛（design D5）。
      const removeFocusReconcile = host.subscribeModelFocus(() => {
        // adapter 主动退出会先同步发布 projection=null，再由 Navigation 发布 overview；
        // 这属于同一次 transition，不能重入派发 invalidation。
        if (applyingFocusTarget) return;
        if (host.isFocused()) return;
        if (ctx.canvasNavigation.getSnapshot().mode.type !== "node-focus") return;
        ctx.canvasNavigation.invalidateNodeFocus("runtime-projection-lost");
      });
      ctx.effect(() => () => removeFocusReconcile(), "canvas-runtime-focus-reconcile");

      // 页面 scope 持有 renderer；输入表面挂载后由 CanvasHost 触发幂等装载。
      ctx.effect(() => {
        return () => {
          if (host instanceof CanvasRuntimeHost) host.dispose();
        };
      }, "canvas-runtime-load");
    },
    { name: CANVAS_RUNTIME_PLUGIN_ID, inject: ["compositeAssets", "canvasState", "canvasSession", "inputScopes", "theme", "canvasNavigation", "canvasEdit", "slots"] }
  );
}

/** 用户在系统层面偏好减少动态效果（change: enable-video-node-live-preview，design D3）。 */
function prefersReducedMotion(): boolean {
  const match = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  return match?.matches ?? false;
}
