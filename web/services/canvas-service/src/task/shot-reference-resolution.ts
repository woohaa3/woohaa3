/**
 * 镜头参考输入的服务端解析与校验（任务 8.6 / 8.7 / design D9）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 下游执行准备阶段，服务端从**权威画布**解析 `shot_reference` 映射：确认来源预览的片场/镜头
 * 归属仍成立，取到被冻结版本对应的**真实视频资产**，并转成 Provider 能识别的 `reference_video`。
 *
 * 权威归属：映射本身只保存来源预览引用；下游提交前由客户端把已录制版本的资产写入
 * `inputMapping[].sourceAssetIds` 并在 `canvas.assets` 登记，资产的 `metadata.shotReference`
 * 记录其对应的镜头版本。服务端据此校验归属、版本与真实视频资产；不把预览 ID、纹理句柄或临时
 * URL 当媒体，也不在没有就绪资产时偷偷降级。
 *
 * 纯函数：只读 plain 画布结构，不 import DOM/网络。
 */
import {
  decodeFilmSetNodeData,
  filmSetAnimationsOf,
  readShotReferenceAssetLink,
  shotPreviewOwnershipOf,
  type CanvasNodeData,
  type CanvasNodeInputMapping,
  type ServerCanvas,
  type ShotReferenceAssetLink,
  type StoredAsset
} from "@woohaa3/contracts";

/** 镜头参考在 Provider 侧的角色（视频参考）。 */
export const SHOT_REFERENCE_REFERENCE_ROLE = "reference_video";

export type ShotReferenceResolution =
  | { ok: true; asset: StoredAsset; link: ShotReferenceAssetLink }
  | { ok: false; waiting: boolean; reason: string };

/** 读取资产 metadata 中的镜头版本；缺失或非法返回 `null`。 */
export const readShotReferenceLink = (asset: StoredAsset | undefined): ShotReferenceAssetLink | null =>
  readShotReferenceAssetLink(asset?.metadata);

/**
 * 校验来源预览归属：预览节点必须属于一个**仍在本画布**的片场，且其镜头仍存在。
 * 归属不成立时明确失败，绝不猜时长或改版本。
 */
export function verifyShotReferenceOwnership(input: {
  canvas: ServerCanvas;
  nodeData: Record<string, CanvasNodeData | undefined>;
  sourceNodeId: string;
}): { ok: true; filmSetNodeId: string; clipId: string } | { ok: false; reason: string } {
  const ownership = shotPreviewOwnershipOf(input.nodeData[input.sourceNodeId]);
  if (!ownership) {
    return { ok: false, reason: `镜头参考来源 ${input.sourceNodeId} 不是拍摄镜头预览节点` };
  }
  const filmSetNode = input.canvas.document.nodes.find((node) => node.id === ownership.filmSetNodeId);
  if (!filmSetNode) {
    return { ok: false, reason: `镜头参考所属片场 ${ownership.filmSetNodeId} 不在当前画布中` };
  }
  const decoded = decodeFilmSetNodeData(input.nodeData[ownership.filmSetNodeId]);
  if (!decoded.ok) {
    return { ok: false, reason: `镜头参考所属片场 ${ownership.filmSetNodeId} 无法解析` };
  }
  const clip = filmSetAnimationsOf(decoded.value).clips.find((entry) => entry.id === ownership.clipId);
  if (!clip) {
    return { ok: false, reason: `镜头参考的镜头 ${ownership.clipId} 已不存在` };
  }
  return { ok: true, filmSetNodeId: ownership.filmSetNodeId, clipId: ownership.clipId };
}

/**
 * 解析一条镜头参考映射到真实视频资产。
 *
 * - 尚未写入 `sourceAssetIds` 视为**等待录制**（`waiting: true`）；
 * - 资产缺失、未就绪、类型不是视频、缺少稳定 storageKey 或 metadata 版本与预览归属不一致时明确
 *   失败（`waiting: false`），不偷换版本或丢参考继续。
 */
export function resolveShotReferenceAsset(input: {
  canvas: ServerCanvas;
  nodeData: Record<string, CanvasNodeData | undefined>;
  mapping: CanvasNodeInputMapping;
}): ShotReferenceResolution {
  const ownership = verifyShotReferenceOwnership({ canvas: input.canvas, nodeData: input.nodeData, sourceNodeId: input.mapping.sourceNodeId });
  if (!ownership.ok) return { ok: false, waiting: false, reason: ownership.reason };

  const assetIds = (input.mapping.sourceAssetIds ?? []).filter((id): id is string => typeof id === "string" && id !== "");
  if (!assetIds.length) {
    return { ok: false, waiting: true, reason: `镜头参考「${ownership.filmSetNodeId}/${ownership.clipId}」尚未录制完成，等待中` };
  }
  return resolveAsset(input.canvas, assetIds, ownership.filmSetNodeId, ownership.clipId);
}

function resolveAsset(
  canvas: ServerCanvas,
  assetIds: string[],
  filmSetNodeId: string,
  clipId: string
): ShotReferenceResolution {
  let reason = `镜头参考「${filmSetNodeId}/${clipId}」没有可用的视频资产`;
  for (const assetId of assetIds) {
    const asset = canvas.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      reason = `镜头参考资产 ${assetId} 不在当前画布中`;
      continue;
    }
    if (asset.status !== "ready") {
      reason = `镜头参考资产「${asset.title || asset.id}」尚未就绪（${asset.status}）`;
      continue;
    }
    if (asset.mediaKind !== "video") {
      reason = `镜头参考资产「${asset.title || asset.id}」不是视频（${asset.mediaKind}）`;
      continue;
    }
    const storageKey = asset.metadata?.storageKey;
    if (typeof storageKey !== "string" || storageKey === "") {
      reason = `镜头参考资产「${asset.title || asset.id}」缺少稳定 storageKey`;
      continue;
    }
    const link = readShotReferenceLink(asset);
    if (!link) {
      reason = `镜头参考资产「${asset.title || asset.id}」没有版本信息`;
      continue;
    }
    if (link.filmSetNodeId !== filmSetNodeId || link.clipId !== clipId) {
      reason = `镜头参考资产「${asset.title || asset.id}」与预览归属不一致`;
      continue;
    }
    return { ok: true, asset, link };
  }
  return { ok: false, waiting: false, reason };
}
