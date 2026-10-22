/**
 * 单图替换确认 dialog
 * （change: add-paste-import-workflows，任务 5.2 / design D5）。
 *
 * 由 Paste Import Plugin 通过 Dialog Service 可逆注册：definition + renderer。renderer 只渲染
 * 「创建新节点 / 替换选中节点 / 取消」，真正的上传与命令提交由 Plugin 提供的 resolver 完成；
 * busy、Escape、遮罩、焦点与画布输入隔离全部由 Dialog Host 统一拥有（不另建 document listener）。
 */
import { useState } from "react";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../services/dialogs/Dialog.js";
import { Button } from "../../../shared/ui/index.js";
import { objectPayload } from "../../services/dialogs/registry.js";
import type { DialogDefinition } from "../../services/dialogs/types.js";
import type { DialogRendererProps } from "../../services/dialogs/renderer-registry.js";

export const PASTE_REPLACE_DIALOG_ID = "paste-replace-image";

export type ReplaceConfirmPayload = {
  intentId: string;
  fileName: string;
  nodeLabel: string;
};

export type ReplaceChoice = "create" | "replace";

/** resolver：执行用户选择；成功后由它按 instanceId 关闭弹窗。 */
export type ReplaceResolver = (
  instanceId: string,
  intentId: string,
  choice: ReplaceChoice
) => Promise<{ ok: true } | { ok: false; error: string }>;

export const replaceConfirmDefinition: DialogDefinition = {
  dismissible: true,
  singleton: false,
  validatePayload: objectPayload<ReplaceConfirmPayload>(PASTE_REPLACE_DIALOG_ID, (value) => {
    const intentId = value.intentId;
    const fileName = value.fileName;
    const nodeLabel = value.nodeLabel;
    if (typeof intentId !== "string" || intentId === "") return null;
    if (typeof fileName !== "string" || fileName === "") return null;
    if (typeof nodeLabel !== "string" || nodeLabel === "") return null;
    return { intentId, fileName, nodeLabel };
  })
};

export function createReplaceConfirmRenderer(resolve: ReplaceResolver) {
  return function ReplaceConfirmRenderer({ instance, requestClose, setBusy }: DialogRendererProps) {
    const payload = instance.payload as ReplaceConfirmPayload;
    const [error, setError] = useState<string | null>(null);
    const [busy, setLocalBusy] = useState(false);

    const run = async (choice: ReplaceChoice) => {
      if (busy) return;
      setError(null);
      setLocalBusy(true);
      setBusy(true);
      const result = await resolve(instance.instanceId, payload.intentId, choice);
      if (result.ok) return; // resolver 已按 instanceId 关闭弹窗。
      setError(result.error);
      setLocalBusy(false);
      setBusy(false);
    };

    return (
      <Dialog.Content
        variant="alert"
        size="sm"
        busy={busy}
        labelledBy={`${instance.instanceId}-title`}
        describedBy={`${instance.instanceId}-desc`}
        instanceId={instance.instanceId}
        onOverlayClick={busy ? undefined : requestClose}
      >
        <DialogHeader onClose={busy ? undefined : requestClose}>
          <DialogTitle id={`${instance.instanceId}-title`}>替换图片</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <DialogDescription id={`${instance.instanceId}-desc`}>
            将「{payload.fileName}」替换到选中的图片节点「{payload.nodeLabel}」，或创建一个新节点。
          </DialogDescription>
          {error ? (
            <p className="dlg__error" role="alert">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={requestClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void run("create")} disabled={busy}>
            创建新节点
          </Button>
          <Button
            tone="primary"
            onClick={() => void run("replace")}
            disabled={busy}
            aria-busy={busy ? "true" : undefined}
          >
            替换选中节点
          </Button>
        </DialogFooter>
      </Dialog.Content>
    );
  };
}
