/**
 * Seedance Video Interaction Panel
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 5.2 / design D9）。
 *
 * Seedance 视频编辑的 React Panel：只显示编辑入口、已确认 intent 摘要与运行操作；
 * 完整时间轴/截帧编辑器位于 Plugin 自己注册的 Dialog。它通过执行面板通用组件
 * （ExecutionPanelShell / 提示词 / 运行操作）复用外观，不嵌入复杂编辑器。
 */
import { useState } from "react";
import { ExecutionPanelShell, executionRunSnapshot } from "../../ui/index.js";
import { Button } from "@woohaa3/ui";
import type { ModelPanelProps } from "../../contract/model-interaction.js";

export type SeedancePanelActions = {
  openVideoEdit: (intentId?: string) => void;
  openFrameCapture: () => void;
  removeIntent: (intentId: string) => void;
};

export function SeedanceVideoPanel(props: ModelPanelProps) {
  const { model, writable, readOnly, presentation, status, draft, blockingReasons, statusSummary } = props;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const intents = statusSummary ?? [];

  const actions = props.actions as Partial<SeedancePanelActions> | undefined;
  const busy = status === "pending" || status === "processing";
  const blocked = blockingReasons.length > 0;
  const canRun = draft.prompt.trim().length > 0 && !busy && !blocked && !readOnly && writable;

  const handleRun = () => {
    setSubmitError(null);
    void props
      .submit({
        prompt: draft.prompt,
        parameters: executionRunSnapshot({ prompt: draft.prompt, model: model.modelKey, parameters: draft.parameters }).parameters
      })
      .then((outcome) => {
        if (!outcome.ok) setSubmitError(outcome.error);
      });
  };

  return (
    <ExecutionPanelShell ariaLabel="Seedance 视频执行面板" className="mc-panel--seedance">
      <div className="mc-panel__grid">
        <div className="mc-panel__grid-item mc-panel__grid-header-actions" style={{ gridColumn: "-5 / -1" }}>
          <span className="mc-panel__grid-control">
            <div className="mc-panel__header-actions">
              <Button
                size="sm"
                className="mc-panel__close"
                aria-label="关闭执行面板"
                onClick={() => props.requestPresentation({ kind: "close" })}
              >
                关闭
              </Button>
            </div>
          </span>
        </div>
        <div className="mc-panel__grid-item mc-panel__grid-prompt" style={{ gridColumn: "span 16" }}>
          <span className="mc-panel__grid-control">
            <label className="mc-panel__prompt-label" htmlFor={`seedance-prompt-${props.nodeId}`}>
              提示词
            </label>
            <textarea
              id={`seedance-prompt-${props.nodeId}`}
              className="mc-panel__textarea nowheel"
              placeholder="描述视频内容；Enter 发送"
              value={draft.prompt}
              rows={3}
              disabled={!writable}
              onChange={(event) => props.patchDraft({ prompt: event.target.value })}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (canRun) handleRun();
                }
              }}
            />
          </span>
        </div>
        <div className="mc-panel__grid-item" style={{ gridColumn: "span 8" }}>
          <span className="mc-panel__grid-control">
            <div className="mc-panel__video-edit-entry">
              <Button
                size="sm"
                className="mc-panel__video-edit-open"
                disabled={!writable || blocked}
                onClick={() => actions?.openVideoEdit?.()}
              >
                {intents.length > 0 ? `编辑标注（${intents.length}）` : "编辑视频标注"}
              </Button>
              <Button
                size="sm"
                className="mc-panel__video-edit-open"
                disabled={!writable || blocked}
                onClick={() => actions?.openFrameCapture?.()}
              >
                视频截帧
              </Button>
            </div>
          </span>
        </div>
        {intents.length > 0 ? (
          <div className="mc-panel__grid-item" style={{ gridColumn: "span 24" }}>
            <span className="mc-panel__grid-control">
              <ul className="mc-panel__intent-summary" aria-label="已确认的视频编辑意图">
                {intents.map((label, index) => (
                  <li key={`${index}-${label}`}>{label}</li>
                ))}
              </ul>
            </span>
          </div>
        ) : null}
        <div className="mc-panel__grid-item" style={{ gridColumn: "span 24" }}>
          <span className="mc-panel__grid-control">
            <Button
              tone="primary"
              className="mc-panel__run"
              disabled={!canRun}
              onClick={handleRun}
            >
              {busy ? "生成中" : "执行生成"}
            </Button>
          </span>
        </div>
        {blockingReasons.length > 0 ? (
          <div className="mc-panel__grid-item" style={{ gridColumn: "span 24" }} role="status">
            <span className="mc-panel__grid-control">{blockingReasons.join("；")}</span>
          </div>
        ) : null}
      </div>
      {submitError ? (
        <p className="node-execution-dock__error" role="alert">
          {submitError}
        </p>
      ) : null}
      {presentation === "expanded" ? null : null}
    </ExecutionPanelShell>
  );
}
