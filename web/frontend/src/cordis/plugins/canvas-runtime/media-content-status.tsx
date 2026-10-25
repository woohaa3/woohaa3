import { useSyncExternalStore } from "react";
import { useService } from "../../react.js";
import { Button } from "../../../shared/ui/Button.js";
/** Content diagnostics share the selected media node; they never rewrite an unavailable reference. */
export function MediaContentStatus() {
  const service = useService("mediaContent"), selection = useService("selection"), canvas = useService("canvasState"), runtime = useService("canvasRuntime");
  const selected = useSyncExternalStore(selection.subscribe, selection.getSnapshot, selection.getSnapshot).primaryNodeId;
  useSyncExternalStore(canvas.subscribe, canvas.getCanvas, canvas.getCanvas);
  useSyncExternalStore(runtime.subscribeViewport, runtime.viewportVersion, runtime.viewportVersion);
  const state = useSyncExternalStore(service.subscribe, () => selected ? service.state(selected) : undefined, () => undefined);
  const rect = selected && runtime.nodeScreenRect(selected);
  if (!state || !rect || state.status === "ready") return null;
  return <div className="media-content-status" style={{ left: rect.left, top: rect.top + rect.height + 8 }}>
    <span>{state.status === "pending" ? "正在更新镜头内容，保留上次结果…" : state.diagnostic ?? "内容来源暂不可用"}</span>
    {state.status === "failed" ? <Button size="sm" tone="ghost" onClick={() => service.retry(selected!)}>重试内容加载</Button> : null}
  </div>;
}
