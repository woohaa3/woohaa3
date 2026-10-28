/**
 * 模型聚焦完整工作区（model-editor 入口 renderer）
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D1/D2/D3/D4；
 *   change: 2026-10-18-simplify-model-focus-panel）。
 *
 * 经 `canvas.focus-workspace`（kind=model）挂载为完整界面：公共顶部栏（返回/历史/标题/帮助）、
 * 主观察相机取景控件与右侧非模态检查器。
 *
 * 普通 `model3d` 只保留 **AI 修改**（生成为首要动作）与模型规模信息：镜头工具、镜头列表、
 * 镜头预览与截图已移除。片场（`extensionId="film-set"`）继续由扩展检查器拥有对象/镜头/动画
 * 页，本工作区只为它保留镜头开关与取景控件。
 *
 * 工具开关是本 editor 的局部状态，经 `useFocusLayout` 以布局快照上报，公共层不拥有 toolsOpen。
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import { ModelEditorOverlay } from "./model-editor-overlay.js";
import { ModelViewControls } from "./model-view-controls.js";
import { useFocusedModelKind } from "./model-focus-kind.js";
import { Button } from "@woohaa3/ui/primitives";
import { FocusHeader } from "../../focus/header.js";
import { useFocusLayout } from "../../focus/workspace.js";

const MODEL_HELP = "右键或 Alt + 拖动旋转；滚轮缩放";
const MODEL_HINT = "旋转：右键拖动 / Alt（Option）+ 左键拖动 / 触摸板双指滑动";

export function ModelEditorWorkspace({
  ctx,
  session,
  writable,
  canvasId
}: {
  ctx: Context;
  session: ModelEditorSession;
  writable: boolean;
  canvasId?: string;
}) {
  const [toolsOpen, setToolsOpen] = useState(true);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const navigation = useSyncExternalStore(ctx.canvasNavigation.subscribe, ctx.canvasNavigation.getSnapshot, ctx.canvasNavigation.getSnapshot);
  const nodeId = state.nodeId;
  // 片场仍由扩展检查器提供镜头工具；普通模型已移除整套镜头控制。
  const filmSet = useFocusedModelKind(ctx, nodeId) === "film-set";
  // 片场动画预览占位：由组合资产 owner 派生的通用布尔（宿主不知道具体业务）。
  const animationPreview = useSyncExternalStore(
    ctx.compositeAssets.subscribe,
    () => ctx.compositeAssets.blocksFocusInput(),
    () => false
  );
  // 普通模型仍需要右侧检查器（AI 修改 + 信息）；片场由扩展检查器承载，可经「镜头工具」收起。
  const panel = filmSet ? toolsOpen : nodeId !== null;
  useFocusLayout(useMemo(() => ({ panel, animationPreview }), [panel, animationPreview]));

  const historyOpen = navigation.panel?.type === "node-history" && navigation.panel.nodeId === nodeId;
  return (
    <>
      <FocusHeader
        fallbackTitle="模型"
        help={MODEL_HELP}
        hint={MODEL_HINT}
        actions={
          <>
            {filmSet ? (
              <Button size="sm" aria-pressed={toolsOpen} disabled={!nodeId} onClick={() => {
                if (historyOpen) void ctx.canvasNavigation.requestCloseNodeHistory();
                else setToolsOpen((value) => !value);
              }}>镜头工具</Button>
            ) : null}
            {nodeId ? <ModelViewControls nodeId={nodeId} /> : null}
          </>
        }
      />
      <ModelEditorOverlay ctx={ctx} session={session} writable={writable} {...(canvasId ? { canvasId } : {})} />
    </>
  );
}
