import type { Context } from "@deepseek-ai/cordis";
import { useCallback, useSyncExternalStore } from "react";
import { AudioPlayer } from "@woohaa3/ui/media";
import { DownloadIcon, MusicIcon } from "@woohaa3/ui/icons";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { resolveAudioPreview } from "./media-preview.js";
import "./audio-node.css";

type Card = { id: string; canvasId: string; url: string | null; assetId: string | null; left: number; top: number; width: number; height: number; scale: number };

/** Native media controls follow accepted Bevy card bounds, like the node action toolbar.
 * Playback is page-local; no canvas mutations, second viewport or persistent player state.
 */
export function AudioNodeHost({ ctx }: { ctx: Context }) {
  const subscribe = useCallback((notify: () => void) => {
    const runtime = ctx.canvasRuntime;
    const off = [woohaa3CanvasStore.subscribe(notify), runtime.subscribe(notify),
      runtime.subscribeViewport(notify), runtime.subscribeScene?.(notify), runtime.subscribeFrame?.(notify),
      ctx.canvasNavigation.subscribe(notify), ctx.runState?.subscribe(notify)];
    window.addEventListener("resize", notify);
    return () => { off.forEach(dispose => dispose?.()); window.removeEventListener("resize", notify); };
  }, [ctx]);
  const read = useCallback(() => {
    const canvas = woohaa3CanvasStore.getState().canvas;
    const surface = document.getElementById("bevy-canvas")?.getBoundingClientRect();
    const runtime = ctx.canvasRuntime;
    if (!canvas || !surface || ctx.canvasNavigation.getSnapshot().mode.type !== "overview") return "[]";
    const origin = runtime.worldToClient({ x: 0, y: 0 });
    const unit = runtime.worldToClient({ x: 1, y: 0 });
    const scale = origin && unit ? Math.abs(unit.x - origin.x) : 0;
    if (scale < .35) return "[]";
    const cards: Card[] = [];
    for (const node of canvas.document.nodes) {
      if (node.type !== "audio" || ctx.runState?.isBusy(canvas.id, node.id) || canvas.nodeData[node.id]?.historyPreviewFailure) continue;
      const rect = runtime.nodeScreenRect(node.id, "action-toolbar");
      if (!rect || rect.left + rect.width < surface.left || rect.left > surface.right || rect.top + rect.height < surface.top || rect.top > surface.bottom) continue;
      const audio = resolveAudioPreview(canvas, node.id);
      cards.push({ id: node.id, canvasId: canvas.id, url: audio?.url ?? null, assetId: audio?.assetId ?? null,
        left: rect.left, top: rect.top, width: rect.width / scale, height: rect.height / scale, scale });
    }
    return JSON.stringify(cards);
  }, [ctx]);
  const snapshot = useSyncExternalStore(subscribe, read, () => "[]");
  const cards = JSON.parse(snapshot) as Card[];
  return <>{cards.map(card => {
    // Scale the whole media surface, including fixed-size icons and native inputs.
    const contentScale = Math.min(1, (card.width - 32) / 216, (card.height - 68) / 132);
    return <div key={`${card.canvasId}:${card.id}:${card.assetId}`} className="audio-node" data-audio-node={card.id}
    style={{ left: card.left, top: card.top, width: card.width, height: card.height, transform: `scale(${card.scale})` }}>
    <div className="audio-node__content">
      <div className="audio-node__body" style={{ width: `${100 / contentScale}%`, height: `${100 / contentScale}%`, transform: `scale(${contentScale})` }}>
      {card.url ? <div className="audio-node__interactive"
        onPointerDown={event => { if (event.button === 0 && !event.altKey && !event.shiftKey) event.stopPropagation(); }}
        onPointerUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        <AudioPlayer url={card.url} />
        <div className="audio-node__footer"><span>音频</span><button type="button" title="下载音频"
          onClick={() => ctx.emit("ui.node-download.save-requested", { nodeId: card.id })}><DownloadIcon size={14} /></button></div>
      </div> : <div className="audio-node__empty"><MusicIcon size={25} /><span>等待生成</span></div>}
      </div>
    </div>
  </div>; })}</>;
}
