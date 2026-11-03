/**
 * 卡片右侧外面的版本「图层」列表（类似 PS 图层面板）。
 *
 * 取代原来 Bevy 画在卡片底部的历史圆点：每个版本一张小缩略图，竖着排，最新的在最上面；
 * 当前生效版本描边加粗，正在预览的版本用另一圈高亮，运行中显示转圈，失败显示感叹号。
 * 点击走和圆点同一个 `activate` 入口，只预览还是预览并应用由选择控制器决定。
 *
 * 位置由 `nodeScreenRect` 投影，与「添加到对话框」胶囊同一套刷新方式：视口、场景、帧回调或外框
 * 尺寸变化时，只有渲染过的矩形与此刻不同才重渲染，静止时不产生渲染。
 */
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RunInputSnapshot } from "@woohaa3/contracts";
import { useService } from "../../react.js";
import { historyLayersStore, type HistoryLayer } from "../../services/history-layers-store.js";
import { HistoryInputCard, INPUT_CARD_WIDTH } from "./history-input-card.js";
import "./history-layers.css";
import "./history-input-card.css";

/** 缩略图边长与间距（CSS 里同名数值保持一致）。 */
export const LAYER_SIZE = 40;
/** 与卡片的间距、与视口边缘的最小留白。 */
export const LAYER_OFFSET = 8;
/** 最多画几层，其余折成「+N」。 */
export const MAX_VISIBLE_LAYERS = 8;
/** 卡片缩得太小（画布缩远）时不画，免得缩略图比卡片还大。 */
export const MIN_CARD_WIDTH = 80;

export type LayerSelectRequest = { nodeId: string; presentationId?: string; entryId?: string; operationId?: string };

/**
 * 列表项的图片变体：图片用 `preview`（302 到原图，浏览器缩放显示）；视频用 `poster`（海报帧）。
 * 不用 `thumbnail`：那是**模型**专用的受控派生 PNG 路由，图片/视频条目请求会 404。
 */
export function layerVariant(nodeType: string): "preview" | "poster" {
  return nodeType === "video" ? "poster" : "preview";
}

type Props = {
  canvasId: () => string;
  previewUrl: (input: { canvasId: string; nodeId: string; entryId: string; variant: "preview" | "poster" }) => string;
  onSelect: (request: LayerSelectRequest) => void;
  /** 某个版本生成时的输入快照；旧版本没有则返回 undefined。 */
  getInput: (nodeId: string, entryId: string) => RunInputSnapshot | undefined;
  assetUrl: (assetId: string) => string | null;
  modelLabel: (modelKey: string) => string;
  /** 「重新编辑」：把快照载回该节点的对话框。 */
  onReedit: (nodeId: string, snapshot: RunInputSnapshot) => void;
};

type Rect = { left: number; top: number; width: number; height: number };

function rectKey(rect: Rect | null): string {
  if (!rect) return "";
  const q = (value: number) => Math.round(value * 2) / 2;
  return `${q(rect.left)}|${q(rect.top)}|${q(rect.width)}|${q(rect.height)}`;
}

function subscribeResize(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}
const readViewportWidth = (): number => (typeof window === "undefined" ? 0 : window.innerWidth);

/**
 * 一列图层放在卡片的哪里：默认在右侧外面、顶端对齐；右侧放不下（贴着视口右缘）就翻到左侧。
 * 纯函数，便于单测。
 */
export function layersColumnPosition(rect: Rect, viewportWidth: number): { left: number; top: number } {
  const right = rect.left + rect.width + LAYER_OFFSET;
  const fitsRight = viewportWidth <= 0 || right + LAYER_SIZE + LAYER_OFFSET <= viewportWidth;
  return { left: fitsRight ? right : rect.left - LAYER_OFFSET - LAYER_SIZE, top: rect.top };
}

function layerLabel(layer: HistoryLayer): string {
  switch (layer.state) {
    case "running": return "生成中";
    case "queued": return "排队中";
    case "failed": return "生成失败";
    case "cancelled": return "已取消";
    case "interrupted": return "已中断";
    case "partial": return "部分完成";
    default: return layer.current ? "当前版本" : "历史版本";
  }
}

export function HistoryLayersOverlay({ canvasId, previewUrl, onSelect, getInput, assetUrl, modelLabel, onReedit }: Props) {
  const runtime = useService("canvasRuntime");
  const byNode = useSyncExternalStore(historyLayersStore.subscribe, historyLayersStore.getSnapshot, historyLayersStore.getSnapshot);
  useSyncExternalStore(runtime.subscribeViewport, runtime.viewportVersion, runtime.viewportVersion);
  const viewportWidth = useSyncExternalStore(subscribeResize, readViewportWidth, readViewportWidth);
  const [, setTick] = useState(0);
  /** 当前展开「当时的输入」卡片的版本（点缩略图切换，再点收起）。 */
  const [openInput, setOpenInput] = useState<{ nodeId: string; entryId: string } | null>(null);
  const renderedKey = useRef("");

  useEffect(() => {
    const bump = () => setTick((tick) => tick + 1);
    const currentKey = () => {
      const parts: string[] = [];
      for (const nodeId of historyLayersStore.getSnapshot().keys()) parts.push(`${nodeId}:${rectKey(runtime.nodeScreenRect(nodeId))}`);
      return parts.join(";");
    };
    const recheck = () => {
      if (currentKey() !== renderedKey.current) bump();
    };
    const offScene = runtime.subscribeScene?.(recheck);
    const offFrame = runtime.subscribeFrame?.(recheck);
    const surface = document.getElementById("bevy-canvas");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(recheck);
    if (surface) observer?.observe(surface);
    if (surface?.parentElement) observer?.observe(surface.parentElement);
    return () => {
      offScene?.();
      offFrame?.();
      observer?.disconnect();
    };
  }, [runtime]);

  const columns: Array<{ nodeId: string; nodeType: string; rect: Rect; layers: HistoryLayer[]; hidden: number }> = [];
  const keys: string[] = [];
  for (const [nodeId, value] of byNode) {
    const rect = runtime.nodeScreenRect(nodeId);
    keys.push(`${nodeId}:${rectKey(rect)}`);
    if (!rect || rect.width < MIN_CARD_WIDTH || value.layers.length === 0) continue;
    // PS 习惯：最新的在最上面。
    const newestFirst = [...value.layers].reverse();
    const shown = newestFirst.slice(0, MAX_VISIBLE_LAYERS);
    columns.push({ nodeId, nodeType: value.nodeType, rect, layers: shown, hidden: newestFirst.length - shown.length + value.truncated });
  }
  renderedKey.current = keys.join(";");
  if (columns.length === 0) return null;

  return (
    <>
      {columns.map(({ nodeId, nodeType, rect, layers, hidden }) => {
        const position = layersColumnPosition(rect, viewportWidth);
        const flipped = position.left < rect.left;
        const cardOpen = openInput?.nodeId === nodeId ? openInput.entryId : null;
        return (
          <Fragment key={nodeId}>
          <div
            className="history-layers"
            style={{ left: `${Math.round(position.left)}px`, top: `${Math.round(position.top)}px` }}
            data-node-id={nodeId}
            role="group"
            aria-label="版本"
          >
            {layers.map((layer, index) => {
              const showImage = layer.state === "succeeded" && !!layer.entryId;
              return (
                <button
                  key={layer.presentationId ?? layer.operationId ?? layer.entryId ?? index}
                  type="button"
                  className="history-layer"
                  data-state={layer.state}
                  data-current={layer.current ? "true" : undefined}
                  data-selected={layer.selected ? "true" : undefined}
                  data-unseen={layer.unseen ? "true" : undefined}
                  aria-pressed={layer.selected === true}
                  aria-label={layerLabel(layer)}
                  title={layerLabel(layer)}
                  onClick={() => {
                    setOpenInput((previous) => layer.state !== "succeeded" || !layer.entryId || (previous?.nodeId === nodeId && previous.entryId === layer.entryId)
                      ? null
                      : { nodeId, entryId: layer.entryId });
                    onSelect({
                    nodeId,
                    ...(layer.presentationId ? { presentationId: layer.presentationId } : {}),
                    ...(layer.entryId ? { entryId: layer.entryId } : {}),
                    ...(layer.operationId ? { operationId: layer.operationId } : {})
                  });
                  }}
                >
                  {showImage ? (
                    <img
                      className="history-layer__image"
                      alt=""
                      draggable={false}
                      loading="lazy"
                      src={previewUrl({ canvasId: canvasId(), nodeId, entryId: layer.entryId!, variant: layerVariant(nodeType) })}
                    />
                  ) : (
                    <span className="history-layer__glyph" aria-hidden="true">{layer.state === "running" || layer.state === "queued" ? "" : "!"}</span>
                  )}
                </button>
              );
            })}
            {hidden > 0 ? <span className="history-layers__more">+{hidden}</span> : null}
          </div>
          {cardOpen ? (
            <HistoryInputCard
              snapshot={getInput(nodeId, cardOpen)}
              assetUrl={assetUrl}
              modelLabel={modelLabel}
              onReedit={(snapshot) => { onReedit(nodeId, snapshot); setOpenInput(null); }}
              onClose={() => setOpenInput(null)}
              style={{
                left: `${Math.round(flipped ? position.left - 8 - INPUT_CARD_WIDTH : position.left + LAYER_SIZE + 8)}px`,
                top: `${Math.round(position.top)}px`
              }}
            />
          ) : null}
          </Fragment>
        );
      })}
    </>
  );
}
