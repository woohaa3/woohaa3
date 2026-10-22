import { useState } from "react";
import { isValidStorageKey } from "@woohaa3/contracts";
import { resolvePublicUrl } from "@woohaa3/frontend/extension-api";
import type { GameResource } from "../shared.js";

/** 只展示复制快照及稳定本站媒体地址，不执行模型/opaque 原件，不自动播放。 */
export function ResourcePreview({ resource }: { resource: GameResource }) {
  const [failed, setFailed] = useState(false);
  const key = resource.metadata?.storageKey;
  const url = isValidStorageKey(key) ? resolvePublicUrl(`/api/media/${key}`) : null;
  if (resource.kind === "text") {
    const text = resource.payload.snapshot?.text;
    return typeof text === "string" ? <pre>{text.slice(0, 1500)}{text.length > 1500 ? "\n（文本预览节选）" : ""}</pre> : <p>完整文本保留在原件中</p>;
  }
  if (resource.kind === "model" || resource.kind === "film-set") return <details>
    <summary>{resource.kind === "model" ? "模型参考快照" : "导演场参考快照"}</summary>
    <p>保留完整模型定义；作为生成参考素材。</p>
  </details>;
  if (!url || failed) return <p>{resource.kind === "unknown" ? "已保留原件，暂无可用预览" : "暂无可用预览"}</p>;
  if (resource.kind === "image") return <img src={url} loading="lazy" alt={resource.name} onError={() => setFailed(true)} />;
  if (resource.kind === "video") return <video src={url} controls preload="none" playsInline onError={() => setFailed(true)} />;
  if (resource.kind === "audio") return <audio src={url} controls preload="none" onError={() => setFailed(true)} />;
  return <p>已保留原件，暂无可用预览</p>;
}
