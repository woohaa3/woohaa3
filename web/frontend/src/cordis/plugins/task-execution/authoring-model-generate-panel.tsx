/**
 * model3d authoring 的合并按需入口（change: 2026-10-27-merge-nonessential-panel-chunks）。
 *
 * 参考图装配（`AuthoringModelGenerateHost`）只是给 composer 注入 references renderer 的包装，
 * 没有独立激活路径，每次都被 composer 一起使用。让它与 composer 在**同一次**动态激活内解析，
 * 避免「先加载包装模块 → 渲染后再触发 composer 动态导入」的第二层串行等待。
 *
 * 文本路径不经过这里：文本面板不需要模型参考图 renderer，继续复用 `authoring-generate-panel`。
 */
import type { AuthoringGenerationProps } from "../../contract/authoring.js";
import { AuthoringGeneratePanel } from "./authoring-generate-panel.js";
import { AuthoringModelGenerateHost } from "./authoring-model-generate-host.js";

/** 真实 composer + 参考图 renderer 的合并入口；接收与 composer 相同的生成 props。 */
export function AuthoringModelGeneratePanel(props: AuthoringGenerationProps) {
  return <AuthoringModelGenerateHost {...props} render={AuthoringGeneratePanel} />;
}
