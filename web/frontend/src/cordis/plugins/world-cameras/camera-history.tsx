import type { Context } from "@deepseek-ai/cordis";
import { useEffect, useState } from "react";
import type { WorldCameraHistoryEntry } from "@woohaa3/contracts";
import { Button, DialogSurfaceRoot } from "@woohaa3/ui/primitives";
import { Dialog } from "@woohaa3/ui/dialogs";
import { loadWorldCameraHistory, worldCameraUiFailureText } from "../../services/world-camera-ui.js";
import { worldCameraEditorStore, type WorldCameraEditSession } from "../../services/world-camera-editor-store.js";

/** History loads into the edit draft; persistence still belongs to Save and exit. */
export function CameraHistory({ ctx, session, onClose }: { ctx: Context; session: WorldCameraEditSession; onClose: () => void }) {
  const [entries, setEntries] = useState<WorldCameraHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadWorldCameraHistory(ctx.canvasRemote, { canvasId: session.canvasId, cameraId: session.source.cameraId }, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (result.ok) setEntries(result.entries);
      else setError(worldCameraUiFailureText(result));
    });
    return () => controller.abort();
  }, [ctx, session.canvasId, session.source.cameraId]);
  return <DialogSurfaceRoot open modal dismissible onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Content size="sm" ariaLabel="镜头历史">
      <Dialog.Header onClose={onClose}><Dialog.Title>镜头历史</Dialog.Title>
        <Dialog.Description>载入历史构图到本次调整，保存并退出后生效。场景内容保持当前版本。</Dialog.Description>
      </Dialog.Header>
      <Dialog.Body>
        {loading ? <p>正在读取镜头历史…</p> : error ? <p>{error}</p> : entries.length === 0 ? <p>暂无助手镜头历史。</p> : entries.map(entry => <div className="world-camera-editor__history-row" key={entry.completionKey}>
          <span>{new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
          <Button size="sm" onClick={() => {
            worldCameraEditorStore.update({ ...entry.snapshot.camera, cameraId: session.source.cameraId, settingsVersion: session.source.settingsVersion });
            onClose();
          }}>使用此构图</Button>
        </div>)}
      </Dialog.Body>
    </Dialog.Content>
  </DialogSurfaceRoot>;
}
