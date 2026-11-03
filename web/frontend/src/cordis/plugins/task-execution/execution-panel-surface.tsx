/**
 * 执行面板的呈现表面：所有节点共用同一套出现逻辑。
 *
 * **compact 面是贴画布底边居中的常驻条**，不再跟随节点移动（原先的节点锚定在 `layoutNodePanel`，
 * 仍在 `model-node-editor` 等场景使用）。默认只有一行「+ 输入框 参数 … 生成」，点一下展开成完整面板，
 * 展开后那一行的按钮变成「收起」。常驻指它不随节点缩放/平移移动，不是「没选节点时也显示」——
 * 何时出现仍由 selection 决定（`plugin.tsx` 的 selection coordinator）。
 *
 * 位置由 `layoutDockedPanel` 统一算：宽度、离底距离、最高占画布 55%。**不再读节点屏幕矩形**，
 * 所以要留意 `runtime` 为 `undefined` 时也要能摆位（fixture / 无运行时场景）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AuthoringGeneratePlaceholder } from "../../host.js";
import type { CanvasRuntimeService } from "../../contracts.js";
import { DOCK_MAX_WIDTH, layoutDockedPanel, usableCanvasArea } from "./node-anchor-layout.js";
import { FullscreenPanelHost } from "./execution-panel/fullscreen-panel-host.js";
import { PanelCollapseProvider, type PanelCollapse } from "./execution-panel/collapse-context.js";
import { panelKindForNodeType } from "./node-panel-registry.js";
import { consumeDockExpand, peekDockExpand, subscribeDockExpand } from "./dock-expand-request.js";
import type { ExecutionPanelPresentation } from "../../navigation/contracts.js";
// 骨架先于真实面板出现，窄条样式（含骨架的收起态）必须由表面自己带上。
import "./execution-panel/collapsed-bar.css";

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
   * 是否允许收成一条输入条（默认否）。
   *
   * 只有**生成面板**该折：3D 模型参数、镜头参数这类面板里没有提示词输入框，折叠后只会剩
   * 一条写着占位文案的空条。它们继续按完整面板显示。
   */
  collapsible?: boolean;
  children: ReactNode;
};

/** 唯一表面：compact 贴底常驻条 / expanded 全屏宿主（非 Dialog）。 */
export function ExecutionPanelSurface({ nodeId, presentation, runtime, collapsible = false, children }: ExecutionPanelSurfaceProps) {
  if (presentation === "expanded") {
    return <FullscreenPanelHost ariaLabel="节点执行面板（展开）">{children}</FullscreenPanelHost>;
  }
  return (
    <DockedBar key={nodeId} nodeId={nodeId} runtime={runtime} collapsible={collapsible}>{children}</DockedBar>
  );
}

/** 会伸进画布内容区的右侧/聚焦面板；底边栏算可用区域时要让开它们。 */
const OCCLUSION_SELECTOR = ".model-editor-dock[data-inspector], .focus-workspace__panel";

function visibleOcclusions() {
  return Array.from(document.querySelectorAll<HTMLElement>(OCCLUSION_SELECTOR))
    .filter((element) => getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden")
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
}

function DockedBar({ nodeId, runtime, collapsible, children }: { nodeId: string; runtime?: CanvasRuntimeService; collapsible: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // 生成面板默认收成一条输入条（参考稿的默认态）：选中节点先看到它，点一下才展开完整面板。
  // 外部刚请求过展开（悬停胶囊新建节点后）：挂载时就是展开的，免得先闪一条再展开。
  const [collapsed, setCollapsed] = useState(collapsible && !peekDockExpand(nodeId));
  // collapsible 可能在挂载之后才变成 true（面板类型后置确定）：此时同样按默认态收起，
  // 而不是停在初值 false 上。渲染期校正比 effect 少一帧闪烁。
  const [seenCollapsible, setSeenCollapsible] = useState(collapsible);
  if (seenCollapsible !== collapsible) {
    setSeenCollapsible(collapsible);
    if (collapsible) setCollapsed(true);
  }
  const expand = useCallback(() => {
    setCollapsed(false);
    // 展开后的下一拍把焦点交给提示词输入：用户点这条就是想打字，不该再点一次。
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        ref.current?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')?.focus();
      })
    );
  }, []);
  // 外部请求展开：已挂载时订阅收到；挂载前发的请求在这里取走（初始值已按它展开）。
  useEffect(() => {
    if (!collapsible) return;
    if (consumeDockExpand(nodeId)) expand();
    return subscribeDockExpand((requested) => {
      if (requested !== nodeId) return;
      consumeDockExpand(nodeId);
      expand();
    });
  }, [collapsible, nodeId, expand]);
  const collapse = useMemo<PanelCollapse>(
    () => ({
      collapsible,
      collapsed: collapsible && collapsed,
      expand,
      collapse: () => setCollapsed(true),
    }),
    [collapsible, collapsed, expand]
  );
  const applyLayout = useCallback(() => {
    const dock = ref.current;
    if (!dock) return;
    // fixture（storybook / 聚焦演示）把 dock 放进一个定位容器里，此时用相对坐标；
    // 正常画布用 fixed 贴视口底边。
    const fixtureArea = dock.closest<HTMLElement>("[data-node-anchor-area]");
    const areaElement = fixtureArea ?? document.getElementById("bevy-canvas");
    if (!areaElement) {
      dock.style.visibility = "hidden";
      return;
    }
    const bounds = areaElement.getBoundingClientRect();
    const area = usableCanvasArea(
      { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      fixtureArea ? [] : visibleOcclusions()
    );
    // 宽度用**目标值**而不是 `dock.offsetWidth`：宽度是我们自己写上去的，读回实测值会
    // 形成「这帧量到多宽，下帧就多宽」的自反馈——首帧内容窄，条就永远长不回来。
    // 高度必须实测：折叠/展开、参数行换行都会改它。
    // 量之前先放开上一帧写进去的 `maxHeight`，否则它会把「收起时的一行高」当成上限，
    // 展开后内容长高却被卡住、被截成半截（实际踩过）。
    dock.style.maxHeight = "none";
    const next = layoutDockedPanel(area, { width: DOCK_MAX_WIDTH, height: dock.offsetHeight });
    if (!next) {
      dock.style.visibility = "hidden";
      return;
    }
    const layout = fixtureArea ? { ...next, left: next.left - bounds.left, top: next.top - bounds.top } : next;
    dock.style.position = fixtureArea ? "absolute" : "fixed";
    dock.style.left = `${layout.left}px`;
    dock.style.top = `${layout.top}px`;
    dock.style.width = `${layout.width}px`;
    dock.style.maxHeight = `${layout.maxHeight}px`;
    dock.style.visibility = "visible";
  }, []);

  useEffect(() => {
    const dock = ref.current;
    if (!dock) return;
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(applyLayout);
    };
    const unsubscribeViewport = runtime?.subscribeViewport(refresh);
    const unsubscribeScene = runtime?.subscribeScene?.(refresh);
    // 面板高度随折叠/展开与内容变化，ResizeObserver 是唯一可靠的通知源（无 runtime 也生效）。
    const observer = new ResizeObserver(refresh);
    observer.observe(dock);
    const canvas = dock.closest("[data-node-anchor-area]") ?? document.getElementById("bevy-canvas");
    if (canvas) observer.observe(canvas);
    const app = document.querySelector<HTMLElement>(".app");
    let mutations: MutationObserver | undefined;
    const observedOcclusions = new Set<HTMLElement>();
    const observeOcclusions = () => {
      const next = new Set(document.querySelectorAll<HTMLElement>(OCCLUSION_SELECTOR));
      for (const occlusion of observedOcclusions) if (!next.has(occlusion)) { observer.unobserve(occlusion); observedOcclusions.delete(occlusion); }
      for (const occlusion of next) { observedOcclusions.add(occlusion); observer.observe(occlusion); }
      refresh();
    };
    if (app) {
      mutations = new MutationObserver(observeOcclusions);
      mutations.observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-focus-panel"] });
      observeOcclusions();
    }
    window.addEventListener("resize", refresh);
    refresh();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribeViewport?.();
      unsubscribeScene?.();
      observer.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", refresh);
    };
  }, [runtime, applyLayout]);

  // 折叠/展开改变高度，但 ResizeObserver 在部分浏览器里合并得比一帧晚，这里再补一次。
  useEffect(() => {
    const frame = requestAnimationFrame(applyLayout);
    return () => cancelAnimationFrame(frame);
  }, [collapsed, applyLayout]);

  return (
    <PanelCollapseProvider value={collapse}>
      <div
        ref={ref}
        className="node-execution-dock node-execution-bar-dock"
        data-node-id={nodeId}
        data-presentation="compact"
        data-collapsed={collapse.collapsed ? "true" : undefined}
        // `index.css` 给 dock 的默认位置是左上角；先藏起来，等第一帧量完再显示，
        // 否则会先闪在画布左上角再跳到下半屏（早期节点锚定面板踩过同一个坑）。
        style={{ visibility: "hidden" }}
      >
        {children}
      </div>
    </PanelCollapseProvider>
  );
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
  // 骨架的外壳必须与真实面板一致（同样 collapsible），否则会先闪一块完整骨架再缩成一条。
  return (
    <ExecutionPanelSurface nodeId={nodeId} presentation={presentation} runtime={runtime} collapsible>
      <AuthoringGeneratePlaceholder />
    </ExecutionPanelSurface>
  );
}
