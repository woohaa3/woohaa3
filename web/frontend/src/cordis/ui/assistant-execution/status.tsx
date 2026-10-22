import { useRef, useState } from "react";
import type { AssistantDeliveryTarget } from "../../contract/authoring.js";
import { Button } from "../../../shared/ui/Button.js";
import { resolveAgentDetailAction } from "../../plugins/task-execution/execution-panel/agent-detail-action.js";

export function useAssistantExecutionActions() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { const result = await action(); if (!result.ok) setError(result.error ?? "操作未完成，请核对原请求"); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "操作未完成，请核对原请求"); }
    finally { pending.current = false; setBusy(false); }
  };
  return { busy, error, perform };
}

/** Shared target operations always capture the displayed execution, including old failures. */
export function AssistantExecutionStatus({ target, writable, onOpenDetail }: {
  target: AssistantDeliveryTarget;
  writable: boolean;
  onOpenDetail?: (execution: NonNullable<AssistantDeliveryTarget["execution"]>) => void;
}) {
  const { busy, error, perform } = useAssistantExecutionActions();
  const [domainOpen, setDomainOpen] = useState(false);
  const detail = resolveAgentDetailAction({ status: target.status, hasConversation: Boolean(target.execution) });
  return <div className="assistant-execution-status" data-state={target.status}>
    <p>{target.stage}</p>
    {target.reason ? <p className="authoring-generate__reason">{target.reason}</p> : null}
    <div className="assistant-execution-status__actions">
      {detail && target.execution && onOpenDetail ? <Button size="sm" tone="ghost" onClick={() => onOpenDetail(target.execution!)}>{detail.label}</Button> : null}
      {!target.execution ? <span>此记录未保存助手对话</span> : null}
      {!target.execution && target.domain ? <Button size="sm" tone="ghost" onClick={() => setDomainOpen(open => !open)}>查看任务详情</Button> : null}
      <Button size="sm" tone="ghost" disabled={busy} onClick={() => void perform(target.query)}>核对原请求</Button>
      {target.cancel ? <Button size="sm" tone="neutral" disabled={busy || !writable} onClick={() => void perform(target.cancel!)}>停止</Button> : null}
      {target.retry ? <Button size="sm" tone="primary" disabled={busy || !writable} onClick={() => void perform(target.retry!)}>重试</Button> : null}
    </div>
    {domainOpen && target.domain ? <dl>
      <dt>请求</dt><dd>{target.domain.requestId}</dd>
      <dt>来源</dt><dd>{target.domain.sourceNodeId}</dd>
      <dt>目标</dt><dd>{target.domain.targetNodeId}</dd>
      {target.domain.commandId ? <><dt>提交回执</dt><dd>{target.domain.commandId}</dd></> : null}
    </dl> : null}
    {error ? <p className="authoring-generate__reason">{error}</p> : null}
  </div>;
}
