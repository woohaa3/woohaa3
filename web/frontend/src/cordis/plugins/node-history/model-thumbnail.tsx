import { useEffect, useState } from "react";
import { isAllowedNodeHistoryPreviewUrl } from "../../services/media-remote.js";

type Failure = { message: string; retry: boolean };
/** Safe messages: renderer stderr and host paths never become user-facing copy. */
export function thumbnailFailure(code: string): Failure {
  if (code === "no-source") return { message: "该历史版本没有模型内容，请选择有内容的版本", retry: false };
  if (["not-a-model-entry", "invalid-history-definition"].includes(code) || code.startsWith("model-script-"))
    return { message: "该版本的内容无法生成预览，请检查模型定义或选择其他版本", retry: false };
  if (code === "composite-history-unavailable") return { message: "复合模型预览适配尚未就绪，请检查本机宿主依赖后重试", retry: true };
  if (code === "renderer-unavailable") return { message: "原生预览依赖未就绪，请构建 model-renderer 并重启本机宿主后重试", retry: true };
  if (code === "renderer-start-failed") return { message: "原生预览进程无法启动，请检查可执行文件与运行依赖，重启本机宿主后重试", retry: true };
  if (code === "render-timeout" || code === "render-busy") return { message: "预览暂时繁忙或超时，请稍后重试", retry: true };
  if (code === "unauthenticated" || code === "forbidden") return { message: "当前没有读取该预览的权限，请检查登录状态后重试", retry: true };
  return { message: "该版本渲染失败，请检查模型内容后重试；历史列表与恢复仍可使用", retry: true };
}

/** Fetch structured errors, then display only this request's PNG. Cleanup cancels old selections. */
export function ModelThumbnail({ href, retryKey, onRetry, thumbnail, unavailableReason }: {
  href: string; retryKey?: number; onRetry?: () => void; thumbnail: boolean; unavailableReason?: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null); setFailure(null);
    void (async () => {
      try {
        if (!isAllowedNodeHistoryPreviewUrl(href)) { setFailure(thumbnailFailure("invalid-history-definition")); return; }
        const response = await fetch(href, { credentials: "same-origin", signal: controller.signal, cache: "no-cache" });
        if (controller.signal.aborted) return;
        if (!response.ok) {
          const error = await response.json().catch(() => ({})) as { code?: string };
          if (!controller.signal.aborted) setFailure(thumbnailFailure(error.code ?? "render-failed"));
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (blob.type !== "image/png" || !blob.size) { setFailure(thumbnailFailure("render-failed")); return; }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!controller.signal.aborted) setFailure(thumbnailFailure("render-failed"));
      }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [href, retryKey, attempt]);
  return failure ? <span className="node-history__thumb-failed" role="alert" data-state="failed">
    <span className="node-history__thumb-failed-text">{unavailableReason ?? failure.message}</span>
    {failure.retry ? <button type="button" className="node-history__thumb-retry" onClick={() => { if (onRetry) onRetry(); else setAttempt(value => value + 1); }}>重试</button> : null}
  </span> : <span className="node-history__thumb-media" data-state={url ? "ready" : "loading"}>
    {url ? <img src={url} alt="" data-thumbnail={thumbnail ? "true" : "false"} onError={() => setFailure(thumbnailFailure("render-failed"))} /> : <span className="node-history__thumb-loading" />}
  </span>;
}
