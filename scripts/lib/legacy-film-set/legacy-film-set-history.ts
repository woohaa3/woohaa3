/**
 * Offline history input/conversion for the explicit composite-asset migration.
 * No production exports/imports. Ownership must first be proven from stored
 * node fields (including historical Yjs intervals), never inferred from IDs.
 */
import {
  FILM_SET_EXTENSION_ID,
  MODEL_SCRIPT_LANGUAGE,
  MODEL_SCRIPT_V2_VERSION,
  MOTION_SCRIPT_LANGUAGE,
  MOTION_SCRIPT_VERSION,
  animationDefinitionSnapshotHash,
  canonicalFilmSetFields,
  createModelSnapshot,
  decodeAnimationPayload,
  decodeFilmSetNodeData,
  decodeModelDefinition,
  decodeNodeGenerationHistoryEntry,
  filmSetAnimationsOf,
  hashModelScript,
  isJsonObject,
  type FilmSetHistoryAnimationPayload,
  type NodeGenerationHistoryEntry,
  type NodeHistoryModelPayload,
} from "@woohaa3/contracts";
import { animationDefinitionIdentityFromPayload } from "../../../web/services/canvas-service/src/storage/core/node-history-service/current-state.js";
import { readLegacyFilmSetNodeData } from "./legacy-film-set-reader.js";

type Failure = { ok: false; reason: string };
export type LegacyFilmSetHistoryOptions = { title: string; topModelItemId: string };
type HistoryInput = { ok: true; nodeData: Record<string, unknown>; target: boolean } | Failure;

const PAYLOAD_KEYS = new Set(["kind", "modelScript", "language", "version", "sourceHash", "placement", "modelCameras", "animation"]);
const ANIMATION_KEYS = new Set([
  "schemaVersion", "modelContentVersion", "motionScript", "motionScriptLanguage", "motionScriptVersion", "motionRevision",
  "motionSourceHash", "motionBasedOnModelVersion", "initialCamera", "timeline", "filmSetContent", "filmSetAnimations",
  "scenePlacement", "sceneCamera", "origin",
]);
const ENTRY_KEYS = new Set(["version", "entryId", "canvasId", "nodeId", "kind", "createdAt", "sourceIdentity",
  "currentIdentity", "recoverable", "previewable", "source", "payload"]);
const SOURCE_KEYS = new Set(["label", "runId", "providerTaskId", "modelId", "sourceHash", "durationSeconds"]);
const unknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>) => Object.keys(value).filter(key => !allowed.has(key));
const stable = (value: unknown): string | undefined => JSON.stringify(value, (_key, entry: unknown) => isJsonObject(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);

/**
 * Prepare a history payload as an offline nodeData input BEFORE global item ID
 * allocation. Feed every current/deleted owner and completion snapshot through
 * this function, then precollect all inputs together with canonical records.
 */
export function legacyFilmSetHistoryInput(payload: unknown, title: string): HistoryInput {
  if (!isJsonObject(payload) || payload.kind !== "model" || unknownKeys(payload, PAYLOAD_KEYS).length) {
    return { ok: false, reason: "片场历史 payload 类型或字段不受支持" };
  }
  if (typeof title !== "string" || !title.trim()) return { ok: false, reason: "片场历史转换缺少明确标题" };
  const raw = payload.animation;
  if (raw !== undefined && (!isJsonObject(raw) || unknownKeys(raw, ANIMATION_KEYS).length)) {
    return { ok: false, reason: "片场历史 animation 字段不受支持" };
  }
  const animation = isJsonObject(raw) ? structuredClone(raw) : {};
  const schema = animation.schemaVersion;
  if (schema !== undefined && schema !== 1 && schema !== 2 && schema !== 3) {
    return { ok: false, reason: "片场历史 animation 版本不受支持" };
  }
  if (payload.language !== MODEL_SCRIPT_LANGUAGE || payload.version !== MODEL_SCRIPT_V2_VERSION) {
    return { ok: false, reason: "片场历史模型 descriptor 不受支持" };
  }
  if (schema === 3) {
    // 离线迁移许可读取上一代坐标语义（schema 3 内容），生产在线读取仍严格拒绝。
    const decoded = decodeAnimationPayload(animation, { acceptedContentVersions: [3, 4] });
    if (!decoded || decoded.schemaVersion !== 3 || payload.modelScript !== "" || payload.placement !== undefined) {
      return { ok: false, reason: "目标片场历史仍有顶层 authored 模型或非法内容" };
    }
    if (stable(decoded) !== stable(animation)) return { ok: false, reason: "目标片场历史解码会丢弃或默认化字段" };
    return { ok: true, target: true, nodeData: {
      extensionId: FILM_SET_EXTENSION_ID, title, scenePlacement: decoded.scenePlacement, sceneCamera: decoded.sceneCamera,
      filmSetContent: decoded.filmSetContent, filmSetAnimations: decoded.filmSetAnimations,
      ...(decoded.origin ? { origin: decoded.origin } : {}),
    } };
  }
  if (animation.sceneCamera !== undefined) return { ok: false, reason: "旧历史含不属于来源版本的 sceneCamera 字段" };
  if (typeof payload.modelScript !== "string" || payload.sourceHash !== hashModelScript(payload.modelScript)) {
    return { ok: false, reason: "旧片场历史模型 descriptor/source hash 非法" };
  }
  // The old history format omitted motion language for its single supported
  // version. Supply that format-defined value ONLY at this offline boundary.
  if (animation.motionScript !== undefined && animation.motionScriptLanguage === undefined) {
    if (animation.motionScriptVersion !== MOTION_SCRIPT_VERSION) return { ok: false, reason: "旧历史 motion 版本不受支持" };
    animation.motionScriptLanguage = MOTION_SCRIPT_LANGUAGE;
  }
  const modelVersion = animation.modelContentVersion;
  const seed = createModelSnapshot({
    modelScript: payload.modelScript,
    modelScriptVersion: MODEL_SCRIPT_V2_VERSION,
  });
  const nodeData: Record<string, unknown> = {
    ...animation, title,
    modelScript: payload.modelScript, modelScriptLanguage: payload.language, modelScriptVersion: payload.version,
    modelContentVersion: modelVersion ?? seed.contentVersion, modelPlacement: payload.placement,
  };
  const decoded = decodeModelDefinition(nodeData);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  // Without a stored ModelContentVersion, derive a truthful hash including the
  // saved placement; never borrow a current canonical model's version.
  if (modelVersion === undefined) nodeData.modelContentVersion = createModelSnapshot({
    modelScript: payload.modelScript, modelScriptVersion: MODEL_SCRIPT_V2_VERSION, placement: decoded.value.placement,
  }).contentVersion;
  return { ok: true, target: false, nodeData };
}

export type LegacyFilmSetHistoryConversion =
  | { ok: true; entry: NodeGenerationHistoryEntry; nodeData: Record<string, unknown>; bytes: number; changed: boolean }
  | Failure;

/** Pure full-entry conversion; stable provenance, flags, identity and time survive. */
export function convertLegacyFilmSetHistoryEntry(
  input: unknown,
  options: LegacyFilmSetHistoryOptions,
): LegacyFilmSetHistoryConversion {
  if (!isJsonObject(input) || input.kind !== "model" || unknownKeys(input, ENTRY_KEYS).length
      || !isJsonObject(input.source) || unknownKeys(input.source, SOURCE_KEYS).length
      || typeof input.recoverable !== "boolean" || typeof input.previewable !== "boolean") {
    return { ok: false, reason: "片场历史条目 metadata 不受支持" };
  }
  // Own a copy before adding old-format defaults or changing any payload field.
  const original = structuredClone(input);
  const prepared = legacyFilmSetHistoryInput(original.payload, options.title);
  if (!prepared.ok) return prepared;
  const converted = readLegacyFilmSetNodeData(prepared.nodeData, { topModelItemId: options.topModelItemId });
  if (!converted.ok) return converted;
  const rawAnimation = isJsonObject(original.payload) && isJsonObject(original.payload.animation) ? original.payload.animation : {};
  const animation: FilmSetHistoryAnimationPayload = {
    schemaVersion: 3, scenePlacement: converted.value.scenePlacement, sceneCamera: converted.value.sceneCamera,
    filmSetContent: converted.value.filmSetContent, filmSetAnimations: filmSetAnimationsOf(converted.value),
    ...(rawAnimation.origin !== undefined ? { origin: rawAnimation.origin as FilmSetHistoryAnimationPayload["origin"] } : {}),
  };
  const validatedAnimation = decodeAnimationPayload(animation, { acceptedContentVersions: [3, 4] });
  if (!validatedAnimation || validatedAnimation.schemaVersion !== 3 || stable(validatedAnimation) !== stable(animation)) {
    return { ok: false, reason: "转换后的片场历史无法完整保全内容/来源" };
  }
  const stored = original.payload as Record<string, unknown>;
  const payload: NodeHistoryModelPayload = {
    kind: "model", modelScript: "", language: MODEL_SCRIPT_LANGUAGE, version: MODEL_SCRIPT_V2_VERSION,
    // A film set has no single authored source. Use its real complete snapshot
    // hash, while the original source summary/identity remain unchanged.
    sourceHash: animationDefinitionSnapshotHash(validatedAnimation), animation: validatedAnimation,
    ...(stored.modelCameras !== undefined ? { modelCameras: stored.modelCameras as NodeHistoryModelPayload["modelCameras"] } : {}),
  };
  const candidate = { ...original, payload, currentIdentity: animationDefinitionIdentityFromPayload(validatedAnimation) };
  const decoded = decodeNodeGenerationHistoryEntry(candidate, { acceptedContentVersions: [3, 4] });
  if (!decoded.ok) return { ok: false, reason: decoded.message };
  if (stable(decoded.value) !== stable(candidate)) return { ok: false, reason: "新历史 codec 会丢弃或默认化 metadata/payload" };
  const fields = canonicalFilmSetFields({ ...converted.value, ...(animation.origin ? { origin: animation.origin } : {}) });
  // 离线迁移产物仍是 schema 3 内容（坐标迁移按节点尺寸在其后执行），因此这里用离线许可复核。
  const verified = decodeFilmSetNodeData(fields, { acceptedContentVersions: [3, 4] });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  return { ok: true, entry: decoded.value, nodeData: fields, bytes: Buffer.byteLength(JSON.stringify(decoded.value), "utf8"),
    changed: stable(decoded.value) !== stable(input) };
}
