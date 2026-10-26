/**
 * 公共聚焦顶部栏
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D5）。
 *
 * 三类 editor 与 extension 工作区共用的返回、历史、标题与版本入口。只读 Canvas Navigation
 * 的聚焦 mode：进入 focus 立即可见（媒体异步加载期间也在），退出经受控路径结算。
 *
 * 差异全部经 **props** 表达：`help`（操作帮助文案）、`hint`（导航提示）、`actions`（该
 * editor 的专用工具/视图控件）由调用方提供。本模块 MUST NOT 按 image/video/model 决定专用
 * 工具、按钮或占位（design D2：模型镜头/取景按钮归 model-editor，截帧开关归 video-editor）。
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useSlot } from "../host.js";
import { ContributionBoundary } from "../contribution-boundary.js";
import { useService } from "../react.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../services/canvas-state/index.js";
import { Button } from "../../shared/ui/Button.js";
import { BackIcon, GenerationHistoryIcon } from "../../shared/ui/icons.js";
import type { CanvasNavigationResult } from "../navigation/contracts.js";

export type FocusHeaderProps = {
  /** 节点无标题时的缺省标签（由调用方按自身语义提供）。 */
  fallbackTitle?: string;
  /** 「?」操作帮助的 hover 文案；缺省不呈现帮助按钮。 */
  help?: string;
  /** 顶部导航提示文案；缺省不呈现。 */
  hint?: string;
  /** 该 editor 的专用操作（工具开关、取景控件等），按顺序插入标题之后。 */
  actions?: ReactNode;
  /**
   * 独立文档工作区（编辑扩展工作区）的标题与来源补充。
   *
   * 提供时按文件文档语义渲染：无节点历史按钮、无「当前版本」，标题取该值而不是节点标题。
   */
  documentTitle?: string;
  /** 文档来源说明（节点名称/文件名），显示在标题之下，用于区分同名项。 */
  documentDetail?: string | null;
};

/**
 * 公共返回/历史/标题/版本/帮助顶部栏。仅在聚焦呈现时渲染（node-focus 或独立文档工作区）。
 *
 * 返回与历史经受控 Navigation API；异步退出期间禁用并给出可读错误。不写规范状态。
 */
export function FocusHeader({ fallbackTitle = "节点", help, hint, actions, documentTitle, documentDetail }: FocusHeaderProps) {
  const headerEntries = useSlot("canvas.focus-header");
  const canvasNavigation = useService("canvasNavigation");
  const canvas = useSyncExternalStore(
    woohaa3CanvasStore.subscribe,
    () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas
  );
  const snapshot = useSyncExternalStore(canvasNavigation.subscribe, canvasNavigation.getSnapshot, canvasNavigation.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<CanvasNavigationResult>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { const result = await action(); if (!result.ok) setError(result.reason); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作失败，请重试"); }
    finally { setBusy(false); }
  };
  const mode = snapshot.mode;
  if (mode.type !== "node-focus" && mode.type !== "document-workspace") return null;
  // 文件文档没有节点身份与版本历史：标题来自编辑 feature，历史入口不呈现。
  const documentMode = mode.type === "document-workspace";
  const nodeId = mode.type === "node-focus" ? mode.nodeId : null;
  const nodeTitle = nodeId ? (canvas?.nodeData[nodeId] as { title?: string } | undefined)?.title : undefined;
  const title = documentMode
    ? (documentTitle && documentTitle !== "" ? documentTitle : "独立文档")
    : nodeTitle && nodeTitle !== "" ? nodeTitle : fallbackTitle;
  const historyOpen = !documentMode && snapshot.panel?.type === "node-history" && snapshot.panel.nodeId === nodeId;
  return (
    <>
      <div className="model-focus-chrome" data-focus-canvas-chrome="true" data-focus-document={documentMode ? "true" : undefined}>
        <Button
          disabled={busy}
          className="model-focus-back"
          tone="neutral"
          size="sm"
          icon={<BackIcon className="model-focus-back__icon" />}
          onClick={() => { void run(() => canvasNavigation.requestExitNodeFocus()); }}
        >
          {busy ? "返回中…" : "返回"}
        </Button>
        <div className="focus-workspace__context focus-connections-header">
{nodeId ? headerEntries.filter(entry => entry.position === "before-title").map(entry => { const Component = entry.render; return <ContributionBoundary key={`${entry.id}:${nodeId}`} entry={entry} slot="canvas.focus-header"><Component nodeId={nodeId} /></ContributionBoundary>; }) : null}
          <span className="focus-workspace__identity" title={title}>
            <span className="focus-workspace__title">{title}</span>
            {documentMode
              ? documentDetail ? <span className="focus-workspace__version" data-document-detail="true">{documentDetail}</span> : null
              : <span className="focus-workspace__version" data-readonly={mode.owner === "history" ? "true" : undefined}>
                  {mode.owner === "history" ? "历史预览 · 只读" : "当前版本"}
                </span>}
          </span>
{nodeId ? headerEntries.filter(entry => entry.position !== "before-title").map(entry => { const Component = entry.render; return <ContributionBoundary key={`${entry.id}:${nodeId}`} entry={entry} slot="canvas.focus-header"><Component nodeId={nodeId} /></ContributionBoundary>; }) : null}
        </div>
        <div className="focus-workspace__toolbar"><div className="focus-workspace__actions">{actions}</div></div>
        {nodeId ? (
          <Button
            disabled={busy}
            className="model-focus-history"
            tone="neutral"
            size="sm"
            icon={<GenerationHistoryIcon className="model-focus-history__icon" />}
            aria-pressed={historyOpen}
            onClick={() => {
              if (historyOpen) void run(() => canvasNavigation.requestCloseNodeHistory());
              else if (mode.type === "node-focus") canvasNavigation.openNodeHistory({ nodeId, kind: mode.kind });
            }}
          >
            历史
          </Button>
        ) : null}
        {help ? <Button className="focus-workspace__help" size="sm" title={help} aria-label="操作帮助">?</Button> : null}
        {hint ? <div className="model-focus-navigation-hint">{hint}</div> : null}
      </div>
      {error ? <div className="focus-workspace__error" role="alert">{error}</div> : null}
    </>
  );
}
