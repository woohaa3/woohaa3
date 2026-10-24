/**
 * 公共聚焦工作区容器
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D4/D6）。
 *
 * 由通用 focus 宿主挂载的唯一布局容器：
 * - 以公共几何 + 当前工作区经 `useFocusLayout` 提供的显式配置计算 contentRect；
 * - 作为**唯一 contentRect writer** 调用 `runtime.setFocusContentRect`；
 * - 把 contentRect/insets 投影为 CSS 变量与 data 属性，供 DOM 控件与渲染取景共同消费；
 * - 退出/scope dispose 清空矩形，切换 owner 时旧订阅不覆盖新工作区。
 *
 * MUST NOT 根据 image/video/model 类型决定专用控件、文案或占位；各 editor 以显式配置与
 * 各自工作区 renderer 表达差异。本模块只依赖公共纯类型与 runtime 服务契约，不 import 具体
 * editor、Canvas Shell 的 FocusWorkspace 实现或业务 extension。
 */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from "react";
import type { CanvasPresentationSnapshot } from "../navigation/contracts.js";
import type { CanvasRuntimeService } from "../contract/canvas-runtime.js";
import { focusLayout, type FocusLayoutConfig, type FocusLayoutSource } from "./layout.js";
import type { FocusContentRect } from "./types.js";

/** 公共聚焦上下文：只暴露内容区域等共同信息，不拥有各 editor 的 toolsOpen。 */
export type FocusWorkspaceContextValue = {
  contentRect: FocusContentRect;
  narrow: boolean;
  /** 当前呈现的侧栏面板：工具、历史、详情或关闭。 */
  panel: "tools" | "history" | "detail" | "closed";
};

const FocusWorkspaceContext = createContext<FocusWorkspaceContextValue | null>(null);
export const useFocusWorkspace = (): FocusWorkspaceContextValue | null => useContext(FocusWorkspaceContext);

const FocusLayoutContext = createContext<((config: FocusLayoutConfig) => void) | null>(null);

/**
 * 工作区向公共容器提供布局配置（design D2/D3）：只描述尺寸与开关，不携带 DOM 查询。
 *
 * 每次渲染以最新配置登记；容器按**值**比较，避免无谓重算。各 editor 的 toolsOpen 等局部
 * 状态留在自己的 Plugin scope，由本 hook 以布局快照形式上报。
 */
export function useFocusLayout(config: FocusLayoutConfig): void {
  const setConfig = useContext(FocusLayoutContext);
  const snapshot = useMemo(() => config, [
    config.desktop,
    config.panel,
    config.animationPreview,
    config.toolColumn,
    config.toolbar,
    typeof config.player === "function" ? 0 : config.player,
    config.panelMaxWidth,
    config.panelMaxHeight
  ]);
  useLayoutEffect(() => {
    setConfig?.(snapshot);
  }, [setConfig, snapshot]);
}

/**
 * 由 slot 贡献声明的**可选**布局来源（静态配置或可订阅快照，design D3）。
 *
 * 公共宿主在解析出唯一工作区后调用本 hook；缺省（undefined）时不影响 hook 路径。
 * `subscribe` 来源让插件把工具开关等局部状态以布局快照暴露，公共层不拥有 toolsOpen。
 */
export function useFocusLayoutSource(source: FocusLayoutSource | undefined): void {
  const setConfig = useContext(FocusLayoutContext);
  const hasSource = source !== undefined;
  const [snapshot, setSnapshot] = useState<FocusLayoutConfig>(() => resolveSource(source));
  useEffect(() => {
    if (!hasSource) return undefined;
    if (!source || typeof source !== "object" || typeof (source as { get?: unknown }).get !== "function") {
      setSnapshot(resolveSource(source));
      return undefined;
    }
    const subscribable = source as Extract<FocusLayoutSource, { get(): FocusLayoutConfig }>;
    setSnapshot(subscribable.get());
    return subscribable.subscribe(() => setSnapshot({ ...subscribable.get() }));
  }, [source, hasSource]);
  useLayoutEffect(() => {
    if (!hasSource) return;
    setConfig?.(snapshot);
  }, [setConfig, snapshot, hasSource]);
}

function resolveSource(source: FocusLayoutSource | undefined): FocusLayoutConfig {
  if (!source) return {};
  if (typeof source === "object" && typeof (source as { get?: unknown }).get === "function") {
    return (source as Extract<FocusLayoutSource, { get(): FocusLayoutConfig }>).get();
  }
  return source as FocusLayoutConfig;
}

export type FocusWorkspaceProps = {
  presentation: CanvasPresentationSnapshot;
  runtime: CanvasRuntimeService;
  surfaceRef: RefObject<HTMLDivElement>;
  /**
   * 聚焦时是否有非工作区 panel 占用侧栏（如 Agent 详情）。
   *
   * 由宿主按 panel definition 的 `focusPresentation === "sidebar"` 派生。为真时侧栏由该 panel
   * 呈现并与检查器互斥（design D6a：共用同一栏，不额外并列）。
   */
  sidePanel?: boolean;
  children: ReactNode;
};

/**
 * 唯一聚焦布局容器。始终渲染 `.app`；仅在 node-focus 时投影聚焦 data 属性与 contentRect。
 */
export function FocusWorkspace({ presentation, runtime, surfaceRef, sidePanel = false, children }: FocusWorkspaceProps) {
  const mode = presentation.mode;
  // 独立文档工作区（change: 2026-10-21-add-photocraft-document-workspace）与节点聚焦共用同一
  // 内容矩形与 tool/panel 布局；它没有节点历史 drawer，也没有公共连接栏。
  const focused = mode.type === "node-focus" || mode.type === "document-workspace";
  const history = mode.type === "node-focus" && presentation.panel?.type === "node-history";
  // 聚焦侧栏：工作区检查器（history）与外部 panel（detail）互斥，且都占用唯一面板占位。
  const detail = focused && sidePanel;
  const [config, setConfig] = useState<FocusLayoutConfig>({});
  const [size, setSize] = useState({ width: 800, height: 600 });
  const panel = history || detail || (focused && config.panel === true);
  // 尺寸取自画布输入表面：窗口横栏（Tauri）在页面布局里已占位，表面本身就从横栏下方开始，
  // 因此聚焦布局不需要再单独减去横栏高度。
  const layout = focusLayout({ ...config, panel, width: size.width, height: size.height });

  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!element) return undefined;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      setSize((previous) => previous.width === bounds.width && previous.height === bounds.height ? previous : { width: bounds.width, height: bounds.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [surfaceRef]);

  useLayoutEffect(() => {
    runtime.setFocusContentRect(focused ? layout.contentRect : null);
  }, [runtime, focused, layout.contentRect.x, layout.contentRect.y, layout.contentRect.width, layout.contentRect.height]);
  useLayoutEffect(() => () => runtime.setFocusContentRect(null), [runtime]);

  const style = {
    "--focus-player-bottom": `${44 + layout.panelHeight}px`,
    "--focus-rail": `${layout.rail}px`, "--focus-header": `${layout.header}px`,
    "--focus-toolbar": `${layout.toolbar}px`,
    "--focus-footer": `${layout.footer}px`, "--focus-player-height": `${layout.player}px`, "--focus-panel-width": `${layout.panelWidth}px`,
    "--focus-panel-height": `${layout.panelHeight}px`, "--focus-tools": `${layout.tools}px`,
    "--focus-content-x": `${layout.contentRect.x}px`, "--focus-content-y": `${layout.contentRect.y}px`,
    "--focus-content-width": `${layout.contentRect.width}px`, "--focus-content-height": `${layout.contentRect.height}px`
  } as CSSProperties;
  const panelState: FocusWorkspaceContextValue["panel"] = history ? "history" : detail ? "detail" : config.panel ? "tools" : "closed";
  const contextValue = useMemo<FocusWorkspaceContextValue | null>(
    () => (focused ? { contentRect: layout.contentRect, narrow: layout.narrow, panel: panelState } : null),
    [focused, layout.contentRect.x, layout.contentRect.y, layout.contentRect.width, layout.contentRect.height, layout.narrow, panelState]
  );
  return (
    <FocusLayoutContext.Provider value={setConfig}>
      <FocusWorkspaceContext.Provider value={contextValue}>
        <div className="app" style={style}
          data-focus-kind={mode.type === "node-focus" ? mode.kind : mode.type === "document-workspace" ? "document" : undefined}
          data-focus-owner={mode.type === "node-focus" ? mode.owner : mode.type === "document-workspace" ? "document" : undefined}
          data-focus-narrow={focused && layout.narrow ? "true" : undefined}
          data-focus-chrome={focused && config.chrome===false ? "hidden" : undefined}
          data-focus-panel={focused ? panelState : undefined}>
          {children}
        </div>
      </FocusWorkspaceContext.Provider>
    </FocusLayoutContext.Provider>
  );
}
