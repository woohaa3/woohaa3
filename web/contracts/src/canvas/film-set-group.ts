/**
 * Film-set groups are the canonical container for scene authoring.
 *
 * The marker deliberately lives beside the ordinary group node data instead of
 * turning `group` into a business type.  A group is a film set only when this
 * complete, versioned marker decodes successfully.  The legacy composite
 * representation is accepted by the migration reader below, but is never
 * emitted by the new helpers.
 */
import type { CanvasNodeData, ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

import { fnv1a64Hex } from "./content-hash.js";
import { decodeModelDefinition, modelContentHash } from "./model-definition.js";
import { decodeMotionDefinition, type MotionDefinition } from "./motion-script.js";
import { decodeFilmSetMotion, decodeFilmSetPlayback } from "./film-set-content.js";
import { readFilmSetBackdrop, type FilmSetAnimationBinding } from "./film-set-animations.js";
import type { ModelMediaTimeMap } from "./media-time.js";

export const FILM_SET_GROUP_FIELD = "filmSetGroup" as const;
export const FILM_SET_GROUP_SCHEMA_VERSION = 1 as const;
export const FILM_SET_GROUP_MIGRATION_VERSION = 1 as const;
/**
 * 旧片场卡片（260×195 的 3D 预览区）迁成 group 后，场景改在 3D 徽标里显示。徽标基准约
 * 88×64，未显式设置倍率时用 3 倍接近原来的可见面积，避免片场看起来突然变得很小。
 */
export const FILM_SET_GROUP_DEFAULT_BADGE_SCALE = 3 as const;

export const FILM_SET_GROUP_BINDING_KINDS = ["model3d", "image", "video"] as const;
export type FilmSetGroupBindingKind = (typeof FILM_SET_GROUP_BINDING_KINDS)[number];

export type FilmSetGroupTransform = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
};

export type FilmSetGroupSceneBinding = {
  bindingId: string;
  name?: string;
  sourceNodeId: string;
  kind: FilmSetGroupBindingKind;
  transform: FilmSetGroupTransform;
  visibility: boolean;
  /**
   * The source card was dragged out of this film set. The binding and its object
   * animation stay here so dragging the card back restores the same object state,
   * but detached bindings do not participate in rendering, shots, focus or
   * residency. Only a binding that was already owned by this group can become
   * detached; forged bindings to outside sources are still rejected.
   */
  detached?: boolean;
  /** Group-owned object animation; geometry remains on the source card. */
  animation?: { motion: MotionDefinition; playback: ModelMediaTimeMap };
  /** Strict identity of the source content at the last successful prepare. */
  contentKey: string;
};

export type FilmSetGroupCamera = {
  id: string;
  name?: string;
  azimuth: number;
  elevation: number;
  distance: number;
  focusOffset: { x: number; y: number; z: number };
  aspect?: string;
};

export type FilmSetGroupClip = {
  id: string;
  name?: string;
  cameraId?: string;
  duration?: number;
  loop?: boolean;
  backdrop?: string;
  cameraMotion?: MotionDefinition;
  bindings?: FilmSetAnimationBinding[];
};

export type FilmSetGroupGround = {
  transform?: FilmSetGroupTransform;
  width: number;
  depth: number;
  color?: string;
};

export type FilmSetGroupMigrationMarker = {
  version: typeof FILM_SET_GROUP_MIGRATION_VERSION;
  commandId: string;
  sourceNodeId: string;
};

export type FilmSetGroupMarker = {
  schemaVersion: typeof FILM_SET_GROUP_SCHEMA_VERSION;
  sceneBindings: FilmSetGroupSceneBinding[];
  sceneTransform?: FilmSetGroupTransform;
  cameras?: FilmSetGroupCamera[];
  clips?: FilmSetGroupClip[];
  ground?: FilmSetGroupGround;
  activeClip?: string | null;
  migration?: FilmSetGroupMigrationMarker;
};

export type FilmSetGroupNodeData = CanvasNodeData & {
  filmSetGroup: FilmSetGroupMarker;
};

export type FilmSetGroupDecodeResult =
  | { ok: true; value: FilmSetGroupMarker }
  | { ok: false; reason: string };

export type FilmSetGroupDiagnostic = {
  bindingId: string;
  sourceNodeId: string;
  code: "missing-source" | "type-mismatch" | "content-unavailable" | "invalid-marker" | "shared-source";
  message: string;
};

export type FilmSetGroupPreparation = {
  groupId: string;
  marker: FilmSetGroupMarker;
  bindings: Array<FilmSetGroupSceneBinding & { source: Woohaa3CanvasSerializedNode; contentKey: string | null }>;
  diagnostics: FilmSetGroupDiagnostic[];
};

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const id = (value: unknown): value is string => typeof value === "string" && ID_RE.test(value);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const DEFAULT_FILM_SET_GROUP_TRANSFORM: FilmSetGroupTransform = { x: 0, y: 0, z: 0, yaw: 0, scale: 1 };

export function decodeFilmSetGroupTransform(input: unknown): FilmSetGroupTransform | null {
  if (!object(input)) return null;
  const x = input.x, y = input.y, z = input.z, yaw = input.yaw, scale = input.scale;
  if (![x, y, z, yaw, scale].every(finite) || !(scale as number > 0) || (scale as number > 1000)) return null;
  return { x: x as number, y: y as number, z: z as number, yaw: yaw as number, scale: scale as number };
}

function decodeBinding(input: unknown): FilmSetGroupSceneBinding | null {
  if (!object(input) || !id(input.bindingId) || !id(input.sourceNodeId)) return null;
  if (!(FILM_SET_GROUP_BINDING_KINDS as readonly string[]).includes(String(input.kind))) return null;
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80)) return null;
  const transform = decodeFilmSetGroupTransform(input.transform);
  if (!transform || typeof input.visibility !== "boolean" || typeof input.contentKey !== "string" || input.contentKey.length === 0 || input.contentKey.length > 2048) return null;
  let animation: FilmSetGroupSceneBinding["animation"];
  if (input.animation !== undefined) {
    if (!object(input.animation) || !object(input.animation.motion) || !object(input.animation.playback)) return null;
    const m = input.animation.motion, p = input.animation.playback;
    const motion = decodeMotionDefinition({ ...m, motionRevision: m.revision, motionSourceHash: m.sourceHash, motionBasedOnModelVersion: m.basedOnModelVersion });
    if (!motion.ok || !finite(p.startTime) || p.startTime < 0 || !finite(p.duration) || p.duration <= 0 || !finite(p.timeScale) || p.timeScale <= 0 || typeof p.loop !== "boolean") return null;
    animation = { motion: motion.value, playback: { startTime: p.startTime, duration: p.duration, timeScale: p.timeScale, loop: p.loop } };
  }
  if (input.detached !== undefined && typeof input.detached !== "boolean") return null;
  return {
    ...(animation ? { animation } : {}),
    bindingId: input.bindingId,
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    sourceNodeId: input.sourceNodeId,
    kind: input.kind as FilmSetGroupBindingKind,
    transform,
    visibility: input.visibility,
    ...(input.detached === true ? { detached: true } : {}),
    contentKey: input.contentKey
  };
}

function decodeCamera(input: unknown): FilmSetGroupCamera | null {
  if (!object(input) || !id(input.id) || !finite(input.azimuth) || !finite(input.elevation) || !finite(input.distance) || input.distance <= 0 || !object(input.focusOffset)) return null;
  const focusOffset = input.focusOffset;
  if (![focusOffset.x, focusOffset.y, focusOffset.z].every(finite)) return null;
  if (input.name !== undefined && typeof input.name !== "string") return null;
  if (input.aspect !== undefined && typeof input.aspect !== "string") return null;
  return { id: input.id as string, ...(input.name === undefined ? {} : { name: input.name as string }), azimuth: input.azimuth as number, elevation: input.elevation as number, distance: input.distance as number, focusOffset: { x: focusOffset.x as number, y: focusOffset.y as number, z: focusOffset.z as number }, ...(input.aspect === undefined ? {} : { aspect: input.aspect as string }) };
}

export function decodeFilmSetGroupClip(input: unknown): FilmSetGroupClip | null {
  if (!object(input) || !id(input.id)) return null;
  if (input.name !== undefined && typeof input.name !== "string") return null;
  if (input.cameraId !== undefined && !id(input.cameraId)) return null;
  if (input.duration !== undefined && (!finite(input.duration) || input.duration < 0 || input.duration > 86400)) return null;
  if (input.loop !== undefined && typeof input.loop !== "boolean") return null;
  const backdrop = readFilmSetBackdrop(input.backdrop);
  const cameraMotion = decodeFilmSetMotion(input.cameraMotion, input.id);
  if (!backdrop.ok || !cameraMotion.ok) return null;
  const bindings: FilmSetAnimationBinding[] = [];
  if (input.bindings !== undefined) {
    if (!Array.isArray(input.bindings)) return null;
    const seen = new Set<string>();
    for (const raw of input.bindings) {
      if (!object(raw) || !id(raw.itemId) || seen.has(raw.itemId)) return null;
      const motion = decodeFilmSetMotion(raw.motion, raw.itemId);
      const playback = decodeFilmSetPlayback(raw.playback, raw.itemId);
      if (!motion.ok || !playback.ok || !playback.value) return null;
      seen.add(raw.itemId);
      bindings.push({ itemId: raw.itemId, playback: playback.value, ...(motion.value ? { motion: motion.value } : {}) });
    }
  }
  if ((input.duration ?? 0) === 0 && (input.loop === true || bindings.some(binding => binding.playback.duration > 0 || binding.motion?.motionScript.trim()) || cameraMotion.value?.motionScript.trim())) return null;
  return { id: input.id, ...(input.name === undefined ? {} : { name: input.name }), ...(input.cameraId === undefined ? {} : { cameraId: input.cameraId }), ...(input.duration === undefined ? {} : { duration: input.duration }), ...(input.loop === undefined ? {} : { loop: input.loop }), ...(backdrop.value ? { backdrop: backdrop.value } : {}), ...(cameraMotion.value ? { cameraMotion: cameraMotion.value } : {}), ...(input.bindings === undefined ? {} : { bindings }) };
}

export function decodeFilmSetGroupMarker(input: unknown): FilmSetGroupDecodeResult {
  if (!object(input)) return { ok: false, reason: "filmSetGroup 必须是对象" };
  if (input.schemaVersion !== FILM_SET_GROUP_SCHEMA_VERSION) return { ok: false, reason: "不支持的 filmSetGroup.schemaVersion" };
  if (!Array.isArray(input.sceneBindings)) return { ok: false, reason: "filmSetGroup.sceneBindings 必须是数组" };
  const seen = new Set<string>();
  const sceneBindings: FilmSetGroupSceneBinding[] = [];
  for (const raw of input.sceneBindings) {
    const binding = decodeBinding(raw);
    if (!binding) return { ok: false, reason: "filmSetGroup.sceneBindings 包含非法 binding" };
    if (seen.has(binding.bindingId)) return { ok: false, reason: `重复 bindingId：${binding.bindingId}` };
    seen.add(binding.bindingId);
    sceneBindings.push(binding);
  }
  const cameras = input.cameras === undefined ? undefined : (Array.isArray(input.cameras) ? input.cameras.map(decodeCamera) : null);
  if (cameras === null || cameras?.some((entry): entry is null => entry === null)) return { ok: false, reason: "filmSetGroup.cameras 非法" };
  const clips = input.clips === undefined ? undefined : (Array.isArray(input.clips) ? input.clips.map(decodeFilmSetGroupClip) : null);
  if (clips === null || clips?.some((entry): entry is null => entry === null)) return { ok: false, reason: "filmSetGroup.clips 非法" };
  if (cameras && new Set(cameras.map(camera => camera!.id)).size !== cameras.length) return { ok: false, reason: "filmSetGroup.cameras ID 重复" };
  if (clips && new Set(clips.map(clip => clip!.id)).size !== clips.length) return { ok: false, reason: "filmSetGroup.clips ID 重复" };
  for (const clip of clips ?? []) {
    if (clip!.cameraId && !cameras?.some(camera => camera!.id === clip!.cameraId)) return { ok: false, reason: "镜头引用的相机不存在" };
    if (clip!.bindings?.some(binding => !seen.has(binding.itemId))) return { ok: false, reason: "镜头引用的对象绑定不存在" };
  }
  const sceneTransform = input.sceneTransform === undefined ? undefined : decodeFilmSetGroupTransform(input.sceneTransform);
  if (sceneTransform === null) return { ok: false, reason: "filmSetGroup.sceneTransform 非法" };
  let ground: FilmSetGroupGround | undefined;
  if (input.ground !== undefined) {
    if (!object(input.ground) || !finite(input.ground.width) || !finite(input.ground.depth) || input.ground.width <= 0 || input.ground.depth <= 0 || input.ground.width > 1e6 || input.ground.depth > 1e6 || (input.ground.color !== undefined && typeof input.ground.color !== "string")) return { ok: false, reason: "filmSetGroup.ground 非法" };
    const transform = input.ground.transform === undefined ? undefined : decodeFilmSetGroupTransform(input.ground.transform);
    if (transform === null) return { ok: false, reason: "filmSetGroup.ground.transform 非法" };
    ground = { ...(transform ? { transform } : {}), width: input.ground.width, depth: input.ground.depth, ...(input.ground.color === undefined ? {} : { color: input.ground.color }) };
  }
  if (input.activeClip !== undefined && input.activeClip !== null && !id(input.activeClip)) return { ok: false, reason: "filmSetGroup.activeClip 非法" };
  if (typeof input.activeClip === "string" && !clips?.some(clip => clip!.id === input.activeClip)) return { ok: false, reason: "活动镜头不存在" };
  let migration: FilmSetGroupMigrationMarker | undefined;
  if (input.migration !== undefined) {
    if (!object(input.migration) || input.migration.version !== FILM_SET_GROUP_MIGRATION_VERSION || !id(input.migration.commandId) || !id(input.migration.sourceNodeId)) return { ok: false, reason: "filmSetGroup.migration 非法" };
    migration = { version: FILM_SET_GROUP_MIGRATION_VERSION, commandId: input.migration.commandId, sourceNodeId: input.migration.sourceNodeId };
  }
  return { ok: true, value: { schemaVersion: FILM_SET_GROUP_SCHEMA_VERSION, sceneBindings, ...(sceneTransform ? { sceneTransform } : {}), ...(cameras ? { cameras: cameras as FilmSetGroupCamera[] } : {}), ...(clips ? { clips: clips as FilmSetGroupClip[] } : {}), ...(ground ? { ground } : {}), ...(input.activeClip === undefined ? {} : { activeClip: input.activeClip as string | null }), ...(migration ? { migration } : {}) } };
}

export function isFilmSetGroupNode(node: Pick<Woohaa3CanvasSerializedNode, "type"> | undefined, data: unknown): boolean {
  return node?.type === "group" && decodeFilmSetGroupMarker(object(data) ? data[FILM_SET_GROUP_FIELD] : undefined).ok;
}

/** Binding participates in the scene; detached bindings keep dormant object state only. */
export function isActiveFilmSetBinding(binding: Pick<FilmSetGroupSceneBinding, "detached">): boolean {
  return binding.detached !== true;
}

export function activeFilmSetSceneBindings(marker: Pick<FilmSetGroupMarker, "sceneBindings">): FilmSetGroupSceneBinding[] {
  return marker.sceneBindings.filter(isActiveFilmSetBinding);
}

export function readFilmSetGroupMarker(data: unknown): FilmSetGroupMarker | null {
  const decoded = decodeFilmSetGroupMarker(object(data) ? data[FILM_SET_GROUP_FIELD] : undefined);
  return decoded.ok ? decoded.value : null;
}

export function createFilmSetGroupMarker(input: Partial<FilmSetGroupMarker> = {}): FilmSetGroupMarker {
  return {
    schemaVersion: FILM_SET_GROUP_SCHEMA_VERSION,
    sceneBindings: (input.sceneBindings ?? []).map(binding => ({ ...binding, transform: { ...binding.transform }, ...(binding.animation ? { animation: { motion: { ...binding.animation.motion, basedOnModelVersion: { ...binding.animation.motion.basedOnModelVersion } }, playback: { ...binding.animation.playback } } } : {}) })),
    ...(input.sceneTransform ? { sceneTransform: { ...input.sceneTransform } } : {}),
    ...(input.cameras ? { cameras: input.cameras.map(camera => ({ ...camera, focusOffset: { ...camera.focusOffset } })) } : {}),
    ...(input.clips ? { clips: input.clips.map(clip => structuredClone(clip)) } : {}),
    ...(input.ground ? { ground: { ...input.ground, ...(input.ground.transform ? { transform: { ...input.ground.transform } } : {}) } } : {}),
    ...(input.activeClip === undefined ? {} : { activeClip: input.activeClip }),
    ...(input.migration ? { migration: { ...input.migration } } : {})
  };
}

export function filmSetGroupData(marker: FilmSetGroupMarker, extra: CanvasNodeData = {}): FilmSetGroupNodeData {
  return { ...extra, filmSetGroup: createFilmSetGroupMarker(marker) } as FilmSetGroupNodeData;
}

function isDescendantOf(canvas: ServerCanvas, sourceId: string, groupId: string): boolean {
  const nodes = new Map(canvas.document.nodes.map(node => [node.id, node]));
  let current = nodes.get(sourceId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.parentId === groupId) return true;
    seen.add(current.id);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return false;
}

export function validateFilmSetGroupBindings(canvas: ServerCanvas, groupId: string, marker: FilmSetGroupMarker, missingSourceIds: ReadonlySet<string> = new Set(), previouslyOwnedBindings?: readonly FilmSetGroupSceneBinding[]): string | null {
  const group = canvas.document.nodes.find(node => node.id === groupId);
  if (!group || group.type !== "group") return "片场 group 不存在或类型非法";
  const sources = new Map(canvas.document.nodes.map(node => [node.id, node]));
  for (const binding of marker.sceneBindings) {
    const source = sources.get(binding.sourceNodeId);
    if (!source) {
      if (missingSourceIds.has(binding.sourceNodeId)) continue;
      return `binding ${binding.bindingId} 的 sourceNodeId 不存在`;
    }
    if (!isDescendantOf(canvas, source.id, groupId)) {
      // Drag-out is a soft detach: the binding (and its object animation) stays
      // owned by this film set while the source card lives outside the group.
      // Only a binding that already belonged to this film set may take this
      // state; a forged binding to an outside source is still rejected.
      if (binding.detached === true && (previouslyOwnedBindings === undefined
        || previouslyOwnedBindings.some(previous => previous.bindingId === binding.bindingId && previous.sourceNodeId === binding.sourceNodeId))) continue;
      return `binding ${binding.bindingId} 的来源必须属于片场 group`;
    }
    if (source.type !== binding.kind) return `binding ${binding.bindingId} 的 kind 与来源类型不匹配`;
  }
  return null;
}

function contentKeyForNode(node: Woohaa3CanvasSerializedNode, data: CanvasNodeData | undefined): string | null {
  if (node.type === "model3d") {
    const model = decodeModelDefinition(data);
    return model.ok ? `model3d:${modelContentHash(model.value)}` : null;
  }
  if (node.type === "image" || node.type === "video") {
    const media = data?.mediaContent;
    const payload = media && typeof media === "object" ? (media as { payload?: unknown }).payload : undefined;
    const mediaId = typeof data?.outputAssetId === "string" ? data.outputAssetId : payload && typeof payload === "object" && typeof (payload as { assetId?: unknown }).assetId === "string" ? (payload as { assetId: string }).assetId : null;
    return mediaId ? `${node.type}:${mediaId}` : null;
  }
  return null;
}

export function contentKeyForFilmSetGroupSource(canvas: ServerCanvas, sourceNodeId: string): string | null {
  const node = canvas.document.nodes.find(entry => entry.id === sourceNodeId);
  if (!node) return null;
  const key = contentKeyForNode(node, canvas.nodeData[sourceNodeId]);
  if (!key || node.type === "model3d") return key;
  const data = canvas.nodeData[sourceNodeId];
  const assetId = data?.outputAssetId ?? data?.mediaContent?.payload?.assetId;
  const asset = canvas.assets.find(asset => asset.id === assetId);
  if (!asset || asset.status !== "ready") return null;
  return asset || data?.mediaContent ? `${key}:${fnv1a64Hex(JSON.stringify([asset?.status, asset?.metadata, data?.mediaContent]))}` : key;
}

export function prepareFilmSetGroup(canvas: ServerCanvas, groupId: string): FilmSetGroupPreparation | null {
  const group = canvas.document.nodes.find(node => node.id === groupId);
  const marker = group ? readFilmSetGroupMarker(canvas.nodeData[groupId]) : null;
  if (!group || !marker || group.type !== "group") return null;
  const nodes = new Map(canvas.document.nodes.map(node => [node.id, node]));
  const bindings: FilmSetGroupPreparation["bindings"] = [];
  const diagnostics: FilmSetGroupDiagnostic[] = [];
  for (const binding of activeFilmSetSceneBindings(marker)) {
    const source = nodes.get(binding.sourceNodeId);
    if (!source) {
      diagnostics.push({ bindingId: binding.bindingId, sourceNodeId: binding.sourceNodeId, code: "missing-source", message: "来源资源卡片不存在，绑定已保留" });
      continue;
    }
    if (source.type !== binding.kind) {
      diagnostics.push({ bindingId: binding.bindingId, sourceNodeId: binding.sourceNodeId, code: "type-mismatch", message: "来源节点类型与 binding 不匹配" });
      continue;
    }
    const contentKey = contentKeyForFilmSetGroupSource(canvas, source.id);
    if (!contentKey) {
      diagnostics.push({ bindingId: binding.bindingId, sourceNodeId: binding.sourceNodeId, code: "content-unavailable", message: "来源资源尚未就绪，可稍后重试" });
      continue;
    }
    bindings.push({ ...binding, source, contentKey });
  }
  return { groupId, marker, bindings, diagnostics };
}

export function patchFilmSetGroupBinding(marker: FilmSetGroupMarker, bindingId: string, patch: Partial<Pick<FilmSetGroupSceneBinding, "transform" | "visibility" | "contentKey" | "animation">>): FilmSetGroupDecodeResult {
  const index = marker.sceneBindings.findIndex(binding => binding.bindingId === bindingId);
  if (index < 0) return { ok: false, reason: "binding 不存在" };
  const next = createFilmSetGroupMarker(marker);
  next.sceneBindings[index] = { ...next.sceneBindings[index], ...patch, ...(patch.transform ? { transform: { ...patch.transform } } : {}) };
  return decodeFilmSetGroupMarker(next);
}

export type FilmSetGroupMigrationResult =
  | { ok: true; canvas: ServerCanvas; groupId: string; createdNodeIds: string[]; diagnostics: FilmSetGroupDiagnostic[]; duplicate?: boolean }
  | { ok: false; reason: string; diagnostics: FilmSetGroupDiagnostic[] };

export type FilmSetGroupMigrationOptions = {
  commandId: string;
  groupId?: string;
  idFactory?: (kind: string, sourceId: string, index: number) => string;
};

export { ensureFilmSetGroupBadgeScale, migrateLegacyFilmSetToGroup } from "./film-set-group-migration.js";

/** Small async cache used by the browser runtime.  A stale prepare is ignored. */
export class FilmSetGroupPreparationCache<T> {
  private readonly entries = new Map<string, { groupId: string; bindingId: string; key: string; promise: Promise<T>; cancelled: boolean; controller: AbortController }>();
  prepare(groupId: string, bindingId: string, contentKey: string, loader: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const cacheKey = JSON.stringify([groupId, bindingId]);
    const previous = this.entries.get(cacheKey);
    if (previous?.key === contentKey) return previous.promise;
    if (previous) { previous.cancelled = true; previous.controller.abort(); }
    const controller = new AbortController();
    const entry = { groupId, bindingId, controller, key: contentKey, cancelled: false, promise: Promise.resolve().then(() => loader(controller.signal)).then(value => {
      const current = this.entries.get(cacheKey);
      if (entry.cancelled || current !== entry) throw new Error("stale-film-set-group-preparation");
      return value;
    }) };
    this.entries.set(cacheKey, entry);
    return entry.promise;
  }
  invalidate(groupId: string, bindingId?: string): void {
    for (const [key, entry] of this.entries) if (entry.groupId === groupId && (bindingId === undefined || entry.bindingId === bindingId)) { entry.cancelled = true; entry.controller.abort(); this.entries.delete(key); }
  }
}
