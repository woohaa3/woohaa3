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
import { layoutNodePanel, usableCanvasArea, PANEL_COMPOSER_RESERVE_HEIGHT, type AnchoredPanel } from "./node-anchor-layout.js";
import { belowPanelRevealOffset } from "./dock-reveal.js";
import { FullscreenPanelHost } from "./execution-panel/fullscreen-panel-host.js";
import { panelKindForNodeType } from "./node-panel-registry.js";
import type { ExecutionPanelPresentation } from "../../navigation/contracts.js";

/** 为面板避让平移画布时的补间时长；避免选中锚点瞬间视口硬跳。 */
const PANEL_REVEAL_TWEEN_MS = 240;

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
  /**
   * 锚点下方放不下完整编辑器时，是否平移画布腾出空间。
   * 导演区与共享世界模型这类超大/无卡片锚点关闭：画布保持不动，面板最多贴可用区域底边停靠。
   */
  revealAnchor?: boolean;
  children: ReactNode;
};

/** 唯一表面：compact 节点锚定宿主 / expanded 全屏宿主（非 Dialog）。 */
export function ExecutionPanelSurface({ nodeId, presentation, runtime, revealAnchor = true, children }: ExecutionPanelSurfaceProps) {
  if (presentation === "expanded") {
    return <FullscreenPanelHost ariaLabel="节点执行面板（展开）">{children}</FullscreenPanelHost>;
  }
  return (
    <AnchoredDock nodeId={nodeId} runtime={runtime} revealAnchor={revealAnchor}>{children}</AnchoredDock>
  );
}

function AnchoredDock({ nodeId, runtime, revealAnchor, children }: { nodeId: string; runtime?: CanvasRuntimeService; revealAnchor: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastPlacement = useRef<AnchoredPanel["placement"] | undefined>(undefined);
  useEffect(() => {
    if (!runtime || !ref.current) return;
    const occlusionSelector = ".model-editor-dock[data-inspector], .focus-workspace__panel, .canvas-control-panel";
    let frame = 0;
    let userControlled = false;
    let revealTargetY: number | null = null;
    const takeControl = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      if (event instanceof WheelEvent || event instanceof PointerEvent && event.button !== 0
        || event instanceof KeyboardEvent && event.code === "Space") { userControlled = true; }
    };
    const applyLayout = () => {
      const dock = ref.current;
      const canvas = document.getElementById("bevy-canvas");
      const fixtureArea = dock?.closest<HTMLElement>("[data-node-anchor-area]") ?? null;
      const areaElement = fixtureArea ?? canvas;
      // `panel` 锚点让世界镜头在 3D 机位可见时贴机位底点，否则退回卡片（见 interaction-controller）。
      const node = runtime.nodeScreenRect(nodeId, "panel");
      if (!dock || !areaElement || !node) {
        if (dock) {
          dock.style.visibility = "hidden";
          dock.removeAttribute("data-placement");
        }
        return;
      }
      const bounds = areaElement.getBoundingClientRect();
      const area = usableCanvasArea({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }, fixtureArea ? [] : visibleOcclusions());
      const nodeRect = { ...node, right: node.left + node.width, bottom: node.top + node.height };
      const areaRect = { ...area, right: area.left + area.width, bottom: area.top + area.height };
      const revealOffset = belowPanelRevealOffset(nodeRect, areaRect, PANEL_COMPOSER_RESERVE_HEIGHT);
      // Locate may bring an initially offscreen anchor into view over several frames.
      // Keep reserving room during programmatic movement; a navigation gesture yields
      // control for the rest of this panel's lifetime.
      if (revealAnchor && !userControlled && !fixtureArea) {
        const controller = runtime.controller();
        if (revealOffset > 1 && controller) {
          const viewport = controller.viewport();
          const targetY = viewport.y - revealOffset;
          // 目标只由锚点与可用区域决定；逐帧重复发起会不断重置补间，这里去重。
          if (revealTargetY === null || Math.abs(targetY - revealTargetY) > 1) {
            revealTargetY = targetY;
            controller.panViewportTo({ ...viewport, y: targetY }, { durationMs: PANEL_REVEAL_TWEEN_MS });
          }
        } else {
          revealTargetY = null;
        }
      } else {
        revealTargetY = null;
      }
      // 节点面板统一优先落在锚点下方：3D 模型/镜头不再翻到模型上方遮挡对象，2D 节点也不随
      // 视口在「上/下/贴边」之间跳。下方确实放不下时退到贴底停靠（允许覆盖锚点局部），
      // 不再为了「放得下」改贴左右两侧或平移画布。
      // 高度取自然高度（`scrollHeight` 不受当前 `max-height` 收缩影响），否则贴底/squeeze
      // 后的 offsetHeight 会让下一帧误判「放得下」而在两种落点之间来回跳。
      const panelSize = { width: dock.offsetWidth, height: Math.max(dock.offsetHeight, dock.scrollHeight) };
      // 关闭避让只表示「不为了腾空间平移画布」：面板本身仍放得下时照常贴在锚点下方，
      // 放不下（或锚点下缘已越过底边）才吸附到可用区域底边。
      const belowPanel = layoutNodePanel(node, area, panelSize, lastPlacement.current, "below");
      const fitsBelow = belowPanel !== null && belowPanel.maxHeight >= panelSize.height;
      const next = layoutNodePanel(node, area, panelSize, lastPlacement.current, !revealAnchor && !fitsBelow ? "dock" : "below");
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
    const visibleOcclusions = () => Array.from(document.querySelectorAll<HTMLElement>(occlusionSelector))
      .filter((element) => getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden")
      .map((element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; });
    const observeOcclusions = () => {
      const next = new Set(document.querySelectorAll<HTMLElement>(occlusionSelector));
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
    // Navigation gestures belong to this application surface, including keyboard
    // events on its canvas. Portals outside it must not cancel the reveal.
    const navigationSurface = app ?? canvas;
    navigationSurface?.addEventListener("wheel", takeControl, true);
    navigationSurface?.addEventListener("pointerdown", takeControl, true);
    navigationSurface?.addEventListener("keydown", takeControl, true);
    refresh();
    return () => { cancelAnimationFrame(frame); unsubscribeViewport(); unsubscribeScene?.(); unsubscribeFrame?.(); observer.disconnect(); mutations?.disconnect(); window.removeEventListener("resize", refresh); navigationSurface?.removeEventListener("wheel", takeControl, true); navigationSurface?.removeEventListener("pointerdown", takeControl, true); navigationSurface?.removeEventListener("keydown", takeControl, true); };
  }, [runtime, nodeId, revealAnchor]);
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
  revealAnchor?: boolean;
};

/**
 * 自带外壳的懒加载骨架。
 *
 * 用于 panel definition 自己不渲染外壳的场景（`node-execution`）；已经在外壳里的 definition
 * 应改用 {@link ExecutionPanelSkeleton}，避免出现嵌套 dock。
 */
export function ExecutionPanelPending({ nodeId, presentation, runtime, revealAnchor }: ExecutionPanelPendingProps) {
  return (
    <ExecutionPanelSurface nodeId={nodeId} presentation={presentation} runtime={runtime} revealAnchor={revealAnchor}>
      <AuthoringGeneratePlaceholder />
    </ExecutionPanelSurface>
  );
}
