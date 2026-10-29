/**
 * 聚焦双侧连接圆点栏
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 7.2–7.5 / design D3）。
 *
 * 图片与模型聚焦在标题栏显示直接前序/后序节点入口；每个圆点有名称、内容类型与至少 44 CSS px
 * 命中区，多节点时在可滚动列表中查看。点击或键盘激活浮出类型化素材预览。
 *
 * 只读输入边界：圆点浏览不改变 selection/拓扑、不提交 Canvas 命令、不驱动画布。预览用受控
 * 同源素材；快速切换目标的迟到响应不得显示为新目标素材；离开/删除/dispose 清理资源。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import { deriveFocusConnections, type ConnectionDot } from "./derive.js";
import { resolveCanonicalMediaUrl } from "../../services/media-remote.js";
import { ChevronRightIcon, ChevronDownIcon, FileTextIcon, ImageIcon, VideoIcon, MusicIcon, LayoutGridIcon, DiamondIcon } from "@woohaa3/ui/icons";
import { Popover, Button } from "@woohaa3/ui";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";

export function FocusConnectionsBar({ focusNodeId, side }: { focusNodeId: string; side: "incoming" | "outgoing" }) {
  const canvas = useSyncExternalStore(
    woohaa3CanvasStore.subscribe,
    () => workingCanvasOf(woohaa3CanvasStore.getState()) ?? woohaa3CanvasStore.getState().canvas,
    () => null
  );
  const [expanded, setExpanded] = useState(false);
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (previewNodeId) detailRef.current?.focus(); }, [previewNodeId]);
  const returnToList = () => {
    const previousId = previewNodeId;
    setPreviewNodeId(null);
    requestAnimationFrame(() => {
      const button = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(button => button.dataset.nodeId === previousId);
      button?.focus();
    });
  };
  const connections = deriveFocusConnections(canvas, focusNodeId);
  const dots = side === "incoming" ? connections.incoming : connections.outgoing;
  const previewDot = dots.find(dot => dot.nodeId === previewNodeId);
  const label = side === "incoming" ? "前序" : "后序";
  const thumbnails = dots.slice(0, 3);
  return (
    <div className="focus-connections" data-focus-connections={side}
      data-focus-canvas-chrome="true" data-empty={!dots.length ? "true" : undefined} role="group" aria-label={`${label}节点`}>
      {side === "outgoing" ? <ChevronRightIcon className="focus-connections__direction" size={14} /> : null}
      <Popover open={expanded} onOpenChange={open => { setExpanded(open); if (!open) setPreviewNodeId(null); }} side="bottom" align="start"
        className="focus-connections__list-popover" dismissOnEscape={!previewDot}
        trigger={<button type="button" className="focus-connections__toggle" disabled={!dots.length}
          aria-label={`${label}节点（${dots.length}）`} title={dots.length ? `查看${label}节点` : `暂无${label}节点`}>
          <span className="focus-connections__label">{label}</span>
          {thumbnails.length ? <span className="focus-connections__stack" aria-hidden="true">
            {thumbnails.map(dot => <span className="focus-connections__mini" data-node-type={dot.nodeType} key={dot.nodeId}>
              <ConnectionDotContent type={dot.nodeType} asset={canvas ? resolveAsset(canvas, dot.nodeId) : null} canvasId={canvas?.id} />
            </span>)}
          </span> : null}
          {dots.length === 1 ? <span className="focus-connections__summary">{dots[0]!.nodeTitle}</span> : null}
          {dots.length > 1 ? <span className="focus-connections__count">{dots.length}</span> : null}
          <ChevronDownIcon className="focus-connections__disclosure" size={12} />
        </button>}>
        <div onKeyDownCapture={event => {
          if (event.key === "Escape" && previewDot) { event.preventDefault(); event.stopPropagation(); returnToList(); }
        }}>
          <div className="focus-connections__list-heading">{label}节点 · {dots.length}</div>
          <div ref={listRef} className="focus-connections__list" role="group" aria-label={`${label}节点列表`}
            style={previewDot ? { display: "none" } : undefined}>
            {dots.map(dot => <button key={dot.nodeId} type="button" className="focus-connections__dot focus-connections__row"
              data-node-id={dot.nodeId} aria-label={`${dot.nodeTitle}（${dot.nodeType}）`} title={dot.nodeTitle}
              onClick={() => setPreviewNodeId(dot.nodeId)}>
              <span className="focus-connections__thumbnail" data-node-type={dot.nodeType}><ConnectionDotContent type={dot.nodeType} asset={canvas ? resolveAsset(canvas, dot.nodeId) : null} canvasId={canvas?.id} /></span>
              <span className="focus-connections__name">{dot.nodeTitle}</span><ChevronRightIcon className="focus-connections__row-arrow" size={14} />
            </button>)}
          </div>
          {previewDot ? <div ref={detailRef} className="focus-connections__detail" tabIndex={-1}>
            <Button size="sm" onClick={returnToList}>返回{label}节点列表</Button>
            <ConnectionPreviewBody dot={previewDot} asset={canvas ? resolveAsset(canvas, previewDot.nodeId) : null} canvasId={canvas?.id} />
          </div> : null}
        </div>
      </Popover>
      {side === "incoming" ? <ChevronRightIcon className="focus-connections__direction" size={14} /> : null}
    </div>
  );
}

function ConnectionDotContent({ type, asset, canvasId }: { type: string; asset: StoredAsset | null; canvasId?: string }) {
  // 画布内焦点栏的缩略图按当前画布路由读取媒体。
  const url = asset ? resolveCanonicalMediaUrl(asset, canvasId) : null;
  if (type === "image" && url) {
    return <img className="focus-connections__thumb" src={url} alt="" />;
  }
  const Icon = ({ image: ImageIcon, video: VideoIcon, audio: MusicIcon, text: FileTextIcon, model3d: DiamondIcon, "composite-asset": DiamondIcon } as Record<string, typeof ImageIcon>)[type] ?? LayoutGridIcon;
  return <Icon className="focus-connections__glyph" size={16} strokeWidth={1.6} />;
}

/** 类型化预览与列表共用一个浮层，返回时恢复原行焦点。 */
function ConnectionPreviewBody({ dot, asset, canvasId }: { dot: ConnectionDot; asset: StoredAsset | null; canvasId?: string }) {
  const url = asset ? resolveCanonicalMediaUrl(asset, canvasId) : null;
  const posterUrl = asset?.posterUrl ? resolveCanonicalMediaUrl({ url: asset.posterUrl }, canvasId) : null;
  return (
      <div className="focus-connections__preview-body" role="group" aria-label={`${dot.nodeTitle} 预览`}>
        <span className="focus-connections__preview-title">{dot.nodeTitle}</span>
        {dot.nodeType === "image" && url ? <img className="focus-connections__preview-media" src={url} alt="" /> : null}
        {dot.nodeType === "video" ? (
          <video className="focus-connections__preview-media" controls preload="metadata" {...(posterUrl ? { poster: posterUrl } : {})} {...(url ? { src: url } : {})} />
        ) : null}
        {dot.nodeType === "audio" && url ? <audio className="focus-connections__preview-media" controls preload="metadata" src={url} /> : null}
        {dot.nodeType === "text" ? (
          <p className="focus-connections__preview-text">{typeof asset?.text === "string" && asset.text.trim() ? asset.text.slice(0, 280) : "暂无文本输出"}</p>
        ) : null}
        {(dot.nodeType === "model3d" || dot.nodeType === "composite-asset") ? (
          posterUrl
            ? <img className="focus-connections__preview-media" src={posterUrl} alt="" />
            : <span className="focus-connections__preview-empty">模型缩略图不可用</span>
        ) : null}
        {!url && dot.nodeType !== "text" && !(asset?.posterUrl) ? <span className="focus-connections__preview-empty">暂无输出</span> : null}
      </div>
  );
}

/** 解析节点当前权威输出资产（不启动实时 renderer）。 */
function resolveAsset(canvas: ServerCanvas, nodeId: string): StoredAsset | null {
  const data = canvas.nodeData[nodeId] as { outputAssetId?: unknown; posterAssetId?: unknown } | undefined;
  const outputId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return null;
  const asset = canvas.assets.find((candidate) => candidate.id === outputId) ?? null;
  if (!asset) return null;
  if (asset.posterUrl) return asset;
  const posterAssetId = typeof data?.posterAssetId === "string" ? data.posterAssetId : "";
  if (!posterAssetId) return asset;
  const poster = canvas.assets.find((candidate) => candidate.id === posterAssetId);
  return poster ? { ...asset, posterUrl: poster.url ?? asset.posterUrl } : asset;
}
