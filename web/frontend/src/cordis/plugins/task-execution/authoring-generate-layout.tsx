import type { ReactNode } from "react";
import { AssistantToolbar } from "@woohaa3/ui/assistant";
import type { PanelPresentationIntent } from "../../contract/model-interaction.js";
import { IconButton } from "@woohaa3/ui/primitives";
import {
  ChevronDownIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
} from "@woohaa3/ui/icons";
import { usePanelCollapse } from "./execution-panel/collapse-context.js";
import { CollapsedBar } from "./execution-panel/collapsed-bar.js";
import "./execution-panel/execution-panel.css";
import "./execution-panel/collapsed-bar.css";
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
  /** 收起成输入条后显示的内容；不传时窄条只显示占位文案。 */
  collapsedValue?: string;
  /** 收起成输入条后的占位文案。 */
  collapsedPlaceholder?: string;
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
  collapsedValue,
  collapsedPlaceholder = "描述你想生成的内容…",
}: AuthoringLayoutProps) {
  // 贴底时由表面提供折叠能力；全屏面与独立渲染（无 provider）拿到的 `collapsible` 是 false。
  const collapse = usePanelCollapse();
  const collapsesToBar = collapse.collapsible && presentation !== "expanded";
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
      {presentation !== "expanded" && collapsesToBar ? (
        <IconButton
          label="收起成输入条"
          title="收起成输入条"
          size="sm"
          onClick={collapse.collapse}
        >
          <ChevronDownIcon size={16} />
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

  if (collapse.collapsed) {
    return (
      <CollapsedBar
        value={collapsedValue ?? ""}
        placeholder={collapsedPlaceholder}
        onExpand={collapse.expand}
      />
    );
  }

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
