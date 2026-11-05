import { createHash } from "node:crypto";
import { readWorldCaptureImageDimensions, type FrozenImageDirectorSource } from "@woohaa3/contracts";
import type { CanvasMediaClient } from "../clients/media-client.js";
import type { CanvasRoom } from "../sync/room.js";

export async function prepareImageDirectorSource(input: { owner: string; canvasId: string; sourceNodeId: string }, deps: { authorize(owner: string, canvasId: string, permission: "read" | "write"): Promise<boolean>; resolveRoom(canvasId: string): Promise<CanvasRoom | null>; media: CanvasMediaClient }): Promise<{ source: FrozenImageDirectorSource; bytes: Uint8Array }> {
  if (!await deps.authorize(input.owner, input.canvasId, "write") || !await deps.authorize(input.owner, input.canvasId, "read")) throw new Error("当前用户无画布读写权限");
  const room = await deps.resolveRoom(input.canvasId);
  const snapshot = room?.exportCanvas();
  if (!snapshot?.ok) throw new Error("画布不可用");
  const canvas = snapshot.canvas;
  if (!canvas.document.nodes.some(node => node.id === input.sourceNodeId && node.type === "image")) throw new Error("来源图片不存在");
  const assetId = canvas.nodeData[input.sourceNodeId]?.outputAssetId;
  const asset = canvas.assets.find(item => item.id === assetId);
  const storageKey = asset?.metadata?.storageKey;
  if (!asset || asset.status !== "ready" || asset.mediaKind !== "image" || typeof storageKey !== "string" || !storageKey || !deps.media.read) throw new Error("来源图片尚未就绪");
  const verified = await deps.media.verify(storageKey, asset.metadata, { canvasId: input.canvasId });
  if (!verified.exists || !verified.matches) throw new Error("来源图片不可读取或已变化");
  const image = await deps.media.read(storageKey, input.canvasId);
  const mimeType = image.contentType.split(";")[0]!.trim().toLowerCase();
  const declaredType = asset.metadata?.contentType;
  const dimensions = readWorldCaptureImageDimensions(image.bytes, mimeType);
  const checksum = createHash("sha256").update(image.bytes).digest("hex");
  const expectedChecksum = asset.metadata?.checksum ?? verified.metadata?.checksum;
  if (!dimensions || (typeof declaredType === "string" && declaredType.split(";")[0]!.trim().toLowerCase() !== mimeType) || (typeof expectedChecksum === "string" && expectedChecksum !== checksum) || (typeof asset.metadata?.size === "number" && asset.metadata.size !== image.bytes.length)) throw new Error("来源图片字节校验失败");
  return { source: { sourceNodeId: input.sourceNodeId, assetId: asset.id, contentVersion: checksum, checksum, mimeType, ...dimensions }, bytes: image.bytes };
}
