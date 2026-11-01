/**
 * 执行面板的呈现表面：所有节点共用同一套出现逻辑
 * （fix: 选中图片节点时面板先闪现在页面顶部，加载完才落到节点锚点）。
 *
 * 回归原因：`ModelExecutionHost` 是 lazy 模块，而 `node-execution` definition 把**裸骨架**放进
 * Suspense fallback。骨架没有定位，按普通文档流贴在画布左上角；模块就绪后才出现
 * 定位 dock，于是先"闪现一下"再落到目标位置。
 *
 * 这与节点类型无关：图片、文本、视频、音频都会闪，只是图片最常被先选中；`model-node-editor`
 * 看不出问题，仅因为它把骨架包在了自己的 dock 里 —— 两个 definition 各自决定外壳，是唯一分歧。
 *
 * 现在表面只在这里描述，加载骨架与真实面板共用同一份判断与同一套 DOM 结构。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { AuthoringGeneratePlaceholder } from "../../host.js";
import type { CanvasRuntimeService } from "../../contracts.js";
import { layoutNodePanel, usableCanvasArea, type AnchoredPanel } from "./node-anchor-layout.js";
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
  runtime?: CanvasRuntimeService;
  children: ReactNode;
};

/** 唯一表面：compact 节点锚定宿主 / expanded 全屏宿主（非 Dialog）。 */
export function ExecutionPanelSurface({ nodeId, presentation, runtime, children }: ExecutionPanelSurfaceProps) {
  if (presentation === "expanded") {
    return <FullscreenPanelHost ariaLabel="节点执行面板（展开）">{children}</FullscreenPanelHost>;
  }
  return (
    <AnchoredDock nodeId={nodeId} runtime={runtime}>{children}</AnchoredDock>
  );
}

function AnchoredDock({ nodeId, runtime, children }: { nodeId: string; runtime?: CanvasRuntimeService; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastPlacement = useRef<AnchoredPanel["placement"] | undefined>(undefined);
  useEffect(() => {
    if (!runtime || !ref.current) return;
    let frame = 0;
    const applyLayout = () => {
      const dock = ref.current;
      const canvas = document.getElementById("bevy-canvas");
      const fixtureArea = dock?.closest<HTMLElement>("[data-node-anchor-area]") ?? null;
      const areaElement = fixtureArea ?? canvas;
      const node = runtime.nodeScreenRect(nodeId);
      if (!dock || !areaElement || !node) {
        if (dock) {
          dock.style.visibility = "hidden";
          dock.removeAttribute("data-placement");
        }
        return;
      }
      const bounds = areaElement.getBoundingClientRect();
      const area = usableCanvasArea({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }, fixtureArea ? [] : visibleOcclusions());
      const next = layoutNodePanel(node, area, { width: dock.offsetWidth, height: dock.offsetHeight }, lastPlacement.current);
      if (!next) {
        dock.style.visibility = "hidden";
        dock.removeAttribute("data-placement");
        return;
      }
      lastPlacement.current = next.placement;
      const layout = fixtureArea ? { ...next, left: next.left - bounds.left, top: next.top - bounds.top } : next;
      dock.style.position = fixtureArea ? "absolute" : "fixed";
      dock.style.left = `${layout.left}px`;
      dock.style.top = `${layout.top}px`;
      dock.style.width = `${layout.width}px`;
      dock.style.maxHeight = `${layout.maxHeight}px`;
      dock.style.visibility = "visible";
      dock.dataset.placement = layout.placement;
    };
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => applyLayout());
    };
    const unsubscribeViewport = runtime.subscribeViewport(refresh);
    const unsubscribeScene = runtime.subscribeScene?.(refresh);
    const unsubscribeFrame = runtime.subscribeFrame?.(applyLayout);
    const observer = new ResizeObserver(refresh);
    observer.observe(ref.current);
    const canvas = ref.current.closest("[data-node-anchor-area]") ?? document.getElementById("bevy-canvas");
    if (canvas) observer.observe(canvas);
    const app = document.querySelector<HTMLElement>(".app");
    const observedOcclusions = new Set<HTMLElement>();
    let mutations: MutationObserver | undefined;
    const visibleOcclusions = () => Array.from(document.querySelectorAll<HTMLElement>(".model-editor-dock[data-inspector], .focus-workspace__panel"))
      .filter((element) => getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden")
      .map((element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; });
    const observeOcclusions = () => {
      const next = new Set(document.querySelectorAll<HTMLElement>(".model-editor-dock[data-inspector], .focus-workspace__panel"));
      for (const occlusion of observedOcclusions) if (!next.has(occlusion)) { observer.unobserve(occlusion); observedOcclusions.delete(occlusion); }
      for (const occlusion of next) {
        observedOcclusions.add(occlusion);
        observer.observe(occlusion);
      }
      refresh();
    };
    if (app) {
      mutations = new MutationObserver(observeOcclusions);
      mutations.observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-focus-panel"] });
      observeOcclusions();
    }
    window.addEventListener("resize", refresh);
    refresh();
    return () => { cancelAnimationFrame(frame); unsubscribeViewport(); unsubscribeScene?.(); unsubscribeFrame?.(); observer.disconnect(); mutations?.disconnect(); window.removeEventListener("resize", refresh); };
  }, [runtime, nodeId]);
  return <div ref={ref} className="node-execution-dock" data-node-id={nodeId} data-presentation="compact" style={runtime ? { visibility: "hidden" } : undefined}>{children}</div>;
}

/** 骨架本体：只提供面板轮廓，不含外壳。 */
export function ExecutionPanelSkeleton() {
  return <AuthoringGeneratePlaceholder />;
}

export type ExecutionPanelPendingProps = {
  nodeId: string;
  presentation: ExecutionPanelPresentation;
  runtime?: CanvasRuntimeService;
};

/**
 * 自带外壳的懒加载骨架。
 *
 * 用于 panel definition 自己不渲染外壳的场景（`node-execution`）；已经在外壳里的 definition
 * 应改用 {@link ExecutionPanelSkeleton}，避免出现嵌套 dock。
 */
export function ExecutionPanelPending({ nodeId, presentation, runtime }: ExecutionPanelPendingProps) {
  return (
    <ExecutionPanelSurface nodeId={nodeId} presentation={presentation} runtime={runtime}>
      <AuthoringGeneratePlaceholder />
    </ExecutionPanelSurface>
  );
}
