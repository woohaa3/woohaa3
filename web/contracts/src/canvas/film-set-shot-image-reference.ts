import { fnv1a64Hex } from "./content-hash.js";
import { resolveFilmSetClip } from "./film-set-clip-view.js";
import { shotAspectValue } from "./film-set-shot-preview.js";
import { filmSetExportVideoSize } from "./film-set-export-profile.js";
import type { FilmSetNodeData } from "./canvas-node-model.js";
import type { StoredAsset } from "./domain/index.js";
import type { ShotReferenceAssetLink } from "./film-set-shot-reference.js";
import { shotReferenceOwnershipOf } from "./film-set-shot-reference.js";
import { decodeFilmSetNodeData } from "./canvas-node-model.js";
import type { ServerCanvas } from "./domain/index.js";
import { SHOT_IMAGE_REFERENCE_ROLE } from "./domain/core/shot-reference.js";

export type FrozenShotImageReference = ShotReferenceAssetLink & { slotId: string; sourceNodeId: string; background: string };

/** Freeze image inputs at click time, independently of the later cache/mapping update. */
export function freezeShotImageReferences(canvas: ServerCanvas, nodeId: string, themeBackground: string): FrozenShotImageReference[] | string {
  const frozen: FrozenShotImageReference[] = [];
  for (const mapping of canvas.nodeData[nodeId]?.inputMapping ?? []) {
    if (mapping.role !== SHOT_IMAGE_REFERENCE_ROLE) continue;
    const ownership = shotReferenceOwnershipOf(canvas.nodeData[mapping.sourceNodeId]);
    if (!ownership || !mapping.slotId) return "shot-image-unavailable: 图片参考来源无效";
    const decoded = decodeFilmSetNodeData(canvas.nodeData[ownership.filmSetNodeId]);
    if (!decoded.ok) return "shot-image-unavailable: 片场无法解析";
    const clip = resolveFilmSetClip(decoded.value, ownership.clipId)?.clip;
    const background = clip?.backdrop && clip.backdrop !== "theme" ? clip.backdrop : themeBackground;
    const identity = shotImageReferenceIdentity({ animation: decoded.value, clipId: ownership.clipId, background, assets: canvas.assets });
    if (!identity) return "shot-image-version-stale: 静态镜头已变化，请重新执行";
    frozen.push({ ...ownership, ...identity, sourceNodeId: mapping.sourceNodeId, slotId: mapping.slotId, background });
  }
  return frozen;
}

export function shotImageMappingsMatch(canvas: ServerCanvas, nodeId: string, frozen: readonly FrozenShotImageReference[]): boolean {
  const mappings = (canvas.nodeData[nodeId]?.inputMapping ?? []).filter(mapping => mapping.role === SHOT_IMAGE_REFERENCE_ROLE);
  const slots = new Set(frozen.map(ref => ref.slotId));
  return slots.size === frozen.length && mappings.length === frozen.length
    && frozen.every(ref => mappings.some(mapping => mapping.slotId === ref.slotId && mapping.sourceNodeId === ref.sourceNodeId));
}

export const SHOT_IMAGE_REFERENCE_METADATA_KEY = "shotImageReference";
export const SHOT_IMAGE_REFERENCE_ERRORS = {
  unsupported: "shot-kind-unsupported", stale: "shot-image-version-stale",
  unavailable: "shot-image-unavailable", permission: "shot-image-permission-denied"
} as const;

/** Explicit dimensions and renderer/color semantics keep PNG and video versions separate. */
export function shotImageReferenceProfile(aspect: number) {
  const size = filmSetExportVideoSize(aspect >= 1 ? `${aspect}:1` : `1:${1 / aspect}`);
  return { ...size, profileKey: `image-v1-${size.width}x${size.height}-shot-camera-high-srgb-r3` };
}

export function shotImageReferenceIdentity(input: {
  animation: FilmSetNodeData; clipId: string; background: string; assets: readonly StoredAsset[];
}): { contentIdentity: string; profileKey: string; width: number; height: number } | null {
  const view = resolveFilmSetClip(input.animation, input.clipId);
  if (!view || view.clip.kind !== "static" || !/^#[0-9a-f]{6}$/i.test(input.background)) return null;
  const profile = shotImageReferenceProfile(shotAspectValue(view.clip));
  const items = view.content.items.map(item => {
    const fields = [item.id, item.kind, item.localTransform, item.kind === "model"
      ? [item.model.modelScript, item.model.modelScriptLanguage, item.model.modelScriptVersion, item.model.placement]
      : item.kind === "ground" ? [item.size, item.color] : [item.assetId, item.aspectRatio]];
    const asset = "assetId" in item ? input.assets.find(asset => asset.id === item.assetId) : undefined;
    return [fields, asset ? [asset.id, asset.metadata?.storageKey, asset.metadata?.checksum, asset.metadata?.contentType] : null];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { ...profile, contentIdentity: fnv1a64Hex(JSON.stringify([
    "shot-image-v1", "static", view.initialCamera, input.background.toLowerCase(), input.animation.scenePlacement, items, profile
  ])) };
}

export function shotImageReferenceAssetId(link: ShotReferenceAssetLink): string {
  return `shot-reference-image:${link.filmSetNodeId}:${link.clipId}:${link.contentIdentity}:${link.profileKey}`;
}

export function readShotImageReferenceAssetLink(metadata: unknown): ShotReferenceAssetLink | null {
  const raw = (metadata as Record<string, unknown> | null)?.[SHOT_IMAGE_REFERENCE_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const link = raw as ShotReferenceAssetLink;
  return [link.filmSetNodeId, link.clipId, link.contentIdentity, link.profileKey].every(value => typeof value === "string" && !!value)
    ? link : null;
}

export function readyShotImageAsset(assets: readonly StoredAsset[], link: ShotReferenceAssetLink): StoredAsset | null {
  const id = shotImageReferenceAssetId(link);
  return assets.find(asset => {
    const metadata = asset.metadata, saved = readShotImageReferenceAssetLink(metadata);
    const profile = /^image-v1-(\d+)x(\d+)-shot-camera-high-srgb-r3$/.exec(link.profileKey);
    return asset.id === id && asset.status === "ready" && asset.mediaKind === "image"
      && saved?.filmSetNodeId === link.filmSetNodeId && saved.clipId === link.clipId
      && saved.contentIdentity === link.contentIdentity && saved.profileKey === link.profileKey
      && metadata?.contentType === "image/png" && typeof metadata.storageKey === "string" && !!metadata.storageKey
      && !/^(blob:|data:|https?:)/i.test(metadata.storageKey)
      && /^[a-f0-9]{64}$/i.test(String(metadata.checksum)) && profile
      && metadata.width === Number(profile[1]) && metadata.height === Number(profile[2]);
  }) ?? null;
}
