import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { shotPreviewOwnershipOf, FILM_SET_SHOT_PREVIEW_NODE_TYPE } from "@woohaa3/contracts";
import { Button } from "@woohaa3/frontend/extension-api";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";
import { shotMediaRef } from "./shot-media-provider.js";
import "./shot-media-drag.css";
/** An explicit drag handle creates a media node; the protected preview itself remains untouched. */
export function ShotMediaDrag({ ctx, writable }: { ctx: FilmSetHostContext; writable: boolean }) {
  const canvas = useSyncExternalStore(ctx.canvasState.subscribe, ctx.canvasState.getCanvas, ctx.canvasState.getCanvas);
  const selection = useSyncExternalStore(ctx.selection.subscribe, ctx.selection.getSnapshot, ctx.selection.getSnapshot);
  useSyncExternalStore(ctx.canvasRuntime.subscribeViewport, ctx.canvasRuntime.viewportVersion, ctx.canvasRuntime.viewportVersion);
  const [notice, setNotice] = useState("");
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const node = canvas?.document.nodes.find(n => n.id === selection.primaryNodeId && n.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE);
  const owner = node && shotPreviewOwnershipOf(canvas?.nodeData[node.id]);
  const rect = node && ctx.canvasRuntime.nodeScreenRect(node.id);
  if (!canvas || !node || !owner || !rect) return null;
  const begin = (event: PointerEvent) => {
    if (!writable || !ctx.canvasSession.isWritable() || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); cleanup.current?.(); setNotice("");
    const start = { x: event.clientX, y: event.clientY }, canvasId = canvas.id;
    const ref = shotMediaRef(owner.filmSetNodeId, owner.clipId);
    let cancelled = false;
    const clear = () => { document.removeEventListener("pointerup", end, true); document.removeEventListener("pointercancel", cancel, true); cleanup.current = null; };
    const cancel = () => { cancelled = true; clear(); };
    const end = (up: globalThis.PointerEvent) => {
      clear();
      if (cancelled || Math.hypot(up.clientX - start.x, up.clientY - start.y) < 6) return;
      try {
        const latest = ctx.canvasState.getCanvas(), world = ctx.canvasRuntime.clientToWorld({ x: up.clientX, y: up.clientY });
        if (!latest || latest.id !== canvasId || !world || !ctx.canvasSession.isWritable()) throw Error("画布已切换或不可写");
        const sourceData = latest.nodeData[owner.filmSetNodeId];
        const provider = ctx.mediaContent;
        // Ask the provider for the actual kind. A mismatch is rejected before creating anything.
        let kind: "image" | "video" = "image";
        try { provider.describe(latest, ref, kind); } catch { kind = "video"; provider.describe(latest, ref, kind); }
        const id = `shot-media-${crypto.randomUUID()}`;
        const submitted = ctx.canvasSession.submitCommands([
          { type: "nodeData.patch", nodeId: owner.filmSetNodeId, value: {}, expectedNodeData: { [owner.filmSetNodeId]: sourceData ?? null } },
          { type: "node.add", node: { id, type: kind, position: world, width: 320, height: 200 }, nodeData: { title: kind === "image" ? "镜头图片" : "镜头视频", mediaContent: ref, status: "draft" } },
        ], `shot-media-create:${id}`);
        if (!submitted.ok) throw Error(submitted.reason);
        void submitted.handle.settled.then(result => {
          if (result.state === "rejected" && ctx.canvasState.getCanvas()?.id === canvasId) setNotice(result.error ?? "镜头拖出失败");
        });
      } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    };
    document.addEventListener("pointerup", end, true); document.addEventListener("pointercancel", cancel, true);
    cleanup.current = cancel;
  };
  return <div className="shot-media-drag" style={{ left: rect.left + rect.width / 2, top: rect.top + rect.height + 8 }}>
    <Button size="sm" disabled={!writable} onPointerDown={begin} title="按住并拖到画布空位，创建跟随此镜头的图片或完整视频">拖出为媒体</Button>
    {notice ? <p>{notice}</p> : null}
  </div>;
}
