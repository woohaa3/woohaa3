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
  FILM_SET_SHOT_PREVIEW_NODE_TYPE,
  managedShotPreviewOwnershipOf,
  readFilmSetGroupMarker,
  filmSetAnimationsOf,
  readShotReferenceAssetLink,
  readShotImageReferenceAssetLink, SHOT_IMAGE_REFERENCE_ROLE, shotImageReferenceIdentity, readyShotImageAsset,
  shotImageMappingsMatch, shotImageReferenceAssetId, type FrozenShotImageReference,
  shotPreviewOwnershipOf,
  type CanvasNodeData,
  type CanvasNodeInputMapping,
  type ServerCanvas,
  type ShotReferenceAssetLink,
  type ShotPreviewOwnership,
  type StoredAsset
} from "@woohaa3/contracts";

function clipForOwner(nodeData: CanvasNodeData | undefined, clipId: string): { kind: "static" | "dynamic" } | null {
  const group = readFilmSetGroupMarker(nodeData);
  if (group) {
    const clip = group.clips?.find(entry => entry.id === clipId);
    return clip ? { kind: (clip.duration && clip.duration > 0) ? "dynamic" : "static" } : null;
  }
  const decoded = decodeFilmSetNodeData(nodeData);
  if (!decoded.ok) return null;
  const clip = filmSetAnimationsOf(decoded.value).clips.find(entry => entry.id === clipId);
  return clip ? { kind: clip.kind } : null;
}

/** 镜头参考在 Provider 侧的角色（视频参考）。 */
export const SHOT_REFERENCE_REFERENCE_ROLE = "reference_video";

export type ShotReferenceResolution =
  | { ok: true; asset: StoredAsset; link: ShotReferenceAssetLink }
  | { ok: false; waiting: boolean; reason: string };

/** 读取资产 metadata 中的镜头版本；缺失或非法返回 `null`。 */
export const readShotReferenceLink = (asset: StoredAsset | undefined): ShotReferenceAssetLink | null =>
  readShotReferenceAssetLink(asset?.metadata);

/**
 * 读取来源节点的镜头归属。
 *
 * 片场组迁移后，镜头卡片不再是 `film-set-shot-preview`，而是片场组拥有的 owner-managed
 * image/video 媒体节点；归属由 `managedBy` 与 `mediaContent` 互相印证（`managedShotPreviewOwnershipOf`）。
 * 旧画布仍保留 `shotPreview` 形态。两种形态之外的节点一律视为非镜头参考来源。
 */
function shotReferenceSourceOf(input: {
  canvas: ServerCanvas;
  nodeData: Record<string, CanvasNodeData | undefined>;
  sourceNodeId: string;
}): { ownership: ShotPreviewOwnership; managed: boolean; nodeType: string } | null {
  const node = input.canvas.document.nodes.find((entry) => entry.id === input.sourceNodeId);
  if (!node) return null;
  const legacy = shotPreviewOwnershipOf(input.nodeData[input.sourceNodeId]);
  if (legacy) return node.type === FILM_SET_SHOT_PREVIEW_NODE_TYPE ? { ownership: legacy, managed: false, nodeType: node.type } : null;
  const managed = managedShotPreviewOwnershipOf(input.nodeData[input.sourceNodeId]);
  return managed && (node.type === "image" || node.type === "video") ? { ownership: managed, managed: true, nodeType: node.type } : null;
}

/**
 * 校验来源镜头归属：来源节点必须属于一个**仍在本画布**的片场，且其镜头仍存在。
 * 归属不成立时明确失败，绝不猜时长或改版本。
 */
export function verifyShotReferenceOwnership(input: {
  canvas: ServerCanvas;
  nodeData: Record<string, CanvasNodeData | undefined>;
  sourceNodeId: string;
}): { ok: true; filmSetNodeId: string; clipId: string } | { ok: false; reason: string } {
  const source = shotReferenceSourceOf(input);
  if (!source) {
    return { ok: false, reason: `镜头参考来源 ${input.sourceNodeId} 不是拍摄镜头预览节点` };
  }
  const ownership = source.ownership;
  const filmSetNode = input.canvas.document.nodes.find((node) => node.id === ownership.filmSetNodeId);
  if (!filmSetNode) {
    return { ok: false, reason: `镜头参考所属片场 ${ownership.filmSetNodeId} 不在当前画布中` };
  }
  const clip = clipForOwner(input.nodeData[ownership.filmSetNodeId], ownership.clipId);
  if (!clip) {
    return { ok: false, reason: `镜头参考的镜头 ${ownership.clipId} 已不存在` };
  }
  if (source.managed && source.nodeType !== (clip.kind === "dynamic" ? "video" : "image")) {
    return { ok: false, reason: `镜头参考来源 ${input.sourceNodeId} 与镜头类型不一致` };
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
  frozen?: FrozenShotImageReference;
}): ShotReferenceResolution {
  const ownership = verifyShotReferenceOwnership({ canvas: input.canvas, nodeData: input.nodeData, sourceNodeId: input.mapping.sourceNodeId });
  if (!ownership.ok) return { ok: false, waiting: false, reason: ownership.reason };

  const assetIds = (input.mapping.sourceAssetIds ?? []).filter((id): id is string => typeof id === "string" && id !== "");
  if (!assetIds.length) {
    return { ok: false, waiting: true, reason: input.mapping.role === SHOT_IMAGE_REFERENCE_ROLE ? "等待镜头参考图片准备完成" : `等待镜头参考「${ownership.filmSetNodeId}/${ownership.clipId}」录制完成` };
  }
  if (input.mapping.role === SHOT_IMAGE_REFERENCE_ROLE) {
    const asset = input.canvas.assets.find(asset => asset.id === assetIds[0]);
    const link = readShotImageReferenceAssetLink(asset?.metadata);
    const clip = clipForOwner(input.nodeData[ownership.filmSetNodeId], ownership.clipId);
    if (!link || !asset || !clip || link.filmSetNodeId !== ownership.filmSetNodeId || link.clipId !== ownership.clipId
      || clip.kind !== "static"
      || readyShotImageAsset(input.canvas.assets, link)?.id !== asset.id) return { ok: false, waiting: false, reason: "shot-image-unavailable: 图片参考资产或归属无效" };
    const decoded = decodeFilmSetNodeData(input.nodeData[ownership.filmSetNodeId]);
    // Group captures already carry their frozen provider identity; legacy composites
    // continue to derive it from the animation payload for compatibility.
    const identity = readFilmSetGroupMarker(input.nodeData[ownership.filmSetNodeId])
      ? { contentIdentity: link.contentIdentity, profileKey: link.profileKey }
      : (decoded.ok ? shotImageReferenceIdentity({ animation: decoded.value, clipId: link.clipId, background: String(asset.metadata?.background), assets: input.canvas.assets }) : null);
    const frozen = input.frozen;
    if (frozen ? frozen.contentIdentity !== link.contentIdentity || frozen.profileKey !== link.profileKey
      : !identity || identity.contentIdentity !== link.contentIdentity || identity.profileKey !== link.profileKey) return { ok: false, waiting: false, reason: "shot-image-version-stale: 图片参考版本已失效，请重新执行" };
    return { ok: true, asset, link };
  }
  return resolveAsset(input.canvas, assetIds, ownership.filmSetNodeId, ownership.clipId);
}

/** Apply only validated frozen slots to an execution snapshot; never write stale mappings to the document. */
export function withFrozenShotImages(canvas: ServerCanvas, nodeId: string, frozen: FrozenShotImageReference[]): ServerCanvas | string {
  if (!shotImageMappingsMatch(canvas, nodeId, frozen)) return "图片参考输入连接已变化，请重新执行";
  const data = canvas.nodeData[nodeId];
  for (const ref of frozen) {
    const ownership = verifyShotReferenceOwnership({ canvas, nodeData: canvas.nodeData, sourceNodeId: ref.sourceNodeId });
    const asset = readyShotImageAsset(canvas.assets, ref);
    const link = readShotImageReferenceAssetLink(asset?.metadata);
    const clip = ownership.ok ? clipForOwner(canvas.nodeData[ownership.filmSetNodeId], ref.clipId) : null;
    if (!ownership.ok || ownership.filmSetNodeId !== ref.filmSetNodeId || ownership.clipId !== ref.clipId || !asset || !link
      || !clip || clip.kind !== "static"
      || link.contentIdentity !== ref.contentIdentity || link.profileKey !== ref.profileKey) return "shot-image-unavailable: 冻结的图片参考不可用";
  }
  return { ...canvas, nodeData: { ...canvas.nodeData, [nodeId]: { ...data, inputMapping: (data?.inputMapping ?? []).map(mapping => {
    const ref = frozen.find(ref => ref.slotId === mapping.slotId && ref.sourceNodeId === mapping.sourceNodeId);
    return ref ? { ...mapping, sourceAssetIds: [shotImageReferenceAssetId(ref)] } : mapping;
  }) } } } as ServerCanvas;
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
