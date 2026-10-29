/**
 * React 渲染错误边界（页面级与 Panel 级）
 * （change: fix-delete-node-crash-and-white-screen）。
 *
 * 背景：Host 或 Panel 的 render 异常此前无人捕获，React 会卸载整棵 React 树 —— 页面只剩
 * 白屏，用户既看不到原因也没有恢复入口。这里提供两级兜底：
 *
 * - **页面级**（`AppErrorBoundary`）：显示可诊断错误卡片与「刷新页面」主操作；
 * - **Panel 级**（`RenderErrorBoundary` + `PanelRenderErrorFallback`）：只替换出错的
 *   Canvas panel；Canvas、其它 panel 与 canonical 节点保持可用。
 *
 * 边界不静默吞错：`componentDidCatch` 仍把原始错误打到 console。
 */
import { Component, type ReactNode } from "react";
import { Button } from "@woohaa3/ui";

/**
 * 刷新当前应用。
 *
 * `location` 可能缺席（测试 / 非浏览器宿主），因此用可选链而不是直接调用。
 */
export function reloadApplication(): void {
  globalThis.location?.reload();
}

export type RenderErrorFallbackInput = {
  /** 已归一化为文本的异常。 */
  error: string;
  /** 清空错误并重新渲染同一子树（不刷新页面）。 */
  retry: () => void;
};

export type RenderErrorBoundaryProps = {
  children: ReactNode;
  /** 错误态的受控呈现；由调用方决定页面级或 Panel 级。 */
  fallback: (input: RenderErrorFallbackInput) => ReactNode;
  /**
   * 变化时自动清除错误并重试渲染。
   *
   * Panel 边界传入 route identity：用户切换选中节点后，新 panel 不应继承上一个 panel 的
   * 失败态（否则一次错误会永久屏蔽该位置上后续所有 panel）。
   */
  resetKey?: unknown;
  /** 捕获到错误时回调（诊断/熔断上报）；不改变 fallback 行为。 */
  onError?: (message: string) => void;
};

type RenderErrorBoundaryState = { error: string | null };

/**
 * 通用渲染错误边界。
 *
 * 没有它时，任意子树的 render 异常都会卸载整个 React root；有了它，失败被限制在本子树内。
 */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  override state: RenderErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RenderErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    // 保留原始错误与组件栈，便于开发期排障。
    console.error("[render-error-boundary]", error);
    try {
      this.props.onError?.(error instanceof Error ? error.message : String(error));
    } catch {
      // 上报失败不能让错误边界本身抛错。
    }
  }

  override componentDidUpdate(previous: RenderErrorBoundaryProps): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private readonly retry = (): void => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.fallback({ error: this.state.error, retry: this.retry });
    }
    return this.props.children;
  }
}

/** 页面级兜底：整页错误卡片，主操作是刷新（并说明未提交输入会丢失）。 */
export function ApplicationErrorFallback({ error }: { error: string }): ReactNode {
  return (
    <div className="app app--failed" role="alert" data-testid="app-render-error">
      <div className="status-overlay">
        <div className="status-title">页面渲染失败</div>
        <p className="status-detail">界面遇到未预期的错误，无法继续显示。刷新页面通常可以恢复；未提交的输入会丢失。</p>
        <pre className="status-detail">{error}</pre>
        <Button tone="primary" onClick={reloadApplication}>
          刷新页面
        </Button>
      </div>
    </div>
  );
}

/** 页面级边界：单页内容整体失败时的兜底（App scope 仍在，Dialog/诊断不受影响）。 */
export function AppErrorBoundary({ children, resetKey }: { children: ReactNode; resetKey?: unknown }): ReactNode {
  return (
    <RenderErrorBoundary
      fallback={({ error }) => <ApplicationErrorFallback error={error} />}
      {...(resetKey !== undefined ? { resetKey } : {})}
    >
      {children}
    </RenderErrorBoundary>
  );
}

/**
 * Panel 级兜底：只在面板位置显示诊断与刷新入口。
 *
 * 不渲染全屏遮罩，因此 Canvas 与其它 panel 仍可见、可交互；失败节点也不会被改写。
 */
export function PanelRenderErrorFallback({ error }: { error: string }): ReactNode {
  return (
    <div className="render-error-fallback" role="alert" data-diagnostic="render-error">
      <p className="render-error-fallback__message">面板渲染失败：{error}</p>
      <Button size="sm" onClick={reloadApplication}>
        刷新页面
      </Button>
    </div>
  );
}
