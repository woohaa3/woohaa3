/** Film-set interpretation belongs to the extension; the host only resolves stable assets and decodes textures. */
import { decodeFilmSetNodeData, filmSetAnimationsOf, type CanvasNodeData, type BevyAnimationPlayback, type FilmSetNodeDataDecodeResult } from "@woohaa3/contracts";
import type { CompositeAssetMediaSource } from "@woohaa3/frontend/extension-api";

/**
 * 按 `nodeData` 对象身份缓存片场解码结果
 * （change: 2026-10-13-optimize-composite-asset-media-decode）。
 *
 * 规范 `nodeData` 不可变：内容变化一律表现为**替换对象**（reducer/working-projection 均以浅拷贝
 * 或新对象表达），所以以对象本身为键的 `WeakMap` 在拖动等连续帧之间命中稳定内容，又在对象被替换、
 * 节点删除或切画布后自动失效——无需手动清理，也不会跨节点/跨画布串味。成功与失败都缓存：不可读
 * 内容在内容不变时不重复产生额外失败，内容变化即重新评估；整包预算序列化也随结果一并复用。
 */
const decodedNodeData = new WeakMap<object, FilmSetNodeDataDecodeResult>();

function decodeFilmSetNodeDataOnce(data: CanvasNodeData): FilmSetNodeDataDecodeResult {
  const cached = decodedNodeData.get(data);
  if (cached) return cached;
  const decoded = decodeFilmSetNodeData(data);
  decodedNodeData.set(data, decoded);
  return decoded;
}

export function filmSetMediaSources(nodeId: string, data: CanvasNodeData, playback: BevyAnimationPlayback | null): CompositeAssetMediaSource[] {
  const decoded = decodeFilmSetNodeDataOnce(data);
  if (!decoded.ok) return [];
  const collection = filmSetAnimationsOf(decoded.value);
  const active = playback?.nodeId === nodeId ? playback : null;
  const clip = active ? collection.clips.find(clip => clip.id === (active.clipId ?? collection.defaultClipId)) : null;
  return decoded.value.filmSetContent.items.flatMap(item => item.kind === "image" || item.kind === "video" ? [{
    planeId: `${nodeId}::${item.id}`, nodeId, assetId: item.assetId, kind: item.kind,
    playback: clip?.bindings.find(binding => binding.itemId === item.id)?.playback,
    sourceIdentity: active ? `${active.clipId}:${active.sourceIdentity}:${active.generation}` : "editing"
  }] : []);
}
