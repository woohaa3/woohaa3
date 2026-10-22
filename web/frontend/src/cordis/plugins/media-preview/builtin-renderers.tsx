/**
 * 内置 Dialog renderer 工厂
 * （change: add-frontend-dialog-system，任务 3.1 / 4.3；
 *  change: adopt-frontend-cordis-plugin-runtime 改为 Plugin 注册，不再有 import-time 副作用）。
 *
 * 把共享 primitives 接到 Dialog Service：`media-preview` 用 media fullscreen Dialog，
 * `alert` 用 AlertDialog。renderer 工厂注入 `DialogsService`，因此不依赖模块级单例。
 */
import { lazy, Suspense, useSyncExternalStore } from "react";
import { AlertDialog } from "../../services/dialogs/AlertDialog.js";
const MediaDialog = lazy(() => import("../../services/dialogs/MediaDialog.js").then(module => ({ default: module.MediaDialog })));
import type { DialogRendererProps } from "../../services/dialogs/renderer-registry.js";
import { resolveAudioPreview, resolveImagePreview } from "./media-preview.js";
import { resolveTextPreview } from "./text-preview.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { DialogsService } from "../../contracts.js";
import type { ServerCanvas } from "@woohaa3/contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DialogBody, DialogContent, DialogHeader, DialogTitle } from "../../services/dialogs/Dialog.js";

type AlertPayload = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  actionKey?: string;
};

/** 订阅 canonical canvas（media-preview 从当前 canonical 资产解析 URL）。 */
function useCanonicalCanvas(): ServerCanvas | null {
  return useSyncExternalStore(
    (notify) => woohaa3CanvasStore.subscribe(notify),
    () => woohaa3CanvasStore.getState().canvas,
    () => woohaa3CanvasStore.getState().canvas
  );
}

/** media-preview renderer：从 canonical asset 重新解析，切换 assetId 由 `key` 重置查看状态。 */
export function createMediaPreviewRenderer() {
  return function MediaPreviewRenderer({ instance, requestClose }: DialogRendererProps) {
    const canvas = useCanonicalCanvas();
    const payload = instance.payload as import("./media-preview.js").MediaPreviewPayload;
    const audio = payload.kind === "audio" && canvas?.id === payload.canvasId ? resolveAudioPreview(canvas, payload.nodeId, payload.assetId) : null;
    const resolved = payload.kind === "audio" ? audio : resolveImagePreview(canvas, payload.assetId);
    return (
      <Suspense fallback={<p>正在加载媒体预览…</p>}><MediaDialog
        key={`${canvas?.id}:${payload.nodeId}:${payload.assetId}:${resolved?.url ?? "unavailable"}`}
        instanceId={instance.instanceId}
        title={audio?.title ?? payload.title}
        url={resolved?.url ?? null}
        kind={resolved?.mediaKind ?? payload.kind ?? "image"}
        unavailableReason={payload.kind === "audio" ? "音频输出已更换、目标已删除或画布已切换，请关闭后从当前节点重新试听" : "该图片资产已失效或不可预览"}
        onClose={requestClose}
      /></Suspense>
    );
  };
}

export function createTextPreviewRenderer() {
  return function TextPreviewRenderer({ instance, requestClose }: DialogRendererProps) {
    const canvas = useCanonicalCanvas();
    const payload = instance.payload as { nodeId: string };
    const resolved = resolveTextPreview(canvas, payload.nodeId);
    return <DialogContent size="lg" className="text-preview-dialog" ariaLabel={resolved?.title ?? "文本预览"} instanceId={instance.instanceId}>
      <DialogHeader onClose={requestClose}><DialogTitle>{resolved?.title ?? "文本预览"}</DialogTitle></DialogHeader>
      <DialogBody className="text-preview-dialog__body">
        {resolved ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{resolved.text}</ReactMarkdown> : <p>文本内容已不可用。</p>}
      </DialogBody>
    </DialogContent>;
  };
}

/** alert renderer：从 payload.actionKey 解析异步动作；无动作即纯确认。 */
export function createAlertRenderer(dialogs: DialogsService) {
  return function AlertRenderer({ instance, requestClose, setBusy }: DialogRendererProps) {
    const payload = instance.payload as AlertPayload;
    const action = dialogs.resolveAlertAction(payload.actionKey);
    return (
      <AlertDialog
        instanceId={instance.instanceId}
        title={payload.title}
        description={payload.description}
        confirmLabel={payload.confirmLabel}
        cancelLabel={payload.cancelLabel}
        danger={payload.danger}
        onCancel={requestClose}
        onBusyChange={setBusy}
        onConfirm={async () => (action ? action() : { ok: true })}
      />
    );
  };
}
