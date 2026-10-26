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
import { lazy, Suspense, useEffect, useRef, useState } from "react";
const ModelThumbnail = lazy(() => import("./model-thumbnail.js").then(module => ({ default: module.ModelThumbnail })));
import { Button } from "../../../shared/ui/Button.js";
import { AudioPlayer } from "../../../shared/ui/AudioPlayer.js";
import type { NodeHistoryPreview } from "@woohaa3/contracts";
import type { ModelThumbnailRenderer } from "./model-thumbnail-render.js";

/** 没有页面渲染器时的确定性失败态：模型预览不做服务端兜底。 */
const unavailableThumbnail: ModelThumbnailRenderer = async () => ({ ok: false, code: "renderer-unavailable" });

export type HistoryPreviewProps = {
  preview: NodeHistoryPreview;
  /** 是否在缩略图样式中渲染（默认 true）；大图预览时传 false。 */
  thumbnail?: boolean;
  className?: string;
  /**
   * 页面内模型缩略图渲染器
   * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
   *
   * 缺省时模型预览直接进入「渲染未就绪」失败态——不再请求服务端 PNG。
   */
  renderModelThumbnail?: ModelThumbnailRenderer;
  /**
   * 显式重试：重新解析受控引用一次。宿主应重新获取 preview 并递增 `retryKey`；
   * 缺省时只重置本地失败状态（重新渲染同一版本）。
   */
  onRetry?: () => void;
  /** 变化即重新挂载媒体（一次受控重试）。 */
  retryKey?: number;
  /** 素材已不可用的可读原因（与“暂时无法加载”区分）。 */
  unavailableReason?: string;
};

type MediaState = "loading" | "ready" | "failed";

export function HistoryPreview({ preview, thumbnail = true, className, onRetry, retryKey, unavailableReason, renderModelThumbnail }: HistoryPreviewProps) {
  const classes = [thumbnail ? "node-history__thumb" : "canvas-history__preview", className].filter(Boolean).join(" ");
  return (
    <div className={classes} data-preview-kind={preview.kind}>
      {preview.kind === "audio" && !thumbnail ? <AudioPlayer key={preview.href} url={preview.href} /> : preview.kind === "video" && !thumbnail ? <HistoryVideo key={preview.href} href={preview.href} poster={preview.posterHref} /> : preview.kind === "model" ? (
        <Suspense fallback={<span className="node-history__thumb-loading" />}><ModelThumbnail key={`${preview.entry.entryId}:${retryKey ?? 0}`} entry={preview.entry} render={renderModelThumbnail ?? unavailableThumbnail} thumbnail={thumbnail}
          {...(onRetry ? { onRetry } : {})} {...(unavailableReason ? { unavailableReason } : {})} /></Suspense>
      ) : preview.kind === "image" ? (
        <HistoryMedia
          key={`${preview.href}:${retryKey ?? 0}`}
          href={preview.href}
          thumbnail={thumbnail}
          {...(onRetry ? { onRetry } : {})}
          {...(retryKey !== undefined ? { retryKey } : {})}
          {...(unavailableReason ? { unavailableReason } : {})}
        />
      ) : preview.kind === "video" && preview.posterHref ? (
        <HistoryMedia
          key={`${preview.posterHref}:${retryKey ?? 0}`}
          href={preview.posterHref}
          thumbnail={thumbnail}
          {...(onRetry ? { onRetry } : {})}
          {...(retryKey !== undefined ? { retryKey } : {})}
          {...(unavailableReason ? { unavailableReason } : {})}
        />
      ) : preview.kind === "video" ? (
        // 没有稳定 poster：直接取该版本受控视频地址的首帧作为缩略图（不自动播放）。
        <HistoryVideoThumbnail
          key={`${preview.href}:${retryKey ?? 0}`}
          href={preview.href}
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
      ) : null}
    </div>
  );
}

function HistoryMedia({
  href,
  thumbnail,
  onRetry,
  retryKey,
  unavailableReason
}: {
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
    return <ThumbFailure unavailableReason={unavailableReason} onRetry={onRetry} onReset={() => setState("loading")} />;
  }

  return (
    <span className="node-history__thumb-media" data-state={state}>
      {state === "loading" ? <span className="node-history__thumb-loading" aria-hidden="true" /> : null}
      <img
        src={href}
        alt=""
        loading="lazy"
        data-thumbnail={thumbnail ? "true" : "false"}
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
      />
    </span>
  );
}

/**
 * 无稳定 poster 的视频缩略图：用受控视频地址在列表内取首帧。
 *
 * `preload="metadata"` 只拉取元数据与首帧附近字节；媒体地址支持 Range，不整段下载。
 * 片头黑场时用 `#t` 一起把画面定位到极短的偏移，仍属于该版本的画面，不自动播放。
 */
function HistoryVideoThumbnail({
  href,
  onRetry,
  retryKey,
  unavailableReason
}: {
  href: string;
  onRetry?: () => void;
  retryKey?: number;
  unavailableReason?: string;
}) {
  const [state, setState] = useState<MediaState>("loading");
  useEffect(() => {
    setState("loading");
  }, [retryKey, href]);

  if (state === "failed") {
    return <ThumbFailure unavailableReason={unavailableReason} onRetry={onRetry} onReset={() => setState("loading")} />;
  }

  return (
    <span className="node-history__thumb-media" data-state={state}>
      {state === "loading" ? <span className="node-history__thumb-loading" aria-hidden="true" /> : null}
      <video
        className="node-history__thumb-video"
        src={`${href}#t=0.1`}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={event => {
          const video = event.currentTarget;
          if (video.currentTime > 0) return;
          try {
            video.currentTime = Math.min(0.1, Number.isFinite(video.duration) ? video.duration : 0.1);
          } catch {
            // 元数据暂不可定位时保留浏览器默认首帧。
          }
        }}
        onLoadedData={() => setState("ready")}
        onSeeked={() => setState("ready")}
        onError={() => setState("failed")}
      />
    </span>
  );
}

function ThumbFailure({ unavailableReason, onRetry, onReset }: { unavailableReason?: string; onRetry?: () => void; onReset: () => void }) {
  return (
    <span className="node-history__thumb-failed" role="alert" data-state="failed">
      <span className="node-history__thumb-failed-text">
        {unavailableReason ?? "暂时无法加载预览"}
      </span>
      <button
        type="button"
        className="node-history__thumb-retry"
        onClick={() => {
          onReset();
          onRetry?.();
        }}
      >
        重试
      </button>
    </span>
  );
}

/** Full video playback is explicit and is released when the workspace hides or changes selection. */
function HistoryVideo({ href, poster }: { href: string; poster: string | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const element = video.current;
    element?.setAttribute("src", href);
    element?.load();
    return () => { element?.pause(); element?.removeAttribute("src"); element?.load(); };
  }, [href, attempt, failed]);
  return failed ? <span className="node-history__thumb-failed">暂时无法加载视频预览<Button onClick={() => { setFailed(false); retry(value => value + 1); }}>重试</Button></span> : <video ref={video} src={href} poster={poster ?? undefined} controls playsInline preload="metadata" onError={() => setFailed(true)} />;
}
