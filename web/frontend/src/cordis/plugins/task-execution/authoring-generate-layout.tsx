import type { ReactNode } from "react";
import { AssistantToolbar } from "@woohaa3/ui/assistant";
import type { PanelPresentationIntent } from "../../contract/model-interaction.js";
import { IconButton } from "@woohaa3/ui/primitives";
import {
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
} from "@woohaa3/ui/icons";
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
  onRefresh?: () => void;
  onManage?: () => void;
  disabled?: boolean;
  refreshing?: boolean;
  presentation?: "dock" | "expanded";
  requestPresentation?: (intent: PanelPresentationIntent) => void;
};

/** 普通创作与外部任务共用完整面板布局，状态与输入由任务所有者提供。 */
export function AuthoringGenerateSurface({
  children,
  mode,
  sourceId,
  ...layout
}: AuthoringLayoutProps & {
  children?: ReactNode;
  mode: string;
  sourceId?: string;
}) {
  return (
    <div
      className="mc-panel authoring-generate"
      data-testid="authoring-generate"
      data-presentation={layout.inspector ? "inspector" : "dock"}
      data-mode={mode}
      data-source-id={sourceId}
    >
      <AuthoringGenerateLayout {...layout} />
      {children}
    </div>
  );
}

/** Dock and inspector use the same five-control assistant toolbar. */
export function AuthoringGenerateLayout({
  inspector,
  references,
  mcp,
  prompt,
  assistant,
  model,
  detail,
  submit,
  onRefresh,
  onManage,
  disabled,
  refreshing,
  presentation,
  requestPresentation,
}: AuthoringLayoutProps) {
  const toolbar = (
    <AssistantToolbar
      assistant={assistant}
      parameters={model}
      submit={submit}
      beforeSubmit={
        detail ? (
          <div className="authoring-generate__actions">{detail}</div>
        ) : undefined
      }
      onRefresh={onRefresh}
      onManage={onManage}
      disabled={disabled}
      refreshing={refreshing}
    />
  );
  const presentationActions = requestPresentation ? (
    <div className="authoring-generate__presentation-actions">
      <IconButton
        label={presentation === "expanded" ? "退出大编辑" : "展开编辑"}
        title={presentation === "expanded" ? "退出大编辑" : "展开编辑"}
        size="sm"
        onClick={() =>
          requestPresentation({
            kind: presentation === "expanded" ? "collapse" : "expand",
          })
        }
      >
        {presentation === "expanded" ? (
          <CollapseIcon size={16} />
        ) : (
          <ExpandIcon size={16} />
        )}
      </IconButton>
      {presentation === "expanded" ? (
        <IconButton
          label="关闭执行面板"
          title="关闭"
          size="sm"
          onClick={() => requestPresentation({ kind: "close" })}
        >
          <CloseIcon size={16} />
        </IconButton>
      ) : null}
    </div>
  ) : null;
  const headerTools = (
    <div className="authoring-generate__header-tools">
      {mcp}
      {presentationActions}
    </div>
  );
  if (inspector)
    return (
      <>
        <div className="authoring-generate__inspector-heading">
          <h3>AI 修改</h3>
          {headerTools}
        </div>
        {references ? (
          <div className="authoring-generate__references">{references}</div>
        ) : null}
        {prompt}
        {toolbar}
      </>
    );

  return (
    <>
      <div className="authoring-generate__header">
        {references ? (
          <div className="authoring-generate__references">{references}</div>
        ) : null}
        {headerTools}
      </div>
      {prompt}
      {toolbar}
    </>
  );
}
