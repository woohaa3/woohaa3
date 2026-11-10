import { lazy, Suspense } from "react";
/**
 * 模型聚焦工作区插件。
 *
 * 模型镜头 CRUD、pose/focus gizmo、镜头预览与截图已删除；普通 model3d 聚焦只保留
 * AI 修改入口与模型规模信息，本插件负责节点聚焦状态和编辑会话归档。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { hashModelScript, modelContentIdentity, decodeModelPlacement, isModelNodeType } from "@woohaa3/contracts";
import { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../services/canvas-state/index.js";
import { MODEL_EDITOR_SERVICE, type ModelEditorService } from "../service-keys.js";
import { definePlugin } from "../../plugin.js";

const ModelEditorWorkspace = lazy(() => import("./model-editor-workspace.js").then(module => ({ default: module.ModelEditorWorkspace })));

export const MODEL_EDITOR_PLUGIN_ID = "model-editor";
const MODEL_EDITOR_WORKSPACE_ID = "model-editor-workspace";

export type ModelEditorPluginOptions = { canvasId?: string };

export function modelEditorExtension(options: ModelEditorPluginOptions = {}): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const session = new ModelEditorSession();
      const isHistoryMode = (): boolean => ctx.canvasRuntime.modelFocusMode() === "history";

      const unsubscribeFocus = ctx.canvasRuntime.subscribeModelFocus(() => {
        const candidate = ctx.canvasRuntime.modelFocusProjection()?.nodeId ?? null;
        const currentCanvas = workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas;
        const focused = currentCanvas?.document.nodes.some(node => node.id === candidate && isModelNodeType(node.type)) ? candidate : null;
        const current = session.getState().nodeId;
        if (focused && focused !== current) {
          session.enter(focused);
          beginModelSession(focused);
          return;
        }
        if (!focused && current) session.exit();
      });
      ctx.effect(() => () => unsubscribeFocus(), "model-editor-focus");

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
        if (source === "") {
          modelSessionId = null;
          modelBegin = null;
          return;
        }
        modelBegin = ctx.canvasRemote.editBegin({
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
        hasUnsavedChanges: () => session.getState().nodeId !== null && modelSessionId !== null,
        prepare: async () => {
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

      const removeWorkspace = ctx.slots.register("canvas.focus-workspace", {
        id: MODEL_EDITOR_WORKSPACE_ID,
        owner: MODEL_EDITOR_PLUGIN_ID,
        kind: "model",
        available: () => session.getState().nodeId !== null,
        render: ({ writable }) => <Suspense fallback={null}><ModelEditorWorkspace ctx={ctx} session={session} writable={writable} {...(options.canvasId ? { canvasId: options.canvasId } : {})} /></Suspense>
      });
      ctx.effect(() => () => removeWorkspace(), "model-editor-workspace");

      ctx.provide(MODEL_EDITOR_SERVICE as never, {
        session,
        close: () => session.exit(),
        getState: () => session.getState()
      } as ModelEditorService as never);

      (globalThis as unknown as { __modelEditorState?: unknown }).__modelEditorState = () => session.getState();

      return () => {
        modelExitParticipant();
        removeWorkspace();
        unsubscribeFocus();
        session.exit();
      };
    },
    { name: MODEL_EDITOR_PLUGIN_ID, inject: ["nodeImplementations", "canvasState", "slots", "canvasRuntime", "canvasRemote", "canvasSession", "canvasEdit", "mediaRemote", "focusExit", "canvasNavigation"] }
  );
}
