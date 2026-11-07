/**
 * 画布节点横条上的「独立编辑」入口:判断哪些图片节点能编辑,并取出窗口要用的图。
 *
 * 判定与宿主默认图片查看器一致(`resolveImageFocusTarget`):节点是 `image`、自身输出资产已就绪、
 * 有受控的同源地址。那个函数在宿主内部,扩展不能 import,所以这里照同样的条件写一份只读判断。
 */
import type { CanvasStoreFacade, MediaRemoteService } from "@woohaa3/frontend/extension-api";

export interface EditableImage {
  title: string;
  /** 原图的同源显示地址 */
  imageUrl: string;
}

export function editableImageOf(
  store: CanvasStoreFacade | undefined,
  media: MediaRemoteService | undefined,
  nodeId: string
): EditableImage | null {
  const canvas = store?.getCanvas();
  if (!canvas || !media) return null;
  const node = canvas.document.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== "image") return null;
  const data = canvas.nodeData[nodeId] as { outputAssetId?: unknown; title?: unknown } | undefined;
  const assetId = typeof data?.outputAssetId === "string" ? data.outputAssetId : "";
  if (!assetId) return null;
  const asset = canvas.assets.find((a) => a.id === assetId);
  if (!asset || asset.status !== "ready" || asset.mediaKind !== "image") return null;
  // 与宿主一致:路径回溯一律拒绝
  if (typeof asset.url === "string" && asset.url.includes("..")) return null;
  const imageUrl = media.resolveCanonicalUrl(asset, canvas.id);
  if (!imageUrl) return null;
  const title = typeof data?.title === "string" && data.title.trim() !== "" ? data.title.trim() : "图片";
  return { title, imageUrl };
}
