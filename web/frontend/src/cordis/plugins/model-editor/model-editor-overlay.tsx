/**
 * 普通模型聚焦的右侧检查器
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D1/D3；
 *   change: 2026-10-18-simplify-model-focus-panel）。
 *
 * 普通 `model3d` 聚焦**不再提供镜头、取景与截图**：面板只保留
 * - AI 修改入口（`authoring.generate`，mode=model3d）；
 * - 只读模型规模信息（对象/点数/面数等，见 `ModelInfoPanel`）。
 *
 * 片场（`composite-asset` + `extensionId="film-set"`）的检查器由扩展自己贡献，本组件不渲染。
 */
import { useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { isGlbModelNodeData } from "@woohaa3/contracts";
import type { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import { AuthoringGenerateHost } from "../../host.js";
import { ModelInfoPanel } from "./model-info-panel.js";

export function ModelEditorOverlay({ ctx, session, writable, canvasId }: {
  ctx: Context; session: ModelEditorSession; writable: boolean; canvasId?: string;
}) {
  useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getWorkingCanvas, ctx.canvasState.getWorkingCanvas);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const navigation = useSyncExternalStore(ctx.canvasNavigation.subscribe, ctx.canvasNavigation.getSnapshot, ctx.canvasNavigation.getSnapshot);
  const nodeId = state.nodeId;
  const canvas = ctx.canvasState.getWorkingCanvas() ?? ctx.canvasState.getCanvas();
  if (!nodeId || canvas?.document.nodes.find(node => node.id === nodeId)?.type !== "model3d") return null;
  const readOnly = ctx.canvasRuntime.modelFocusMode() === "history";
  const historyOpen = navigation.panel?.type === "node-history" && navigation.panel.nodeId === nodeId;
  const modelHash = (canvas.nodeData[nodeId]?.modelContentVersion as { contentHash?: string } | undefined)?.contentHash;
  // 文件模型不提供脚本修改入口：以原始 GLB 为唯一权威内容，只保留查看与下载
  // （change: 2026-10-28-support-glb-model-nodes，spec「文件模型仅提供可用操作」）。
  const fileModel = isGlbModelNodeData(canvas.nodeData[nodeId]);
  return (
    <div className="model-editor-dock" data-inspector="true" data-history-open={historyOpen ? "true" : undefined}>
      <div className="model-inspector-scroll">
        <ModelInfoPanel ctx={ctx} nodeId={nodeId} />
        {readOnly ? null : fileModel ? (
          <p className="model-inspector-file-model" role="note" data-file-model-note="true">
            文件模型：可查看并下载原 GLB，脚本修改不可用。
          </p>
        ) : (
          <div className="model-inspector-generate" data-generate-target="model">
            <AuthoringGenerateHost
              canvasId={canvasId ?? ""}
              nodeId={nodeId}
              mode="model3d"
              presentation="inspector"
              writable={writable}
              {...(modelHash ? { expectedContentHash: modelHash } : {})}
              onAuthorize={() => ctx.canvasNavigation.openDialog({ dialogId: "agent-assistant", payload: {} })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
