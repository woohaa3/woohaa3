/**
 * 片段素材候选与预览恢复
 * （change: add-prompt-snippet-library，任务 3.3/3.4 / design D4）。
 *
 * 当前画布 ready 图片/视频/音频/文本资产作为编辑器候选；素材快照只保存稳定身份，
 * 预览先匹配当前 canonical 画布，找不到时经 `canvasRemote` resolver + `mediaRemote`
 * 解析同源 URL。Plugin 不拼 Media path，也不接受任意外部/签名 URL。
 */
import type { ServerCanvas, StoredAsset } from "@woohaa3/contracts";
import type { CanvasRemoteService, MediaRemoteService } from "@woohaa3/frontend/extension-api";
import type { PromptSnippetMaterial } from "@woohaa3/contracts";

export type MaterialCandidate = {
  /** 编辑器 mention 使用的局部 key（同时也是候选身份）。 */
  key: string;
  label: string;
  mediaKind: "image" | "video" | "audio" | "text";
  material: PromptSnippetMaterial;
};

function readStorageKey(asset: StoredAsset): string | null {
  const key = asset.metadata?.storageKey;
  return typeof key === "string" && key !== "" ? key : null;
}

/** 从当前 canonical 画布 ready 资产构造素材候选。 */
export function collectMaterialCandidates(canvas: ServerCanvas | null): MaterialCandidate[] {
  if (!canvas) return [];
  const candidates: MaterialCandidate[] = [];
  let ordinal = 0;
  for (const asset of canvas.assets) {
    if (asset.status !== "ready") continue;
    const mediaKind = asset.mediaKind;
    if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio" && mediaKind !== "text") continue;
    ordinal += 1;
    const key = `material-${ordinal}`;
    const label = asset.title || asset.id;
    if (mediaKind === "text") {
      candidates.push({
        key,
        label,
        mediaKind,
        material: { key, mediaKind, assetId: asset.id, label, text: asset.text ?? "" }
      });
      continue;
    }
    const storageKey = readStorageKey(asset);
    const checksum = asset.metadata?.checksum;
    const contentType = asset.metadata?.contentType;
    const size = asset.metadata?.size;
    if (!storageKey || typeof checksum !== "string" || typeof contentType !== "string" || typeof size !== "number") {
      continue;
    }
    candidates.push({
      key,
      label,
      mediaKind,
      material: { key, mediaKind, assetId: asset.id, storageKey, checksum, contentType, size, label }
    });
  }
  return candidates;
}

export type MaterialPreviewStatus = "loading" | "ready" | "failed" | "unavailable";

export type MaterialPreview = {
  status: MaterialPreviewStatus;
  url: string | null;
};

/**
 * 解析素材预览：先匹配当前 canonical 画布资产；找不到时经 Canvas Remote resolver 确认
 * 稳定键后，再由 Media Remote 构造同源 URL。不返回任意外部/签名 URL。
 */
export async function resolveMaterialPreview(input: {
  material: PromptSnippetMaterial;
  canvas: ServerCanvas | null;
  remote: CanvasRemoteService;
  mediaRemote: MediaRemoteService;
}): Promise<MaterialPreview> {
  const { material, canvas, remote, mediaRemote } = input;
  if (material.mediaKind === "text") return { status: "ready", url: null };
  const inCanvas = canvas?.assets.find((asset) => asset.id === material.assetId);
  if (inCanvas) {
    // 预览属于当前画布资产：带上画布提示，远端画布才会从托管存储取字节。
    const resolved = mediaRemote.resolveCanonicalUrl(inCanvas, canvas?.id);
    return resolved ? { status: "ready", url: resolved } : { status: "failed", url: null };
  }
  const result = await remote.resolveSnippetMaterial(material.storageKey);
  if (!result.ok) {
    return { status: result.code === "unauthorized" ? "unavailable" : "failed", url: null };
  }
  if (!result.value.resolvable) return { status: "unavailable", url: null };
  // 片段素材来自画布资产：同样带画布提示，远端画布才取得到字节。
  const url = mediaRemote.urlFor(material.storageKey, canvas?.id);
  return mediaRemote.isAllowedUrl(url) ? { status: "ready", url } : { status: "failed", url: null };
}
