/**
 * 执行面板的呈现表面：所有节点共用同一套出现逻辑
 * （fix: 选中图片节点时面板先闪现在页面顶部，加载完才落到底部）。
 *
 * 回归原因：`ModelExecutionHost` 是 lazy 模块，而 `node-execution` definition 把**裸骨架**放进
 * Suspense fallback。骨架没有定位，按普通文档流贴在画布左上角；模块就绪后才出现
 * `position: fixed` 的底部 dock，于是先"闪现一下"再落到底部。
 *
 * 这与节点类型无关：图片、文本、视频、音频都会闪，只是图片最常被先选中；`model-node-editor`
 * 看不出问题，仅因为它把骨架包在了自己的 dock 里 —— 两个 definition 各自决定外壳，是唯一分歧。
 *
 * 现在表面只在这里描述，加载骨架与真实面板共用同一份判断与同一套 DOM 结构。
 */
import type { ReactNode } from "react";
import { AuthoringGeneratePlaceholder } from "../../host.js";
import { FullscreenPanelHost } from "./execution-panel/fullscreen-panel-host.js";
import { panelKindForNodeType } from "./node-panel-registry.js";
import type { ExecutionPanelPresentation } from "../../navigation/contracts.js";

/**
 * route presentation → 真实呈现表面。
 *
 * 音频面板没有展开面（`ExecutionPanel` 不为音频显示展开动作），因此 `expanded` 对它无效。
 */
export function resolveExecutionPanelSurface(
  presentation: ExecutionPanelPresentation | undefined,
  nodeType: string | null | undefined
): ExecutionPanelPresentation {
  return presentation === "expanded" && panelKindForNodeType(nodeType) !== "audio-generation"
    ? "expanded"
    : "compact";
}

export type ExecutionPanelSurfaceProps = {
  nodeId: string;
  presentation: ExecutionPanelPresentation;
  children: ReactNode;
};

/** 唯一表面：compact 贴底 dock / expanded 全屏宿主（非 Dialog）。 */
export function ExecutionPanelSurface({ nodeId, presentation, children }: ExecutionPanelSurfaceProps) {
  if (presentation === "expanded") {
    return <FullscreenPanelHost ariaLabel="节点执行面板（展开）">{children}</FullscreenPanelHost>;
  }
  return (
    <div className="node-execution-dock" data-node-id={nodeId} data-presentation="compact">
      {children}
    </div>
  );
}

/** 骨架本体：只提供面板轮廓，不含外壳。 */
export function ExecutionPanelSkeleton() {
  return <AuthoringGeneratePlaceholder />;
}

export type ExecutionPanelPendingProps = {
  nodeId: string;
  presentation: ExecutionPanelPresentation;
};

/**
 * 自带外壳的懒加载骨架。
 *
 * 用于 panel definition 自己不渲染外壳的场景（`node-execution`）；已经在外壳里的 definition
 * 应改用 {@link ExecutionPanelSkeleton}，避免出现嵌套 dock。
 */
export function ExecutionPanelPending({ nodeId, presentation }: ExecutionPanelPendingProps) {
  return (
    <ExecutionPanelSurface nodeId={nodeId} presentation={presentation}>
      <AuthoringGeneratePlaceholder />
    </ExecutionPanelSurface>
  );
}
