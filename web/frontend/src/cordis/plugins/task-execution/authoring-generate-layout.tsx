import type { ReactNode } from "react";
import "./execution-panel/execution-panel.css";
import "./authoring-generate-panel.css";

type AuthoringLayoutProps = {
  inspector: boolean;
  references?: ReactNode;
  mcp: ReactNode;
  prompt: ReactNode;
  assistant: ReactNode;
  model?: ReactNode;
  detail?: ReactNode;
  submit: ReactNode;
};

/** 普通创作与外部任务共用完整面板布局，状态与输入由任务所有者提供。 */
export function AuthoringGenerateSurface({ children, mode, sourceId, ...layout }: AuthoringLayoutProps & {
  children?: ReactNode; mode: string; sourceId?: string;
}) {
  return <div className="mc-panel authoring-generate" data-testid="authoring-generate"
    data-presentation={layout.inspector ? "inspector" : "dock"} data-mode={mode} data-source-id={sourceId}>
    <AuthoringGenerateLayout {...layout} />
    {children}
  </div>;
}

/** 只组织呈现：聚焦检查器不沿用外侧 dock 的横向工具栏。 */
export function AuthoringGenerateLayout({
  inspector, references, mcp, prompt, assistant, model, detail, submit,
}: AuthoringLayoutProps) {
  if (inspector) return <>
    <div className="authoring-generate__inspector-heading">
      <h3>AI 修改</h3>
      {mcp}
    </div>
    {references ? <div className="authoring-generate__references">{references}</div> : null}
    {prompt}
    <div className="authoring-generate__inspector-settings">
      <div className="authoring-generate__inspector-field"><span>助手</span>{assistant}</div>
      {model ? <div className="authoring-generate__inspector-field"><span>模型</span>{model}</div> : null}
    </div>
    <div className="authoring-generate__inspector-actions">{submit}{detail}</div>
  </>;

  return <>
    <div className="authoring-generate__header">
      {references ? <div className="authoring-generate__references">{references}</div> : null}
      {mcp}
    </div>
    {prompt}
    <div className="mc-panel__sectioned-footer authoring-generate__toolbar">
      <div className="mc-panel__parameters mc-panel__grid-parameter">{assistant}{model}</div>
      <div className="authoring-generate__actions">{detail}{submit}</div>
    </div>
  </>;
}
