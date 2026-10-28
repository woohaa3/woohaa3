/**
 * UiProvider：生产 UI primitive 的 context 与 portal ownership
 * （change: adopt-radix-lucide-canvas-ui，任务 2.1 / design D2）。
 *
 * 职责：
 * - 提供**唯一**的 Radix `Tooltip.Provider`（统一 delay/skip-delay）；
 * - 在 `.app-theme-root` 内提供稳定 portal container（Tooltip/Popover/Menu/Dialog 共用），
 *   使 portal subtree 继承当前 `--app-*` 主题而不是落到 `document.body`；
 * - 暴露 portal container context 与 z 层级，允许各类浮层显式取用。
 *
 * 容器用 callback ref + state 持有：挂载后触发一次重渲染，让首帧即取到容器的浮层
 * 也能拿到稳定 root；卸载时 portal subtree 随 React root 同步释放，不在 `document.body`
 * 留下节点。
 */
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

export type PortalLayer = "tooltip" | "menu" | "dialog";

type UiContextValue = {
  /** 当前主题根内的 portal 容器；在容器挂载后可用（否则为 `null`）。 */
  portalContainer: HTMLElement | null;
};

const UiContext = createContext<UiContextValue | null>(null);

export type UiProviderProps = {
  children: ReactNode;
  /** Tooltip 首次显示延迟（ms）。 */
  tooltipDelayDuration?: number;
  /** 同一 Provider 内跳过下一段 delay 的窗口（ms）。 */
  tooltipSkipDelayDuration?: number;
};

/**
 * 生产 UI Provider。MUST 位于 `ThemeProvider` 的 `.app-theme-root` 子树内
 * （App Host 与 Showcase preview root 均按此顺序挂载）。
 */
export function UiProvider({
  children,
  tooltipDelayDuration = 350,
  tooltipSkipDelayDuration = 300,
}: UiProviderProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const value = useMemo<UiContextValue>(
    () => ({ portalContainer: container }),
    [container],
  );

  return (
    <UiContext.Provider value={value}>
      <TooltipPrimitive.Provider
        delayDuration={tooltipDelayDuration}
        skipDelayDuration={tooltipSkipDelayDuration}
      >
        {children}
        {/*
         * 稳定 portal root：位于当前 theme root 内，不在 document.body。
         * 固定 z-index 分层：tooltip < menu/popover < dialog（见 primitives.css）。
         */}
        <div
          ref={setContainer}
          className="ui-portal-root"
          data-ui-portal-root=""
        />
      </TooltipPrimitive.Provider>
    </UiContext.Provider>
  );
}

/** 读取 UiProvider context（可选：未挂载时返回 null，primitive 回退到 document.body）。 */
export function useOptionalUiContext(): UiContextValue | null {
  return useContext(UiContext);
}

/** 读取 portal container（不强制要求 Provider；缺失时返回 `null`）。 */
export function usePortalContainer(): HTMLElement | null {
  return useContext(UiContext)?.portalContainer ?? null;
}

/** 派生某层级的 portal container（当前实现共享同一 root，保留扩展点）。 */
export function usePortalContainerFor(_layer: PortalLayer): HTMLElement | null {
  return usePortalContainer();
}

/** 在弹窗所属层内承载下拉等浮层，避免落到应用级容器后被弹窗遮住。 */
export function UiPortalScope({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ portalContainer: container }), [container]);
  return (
    <UiContext.Provider value={value}>
      {children}
      <div
        ref={setContainer}
        className="ui-portal-root"
        data-ui-portal-scope=""
      />
    </UiContext.Provider>
  );
}
