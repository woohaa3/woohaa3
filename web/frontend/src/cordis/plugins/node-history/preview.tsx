/**
 * 节点生成历史类型化预览 leaf
 * （change: add-canvas-generation-history-dialog，从 `panel.tsx` 抽出复用；
 *  change: 2026-10-09-improve-canvas-workflow，任务 6.2：稳定尺寸的加载/失败/重试占位）。
 *
 * 只消费受控预览引用（`NodeHistoryPreview`），不直接读取 `storageKey`、完整正文或脚本。
 * 图片、视频海报与模型缩略图注册加载/失败回调：失败保留条目与可读原因，提供显式重试；
 * 一次重试最多重新解析引用并加载一次（通过 `retryKey` 触发重新挂载），不无限自动重试。
 * 素材失效不等于历史记录消失；预览可用性不替代恢复能力判断。
 */
import { lazy, Suspense, useEffect, useState } from "react";
const ModelThumbnail = lazy(() => import("./model-thumbnail.js").then(module => ({ default: module.ModelThumbnail })));
import type { NodeHistoryPreview } from "@woohaa3/contracts";

export type HistoryPreviewProps = {
  preview: NodeHistoryPreview;
  /** 是否在缩略图样式中渲染（默认 true）；大图预览时传 false。 */
  thumbnail?: boolean;
  className?: string;
  /**
   * 显式重试：重新解析受控引用一次。宿主应重新获取 preview 并递增 `retryKey`；
   * 缺省时只重置本地失败状态（重新加载同一 URL）。
   */
  onRetry?: () => void;
  /** 变化即重新挂载媒体（一次受控重试）。 */
  retryKey?: number;
  /** 素材已不可用的可读原因（与“暂时无法加载”区分）。 */
  unavailableReason?: string;
};

type MediaState = "loading" | "ready" | "failed";

export function HistoryPreview({ preview, thumbnail = true, className, onRetry, retryKey, unavailableReason }: HistoryPreviewProps) {
  const classes = [thumbnail ? "node-history__thumb" : "canvas-history__preview", className].filter(Boolean).join(" ");
  const mediaKind = preview.kind === "model" ? "model" : preview.kind === "image" ? "image" : preview.kind === "video" ? "video" : null;
  const href = preview.kind === "model"
    ? preview.thumbnailHref
    : preview.kind === "image"
      ? preview.href
      : preview.kind === "video"
        ? preview.posterHref
        : undefined;

  return (
    <div className={classes} data-preview-kind={preview.kind}>
      {mediaKind && href ? (
        mediaKind === "model" ? <Suspense fallback={<span className="node-history__thumb-loading" />}><ModelThumbnail key={`${href}:${retryKey ?? 0}`} href={href} thumbnail={thumbnail}
          {...(onRetry ? { onRetry } : {})} {...(unavailableReason ? { unavailableReason } : {})} /></Suspense> : <HistoryMedia
          key={`${href}:${retryKey ?? 0}`}
          kind={mediaKind}
          href={href}
          thumbnail={thumbnail}
          {...(onRetry ? { onRetry } : {})}
          {...(retryKey !== undefined ? { retryKey } : {})}
          {...(unavailableReason ? { unavailableReason } : {})}
        />
      ) : preview.kind === "audio" ? (
        <span className="node-history__thumb-fallback">音频</span>
      ) : preview.kind === "failure" ? (
        <span className="node-history__thumb-fallback node-history__failure" data-outcome={preview.outcome}>
          {preview.outcome === "cancelled" ? "已取消" : preview.outcome === "interrupted" ? "已中断" : preview.outcome === "partial" ? "部分成功" : "失败"}
        </span>
      ) : preview.kind === "text" ? (
        <span className="node-history__thumb-fallback node-history__excerpt">{preview.excerpt}</span>
      ) : (
        <span className="node-history__thumb-fallback">{mediaKind === "model" ? "模型" : "视频"}</span>
      )}
    </div>
  );
}

function HistoryMedia({
  kind,
  href,
  thumbnail,
  onRetry,
  retryKey,
  unavailableReason
}: {
  kind: "model" | "image" | "video";
  href: string;
  thumbnail: boolean;
  onRetry?: () => void;
  retryKey?: number;
  unavailableReason?: string;
}) {
  const [state, setState] = useState<MediaState>("loading");
  // retryKey 变化即重置为加载中（一次受控重试）。
  useEffect(() => {
    setState("loading");
  }, [retryKey, href]);

  if (state === "failed") {
    return (
      <span className="node-history__thumb-failed" role="alert" data-state="failed">
        <span className="node-history__thumb-failed-text">
          {unavailableReason ?? "暂时无法加载预览"}
        </span>
        <button
          type="button"
          className="node-history__thumb-retry"
          onClick={() => {
            setState("loading");
            onRetry?.();
          }}
        >
          重试
        </button>
      </span>
    );
  }

  return (
    <span className="node-history__thumb-media" data-state={state}>
      {state === "loading" ? <span className="node-history__thumb-loading" aria-hidden="true" /> : null}
      {kind === "video" ? (
        <video
          className="node-history__thumb-video"
          src={href}
          poster={href}
          muted
          playsInline
          preload="metadata"
          onLoadedData={() => setState("ready")}
          onError={() => setState("failed")}
        />
      ) : (
        <img
          src={href}
          alt=""
          loading="lazy"
          data-thumbnail={thumbnail ? "true" : "false"}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      )}
    </span>
  );
}
