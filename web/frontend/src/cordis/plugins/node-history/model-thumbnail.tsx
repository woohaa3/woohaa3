import { useEffect, useState } from "react";
import type { NodeHistoryPreviewEntry } from "@woohaa3/contracts";
import type { ModelThumbnailRender } from "./model-thumbnail-render.js";

type Failure = { message: string; retry: boolean };
/** Safe messages: renderer stderr and host paths never become user-facing copy. */
export function thumbnailFailure(code: string): Failure {
  if (code === "no-source") return { message: "该历史版本没有模型内容，请选择有内容的版本", retry: false };
  if (["not-a-model-entry", "invalid-history-definition", "unsupported-model-version"].includes(code) || code.startsWith("model-script-"))
    return { message: "该版本的内容无法生成预览，请检查模型定义或选择其他版本", retry: false };
  if (code === "renderer-unavailable") return { message: "页面渲染尚未就绪（画布未挂载或当前浏览器不支持 WebGPU），请稍后重试", retry: true };
  if (code === "thumbnail-busy") return { message: "预览渲染繁忙，请稍后重试", retry: true };
  if (code === "thumbnail-poll-timeout" || code === "thumbnail-readiness-timeout" || code === "thumbnail-readback-timeout")
    return { message: "预览渲染超时，请稍后重试", retry: true };
  if (code === "detail-unavailable" || code === "unauthenticated" || code === "forbidden")
    return { message: "当前无法读取该版本内容，请检查权限后重试", retry: true };
  return { message: "该版本渲染失败，请稍后重试；历史列表与恢复仍可使用", retry: true };
}

/**
 * 模型历史缩略图：向页面内渲染器要一张图
 * （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
 *
 * 只显示本次请求自己的 PNG；切换选择、卸载或重试时释放上一张 object URL，
 * 并忽略迟到结果。渲染器不可用/渲染失败都落到可重试失败态，没有服务端备用路径。
 */
export function ModelThumbnail({ entry, render, retryKey, onRetry, thumbnail, unavailableReason }: {
  entry: NodeHistoryPreviewEntry;
  render: (entry: NodeHistoryPreviewEntry) => Promise<ModelThumbnailRender>;
  retryKey?: number;
  onRetry?: () => void;
  thumbnail: boolean;
  unavailableReason?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null); setFailure(null);
    void (async () => {
      try {
        const result = await render(entry);
        if (cancelled) return;
        if (!result.ok) { setFailure(thumbnailFailure(result.code)); return; }
        if (!result.blob.size || result.blob.type !== "image/png") { setFailure(thumbnailFailure("thumbnail-render-failed")); return; }
        objectUrl = URL.createObjectURL(result.blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailure(thumbnailFailure("thumbnail-render-failed"));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [entry.canvasId, entry.nodeId, entry.entryId, render, retryKey, attempt]);
  return failure ? <span className="node-history__thumb-failed" role="alert" data-state="failed">
    <span className="node-history__thumb-failed-text">{unavailableReason ?? failure.message}</span>
    {failure.retry ? <button type="button" className="node-history__thumb-retry" onClick={() => { if (onRetry) onRetry(); else setAttempt(value => value + 1); }}>重试</button> : null}
  </span> : <span className="node-history__thumb-media" data-state={url ? "ready" : "loading"}>
    {url ? <img src={url} alt="" data-thumbnail={thumbnail ? "true" : "false"} onError={() => setFailure(thumbnailFailure("thumbnail-render-failed"))} /> : <span className="node-history__thumb-loading" />}
  </span>;
}
