/**
 * 片段/标签删除确认 dialog renderer
 * （change: add-prompt-snippet-library，任务 4.3 / design D8）。
 *
 * 复用 AlertDialog 语义：busy、失败保留、成功由调用方按 instanceId 关闭。
 */
import { AlertDialog } from "@woohaa3/ui/dialogs";
import type { DialogRendererProps } from "@woohaa3/frontend/extension-api";
import type { SnippetDeletePayload, TagDeletePayload } from "./dialogs.js";

export function createDeleteConfirmRenderer(
  remove: (payload: SnippetDeletePayload) => Promise<{ ok: true } | { ok: false; error: string }>
) {
  return function DeleteConfirmRenderer({ instance, requestClose, setBusy }: DialogRendererProps) {
    const payload = instance.payload as SnippetDeletePayload;
    return (
      <AlertDialog
        instanceId={instance.instanceId}
        title="删除片段"
        description={`确定删除「${payload.name}」？此操作不可撤销。`}
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onCancel={requestClose}
        onBusyChange={setBusy}
        onConfirm={() => remove(payload)}
      />
    );
  };
}

/** 标签删除确认（复用 alert payload 形状，name 为标签名）。 */
export function createTagDeleteConfirmRenderer(
  remove: (tagId: string) => Promise<{ ok: true } | { ok: false; error: string }>
) {
  return function TagDeleteConfirmRenderer({ instance, requestClose, setBusy }: DialogRendererProps) {
    const payload = instance.payload as TagDeletePayload;
    return (
      <AlertDialog
        instanceId={instance.instanceId}
        title="删除标签"
        description={`确定删除标签「${payload.name}」？关联片段会保留但失去该标签。`}
        confirmLabel="删除"
        cancelLabel="取消"
        danger
        onCancel={requestClose}
        onBusyChange={setBusy}
        onConfirm={() => remove(payload.tagId)}
      />
    );
  };
}
