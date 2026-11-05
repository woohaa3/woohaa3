/**
 * 模型聚焦完整工作区（model-editor 入口 renderer）
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D1/D2/D3/D4；
 *   change: 2026-10-18-simplify-model-focus-panel）。
 *
 * 经 `canvas.focus-workspace`（kind=model）挂载为完整界面：公共顶部栏（返回/历史/标题/帮助）、
 * 主观察相机取景控件与右侧非模态检查器。
 *
 * 普通 `model3d` 只保留 **AI 修改**（生成为首要动作）与模型规模信息：镜头工具、镜头列表、
 * 镜头预览与截图已移除。
 */
import { useMemo, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ModelEditorSession } from "../../../extension-api/model-workspace-session.js";
import { ModelEditorOverlay } from "./model-editor-overlay.js";
import { ModelViewControls } from "./model-view-controls.js";
import { FocusHeader } from "../../focus/header.js";
import { useFocusLayout } from "../../focus/workspace.js";

const MODEL_HELP = "右键或 Alt + 拖动旋转；滚轮缩放";
const MODEL_HINT = "旋转：右键拖动 / Alt（Option）+ 左键拖动 / 触摸板双指滑动";

/**
 * 普通模型聚焦的卡片四周留白（CSS px）。
 *
 * 卡片外的区域由 `focus.css` 画成画布底色，看起来像预览窗浮在画布上。取 48 是「明显浮起
 * 又不吃掉太多取景区」的折中；改大只会让卡片更小，模型会按新内容矩形自动重新取景。
 */
const MODEL_FOCUS_CARD_INSET = 48;

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
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const nodeId = state.nodeId;
  // 右侧检查器只服务普通模型节点。
  const panel = nodeId !== null;
  // 浮动卡片外观（2026-11-04）：聚焦把内容区收进居中卡片，四周露出画布底色。
  const cardInset = MODEL_FOCUS_CARD_INSET;
  useFocusLayout(useMemo(() => ({ panel, cardInset }), [panel, cardInset]));

  return (
    <>
      <FocusHeader
        fallbackTitle="模型"
        help={MODEL_HELP}
        hint={MODEL_HINT}
        actions={nodeId ? <ModelViewControls nodeId={nodeId} /> : null}
      />
      <ModelEditorOverlay ctx={ctx} session={session} writable={writable} {...(canvasId ? { canvasId } : {})} />
    </>
  );
}
