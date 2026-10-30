import type { BevyCompositeAssetPresentation } from "./wire-scene.js";

export type OverviewCacheIdentityInput = {
  presentation: BevyCompositeAssetPresentation;
  /** Resource/signature identity of the model content, if a model exists. */
  resourceKey?: string;
  signature?: string;
  geometryRevision?: number;
  mediaRevision?: number;
  themeFingerprint?: string;
  projectionAspect?: number;
  tier: 128 | 256 | 512 | 1024 | 2048;
};

/** Stable FNV-1a identity for pixel-affecting input; absolute x/y is deliberately excluded. */
export function overviewCacheFingerprint(input: OverviewCacheIdentityInput): string {
  const asset = input.presentation;
  const canonical = JSON.stringify({
    resourceKey: input.resourceKey ?? null,
    signature: input.signature ?? null,
    geometryRevision: input.geometryRevision ?? 0,
    mediaRevision: input.mediaRevision ?? 0,
    themeFingerprint: input.themeFingerprint ?? null,
    projectionAspect: Number.isFinite(input.projectionAspect) ? input.projectionAspect : null,
    tier: input.tier,
    width: asset.width,
    height: asset.height,
    contentExtent: asset.contentExtent ?? null,
    layoutAabb: asset.layoutAabb ?? null,
    rootPlacement: asset.rootPlacement ?? null,
    geometryQuality: asset.geometryQuality ?? null,
    media: (asset.media ?? []).map(plane => ({ id: plane.id, kind: plane.kind, itemId: plane.itemId, x: plane.x, y: plane.y, z: plane.z, width: plane.width, height: plane.height, yaw: plane.yaw, unit: plane.unit, hasTexture: plane.hasTexture })),
    itemPlacements: Object.entries(asset.itemPlacements ?? {}).sort(([left], [right]) => left.localeCompare(right))
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
