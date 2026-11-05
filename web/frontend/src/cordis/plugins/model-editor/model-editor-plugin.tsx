import { lazy, Suspense } from "react";
/**
 * 模型编辑 gizmo 与镜头工具栏 Plugin
 * （change: add-model-editor-gizmo-shot-capture，任务 2.2 / 2.3 / 3.2 / 4.x）。
 *
 * 拥有模型聚焦编辑期间的编辑会话（工具模式、镜头 CRUD/pose preview）：
 * - 进入/退出聚焦时开合会话；
 * - 把 `BevyModelEditor`（模型 gizmo 或选中镜头的 shot gizmo）推给 canvas runtime；
 * - 贡献完整聚焦工作区（`canvas.focus-workspace`，kind=model）：检查器 + 镜头预览。
 *
 * 只持有浏览器本地状态；canonical `modelCameras` 由画布命令写入，绝不进 Y.Doc 之外的
 * 第二份持久状态。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import {
  hashModelScript,
  modelContentIdentity,
  decodeModelPlacement,
  isModelNodeType
} from "@woohaa3/contracts";
import { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import { AuthoringGenerateHost } from "../../host.js";
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import {
  addCamera,
  defaultDistanceForNode,
  pushEditor,
  readCameras,
  submitCameras
} from "./model-camera-store.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { MODEL_EDITOR_SERVICE, type ModelEditorService } from "../service-keys.js";
import { definePlugin } from "../../plugin.js";

// Camera controls and the focused workspace load when their renderer is opened.
const ModelEditorToolbar = lazy(() => import("./model-editor-toolbar.js").then(module => ({ default: module.ModelEditorToolbar })));
const ModelCameraPreview = lazy(() => import("./model-camera-preview.js").then(module => ({ default: module.ModelCameraPreview })));
const ModelEditorWorkspace = lazy(() => import("./model-editor-workspace.js").then(module => ({ default: module.ModelEditorWorkspace })));

export const MODEL_EDITOR_PLUGIN_ID = "model-editor";
const MODEL_EDITOR_WORKSPACE_ID = "model-editor-workspace";

export type ModelEditorPluginOptions = {
  canvasId?: string;
};

export function modelEditorExtension(options: ModelEditorPluginOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const session = new ModelEditorSession({
        readCameras: (nodeId) => readCameras(nodeId),
        isWritable: () => ctx.canvasSession.isWritable() && ctx.canvasRuntime.modelFocusMode() !== "history",
        submitCameras: (nodeId, cameras) => submitCameras(ctx, nodeId, cameras),
        revokeObjectUrl: (url) => URL.revokeObjectURL?.(url)
      });

      /**
       * 当前是否历史只读浏览（change: 对齐 xyflow-bevy 历史只读浏览）。
       * 历史 owner 活跃时禁止一切模型/镜头写入：不推 gizmo、禁镜头 CRUD/pose、禁截图。
       */
      const isHistoryMode = (): boolean => ctx.canvasRuntime.modelFocusMode() === "history";

      // 聚焦投影变化：进入时开会话，退出时关会话并清除 gizmo。
      // 同一节点、同一 owner 的朝向/距离变化不重推 gizmo；历史切换仍需清除/恢复投影。
      let previousHistoryMode = isHistoryMode();
      const unsubscribeFocus = ctx.canvasRuntime.subscribeModelFocus(() => {
        const historyMode = isHistoryMode();
        const ownerChanged = historyMode !== previousHistoryMode;
        previousHistoryMode = historyMode;
        const candidate = ctx.canvasRuntime.modelFocusProjection()?.nodeId ?? null;
        const currentCanvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        const focused = currentCanvas?.document.nodes.some(node => node.id === candidate && isModelNodeType(node.type)) ? candidate : null;
        const current = session.getState().nodeId;
        if (focused && focused !== current) {
          session.enter(focused);
          beginModelSession(focused);
          pushEditor(ctx, session);
          return;
        }
        if (focused && ownerChanged) {
          pushEditor(ctx, session);
        }
        if (!focused && current) {
          session.exit();
          ctx.canvasRuntime.setModelEditor(null);
        }
      });
      ctx.effect(() => () => unsubscribeFocus(), "model-editor-focus");

      // 权威画布/模型内容变化 → 镜头列表与 gizmo 取景同步。
      const unsubscribeCanvas = woohaa3CanvasStore.subscribe(() => { session.reconcileGesture(); pushEditor(ctx, session); });
      ctx.effect(() => () => unsubscribeCanvas(), "model-editor-canvas");
      const unsubscribePermission = ctx.canvasSession.subscribe(() => { session.reconcileGesture(); pushEditor(ctx, session); });
      ctx.effect(() => () => unsubscribePermission(), "model-editor-permission");

      ctx.provide("modelWorkspace" as never, {
        session,
        defaultDistance: (nodeId: string) => defaultDistanceForNode(nodeId, ctx),
        addCamera: () => addCamera(ctx, session),
        refreshGizmo: () => pushEditor(ctx, session),
        // 扩展拥有布局时经此渲染生成入口：宿主包裹 `authoring.generate`
        // 贡献并注入目标身份、MCP 指引与 Agent 会话能力（design D6/D8），避免扩展直接读 slot
        // 而漏掉会话注入、看不到详情入口。
        renderGenerate: (input: AuthoringGenerationProps) => <AuthoringGenerateHost {...input} />,
        renderCameraPanel: (input: Parameters<import("../../../extension-api/model-workspace.js").ModelWorkspaceService["renderCameraPanel"]>[0]) => <Suspense fallback={null}><ModelEditorToolbar session={session}
          {...input} rendererReady={ctx.canvasRuntime.runtime()?.isReady() ?? false}
          defaultDistance={defaultDistanceForNode(session.getState().nodeId ?? "", ctx)} onAddCamera={() => addCamera(ctx, session)} /></Suspense>,
        renderCameraPreview: (readOnly: boolean) => <Suspense fallback={null}><ModelCameraPreview session={session} readOnly={readOnly} /></Suspense>
      } as never);

      // 完整聚焦工作区（change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D3）：
      // model-editor 拥有完整界面（公共顶部栏 + 检查器），kind=model；普通模型只保留 AI 修改与
      // 模型信息。
      const removeWorkspace = ctx.slots.register("canvas.focus-workspace", {
        id: MODEL_EDITOR_WORKSPACE_ID,
        owner: MODEL_EDITOR_PLUGIN_ID,
        kind: "model",
        available: () => session.getState().nodeId !== null,
        render: ({ writable }) => <Suspense fallback={null}><ModelEditorWorkspace ctx={ctx} session={session} writable={writable} {...(options.canvasId ? { canvasId: options.canvasId } : {})} /></Suspense>
      });
      ctx.effect(() => () => removeWorkspace(), "model-editor-workspace");

      // 编辑态变化更新 shot rig；有选中镜头时它就是主画面。
      const unsubscribeEditor = session.subscribe(() => {
        pushEditor(ctx, session);
      });
      ctx.effect(() => () => unsubscribeEditor(), "model-editor-projection");

      // feature capability：供测试/其它 feature 读取状态与关闭。
      ctx.provide(MODEL_EDITOR_SERVICE as never, {
        session,
        close: () => {
          session.exit();
          ctx.canvasRuntime.setModelEditor(null);
        },
        getState: () => session.getState()
      } as ModelEditorService as never);

      // ── 会话级最终归档（change: 图片聚焦编辑，design D5/D6） ──────────────────────
      // 进入模型聚焦时 lazily begin 编辑会话；退出经统一退出协调在返回时归档一次最终版本。
      // 会话内 camera 手势仍及时 durable 提交 canonical（下一帧 flush），此处只登记
      // 会话关联，不推进 revision。
      const canvasId = options.canvasId ?? "default";
      let modelSessionId: string | null = null;
      let modelRequestId: string | null = null;
      let modelBegin: ReturnType<typeof ctx.canvasRemote.editBegin> | null = null;
      let baselineSourceHash = "";

      const beginModelSession = (nodeId: string) => {
        if (isHistoryMode()) return;
        if (modelSessionId && session.getState().nodeId === nodeId) return;
        modelSessionId = `model-session-${globalThis.crypto?.randomUUID?.() ?? `${nodeId}-${Date.now().toString(36)}`}`;
        modelRequestId = null;
        const data = (workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas)?.nodeData[nodeId] as Record<string, unknown> | undefined;
        const source = typeof data?.modelScript === "string" ? data.modelScript : "";
        baselineSourceHash = hashModelScript(source);
        // 无可归档模型内容（模型脚本为空）时不建立归档会话：否则聚焦退出会被无意义的
        // 「模型编辑会话」永久占据、无法结算。
        if (source === "") {
          modelSessionId = null;
          modelBegin = null;
          return;
        }
        modelBegin = ctx.canvasRemote
          .editBegin({
            canvasId,
            nodeId,
            sessionId: modelSessionId,
            requestId: `begin:${modelSessionId}`,
            kind: "model",
            baselineContentIdentity: modelContentIdentity(baselineSourceHash, decodeModelPlacement(data?.modelPlacement) ?? undefined)
          });
        void modelBegin.catch(() => undefined);
      };

      const modelExitParticipant = ctx.focusExit.register({
        id: `${MODEL_EDITOR_PLUGIN_ID}-session`,
        hasUnsavedChanges: () => session.getState().nodeId !== null && (modelSessionId !== null || session.getState().posePreview !== null || session.getState().focusPreview !== null),
        prepare: async () => {
          session.commitForCapture();
          const nodeId = session.getState().nodeId;
          const sessionId = modelSessionId;
          if (!nodeId || !sessionId) return { ok: true };
          const begun = await modelBegin;
          if (!begun?.ok) return { ok: false, reason: begun && !begun.ok ? begun.error : "编辑会话尚未就绪" };
          const data = (workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas)?.nodeData[nodeId] as Record<string, unknown> | undefined;
          const finalSourceHash = hashModelScript(typeof data?.modelScript === "string" ? data.modelScript : "");
          modelRequestId = modelRequestId ?? `model-complete-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
          const result = await ctx.canvasRemote.editComplete?.({
            canvasId,
            nodeId,
            sessionId,
            requestId: modelRequestId,
            kind: "model",
            baselineContentIdentity: begun.value.baselineContentIdentity,
            model: { baselineSourceHash, finalSourceHash }
          });
          if (result && !result.ok) return { ok: false, reason: result.error };
          modelSessionId = null;
          modelRequestId = null;
          return { ok: true };
        },
        abandon: () => {
          modelSessionId = null;
          modelRequestId = null;
        }
      });

      // E2E/排障镜像（生产无副作用）。
      (globalThis as unknown as { __modelEditorState?: unknown }).__modelEditorState = () => session.getState();
      (globalThis as unknown as { __modelEditorGizmo?: unknown }).__modelEditorGizmo = () =>
        ctx.canvasRuntime.modelEditorState();
      (globalThis as unknown as { __modelEditor?: unknown }).__modelEditor = {
        state: () => session.getState(),
        gizmo: () => ctx.canvasRuntime.modelEditorState(),
        cameras: () => session.cameras(),
        mode: () => ctx.canvasRuntime.modelFocusMode(),
        addCamera: () => addCamera(ctx, session),
        selectCamera: (id: string) => session.selectCamera(id),
        removeCamera: (id: string) => session.removeCamera(id),
        setToolMode: (mode: "model" | "camera") => session.setToolMode(mode)
      };

      return () => {
        modelExitParticipant();
        removeWorkspace();
        unsubscribeFocus();
        unsubscribeEditor();
        unsubscribeCanvas();
        session.exit();
      };
    },
    { name: MODEL_EDITOR_PLUGIN_ID, inject: ["nodeImplementations", "canvasState", "slots", "canvasRuntime", "canvasRemote", "canvasSession", "canvasEdit", "mediaRemote", "focusExit", "canvasNavigation"] }
  );
}

// 镜头存取/目标解析/gizmo 派生见同目录模块
// （change: 2026-09-28-split-frontend-god-plugins，task 4.5）。
