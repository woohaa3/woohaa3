import { useSyncExternalStore } from "react";
import type { NodeDownloadService } from "../../services/node-download.js";
import { Button, IconButton } from "../../../shared/ui/Button.js";
import { CloseIcon } from "../../../shared/ui/icons.js";

/** Status alone is DOM chrome; the node button and its hit region are rendered by Bevy. */
export function NodeDownloadStatus({ service }: { service: NodeDownloadService }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  if (!snapshot) return null;
  return <div className="canvas-undo-toast" role={snapshot.error ? "alert" : "status"} data-testid="node-download-status">
    <span className="canvas-undo-toast__text">{snapshot.text}</span>
    {snapshot.busy ? <Button size="sm" onClick={service.cancel}>取消下载</Button>
      : <IconButton label="关闭下载提示" onClick={service.dismiss}><CloseIcon /></IconButton>}
  </div>;
}
