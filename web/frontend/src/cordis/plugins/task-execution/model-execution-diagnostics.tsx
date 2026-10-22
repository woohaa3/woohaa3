/**
 * Model Interaction Panel 的诊断与错误边界
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.3 / design D8）。
 *
 * 缺 Plugin、version mismatch、render error 都必须：展示包含模型与 interaction identity 的
 * 可访问诊断、**禁止提交**，且**不**回退 generic。
 */
import type { ReactNode } from "react";
import { Component } from "react";
import type { CanvasTaskCatalogModel } from "@woohaa3/contracts";
import { Button } from "../../../shared/ui/index.js";
import { reloadApplication } from "../../app-error-boundary.js";

export type ModelInteractionDiagnostic =
  | { kind: "missing-plugin"; model: CanvasTaskCatalogModel }
  | { kind: "interaction-mismatch"; model: CanvasTaskCatalogModel; current: { id: string; version: number } }
  | { kind: "catalog-offline"; model: CanvasTaskCatalogModel }
  | { kind: "legacy-ambiguous"; message: string }
  | { kind: "render-error"; model: CanvasTaskCatalogModel; message: string };

export function interactionDiagnosticMessage(diagnostic: ModelInteractionDiagnostic): string {
  switch (diagnostic.kind) {
    case "missing-plugin":
      return `模型「${diagnostic.model.title}」需要的交互插件（${diagnostic.model.interaction.id}@${diagnostic.model.interaction.version}）未安装，无法执行`;
    case "interaction-mismatch":
      return `模型「${diagnostic.model.title}」的交互配置已变化（catalog ${diagnostic.model.interaction.id}@${diagnostic.model.interaction.version}，当前 ${diagnostic.current.id}@${diagnostic.current.version}），请刷新后重新选择`;
    case "catalog-offline":
      return `模型「${diagnostic.model.title}」已从任务目录下线，无法执行`;
    case "legacy-ambiguous":
      return diagnostic.message;
    case "render-error":
      return `模型「${diagnostic.model.title}」的交互面板渲染失败：${diagnostic.message}`;
  }
}

/**
 * 模型交互诊断：可见、可被辅助技术读取，且绝不触发提交。
 *
 * `render-error` 额外提供「刷新页面」入口：Plugin Panel 渲染失败通常来自已发布的插件代码，
 * 重渲染同一组件不会恢复，刷新是确定的恢复路径（change: fix-delete-node-crash-and-white-screen）。
 */
export function ModelInteractionDiagnosticView(props: { diagnostic: ModelInteractionDiagnostic }) {
  return (
    <div className="node-execution-dock__diagnostic" role="alert" data-diagnostic={props.diagnostic.kind}>
      <p>{interactionDiagnosticMessage(props.diagnostic)}</p>
      {props.diagnostic.kind === "render-error" ? (
        <div className="node-execution-dock__diagnostic-actions">
          <Button size="sm" onClick={reloadApplication}>
            刷新页面
          </Button>
        </div>
      ) : null}
    </div>
  );
}

type ErrorBoundaryProps = {
  modelTitle: string;
  children: ReactNode;
  onError?: (message: string) => void;
  /**
   * 变化时自动清除失败态并重试渲染（例如用户切换了模型）。
   *
   * 没有它时一次渲染错误会永久屏蔽该面板位置上的后续模型。
   */
  resetKey?: unknown;
};

type ErrorBoundaryState = { error: string | null };

/** 捕获 Plugin Panel render/effect 错误；失败只影响本 Panel，不破坏页面或其它 Plugin。 */
export class ModelPanelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown): void {
    // 保留原始错误与组件栈便于排障，不静默吞错。
    console.error("[model-panel-error-boundary]", error);
    this.props.onError?.(error instanceof Error ? error.message : String(error));
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="node-execution-dock__diagnostic" role="alert" data-diagnostic="render-error">
          <p>{`模型「${this.props.modelTitle}」的交互面板渲染失败：${this.state.error}`}</p>
          <div className="node-execution-dock__diagnostic-actions">
            <Button size="sm" onClick={reloadApplication}>
              刷新页面
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
