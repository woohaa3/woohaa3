import type { ContentContributionResolver } from "../content-contribution.js";
import { decodeFilmSetGroupMarker } from "../film-set-group.js";
import { decodeFilmSetAnimations } from "../film-set-animations.js";
import { decodeFilmSetLocalTransform } from "../film-set-content.js";
import { decodeInitialShotCamera } from "../canvas-node-model.js";
/**
 * 节点生成历史：条目与 payload 的反序列化/校验
 * （自 `node-history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R06）。
 *
 * repository 写入前的最后一道边界：非法 payload 整条拒绝，绝不写入部分内容。
 */
import {
  isBoundedId,
  isFiniteNumber,
  isJsonObject,
  isNonEmptyString,
  isNonNegativeInteger,
  isValidStorageKey
} from "../../validation.js";
import { decodeModelCameras, type ModelCamera } from "../model-cameras.js";
import { decodeImageEditDocument, decodeImageEditProjectObjectRef, isImageProjectDocument } from "../image-edit.js";
import { decodeFilmSetContent, type FilmSetContent } from "../film-set-content.js";
import {
  NODE_GENERATION_HISTORY_VERSION,
  type NodeGenerationHistoryEntry,
  type NodeGenerationKind,
  type NodeHistoryAnimationPayload,
  type NodeHistoryErrorCode,
  type NodeHistoryFailurePayload,
  type NodeHistoryImageEditBaseMetadata,
  type NodeHistoryMediaPayload,
  type NodeHistoryModelPlacement,
  type NodeHistoryOutcome,
  type NodeHistoryPayload,
  type NodeHistorySourceSummary
} from "./types.js";
import { isRecoverableOutcome, isNodeHistoryOutcome } from "./types.js";
import { NODE_HISTORY_CURRENT_IDENTITY_MAX, decodeNodeGenerationIdentity, encodeNodeGenerationIdentity } from "./identity.js";

const MAX_TEXT_PAYLOAD_CHARS = 2_000_000;

export type NodeHistoryDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: NodeHistoryErrorCode; message: string };

function invalid(message: string): { ok: false; code: "NODE_HISTORY_INVALID"; message: string } {
  return { ok: false, code: "NODE_HISTORY_INVALID", message };
}

/**
 * 校验一条完整历史条目（repository 写入前的最后一道边界）。
 *
 * `options.acceptedContentVersions` 只供**离线迁移**复核其即将写回的上一代坐标内容；生产写入
 * 与读取不传，因此在线路径仍严格拒绝旧坐标版本
 * （change: 2026-10-23-isolate-film-set-camera-space，design D5）。
 */
export function decodeNodeGenerationHistoryEntry(
  input: unknown,
  options: { acceptedContentVersions?: readonly number[]; content?: ContentContributionResolver } = {}
): NodeHistoryDecodeResult<NodeGenerationHistoryEntry> {
  if (!isJsonObject(input)) return invalid("历史条目必须是对象");
  if (input.version !== NODE_GENERATION_HISTORY_VERSION) return invalid("历史条目版本不受支持");
  const entryId = input.entryId;
  const canvasId = input.canvasId;
  const nodeId = input.nodeId;
  if (!isBoundedId(entryId) || !isBoundedId(canvasId) || !isBoundedId(nodeId)) return invalid("历史条目缺少合法 id");
  if (!isNodeGenerationKind(input.kind)) return invalid("历史条目种类非法");
  if (!isNonEmptyString(input.createdAt)) return invalid("历史条目缺少 createdAt");
  const sourceIdentity = decodeNodeGenerationIdentity(input.sourceIdentity);
  if (sourceIdentity === null) return invalid("sourceIdentity 非法");
  const currentIdentity = input.currentIdentity;
  if (typeof currentIdentity !== "string" || currentIdentity.length === 0 || currentIdentity.length > NODE_HISTORY_CURRENT_IDENTITY_MAX) {
    return invalid("currentIdentity 非法");
  }
  const source = decodeSourceSummary(input.source);
  if (!source.ok) return source;
  const payload = decodePayload(input.kind, input.payload, options);
  if (!payload.ok) return payload;
  // outcome：缺省（旧条目）视为 succeeded；失败 payload 必须与 outcome 一致。
  const outcome = decodeOutcome(input.outcome);
  if (outcome === null) return invalid("历史条目 outcome 非法");
  const effectiveOutcome: NodeHistoryOutcome = outcome ?? "succeeded";
  if ((payload.value.kind === "failure") !== (effectiveOutcome !== "succeeded")) {
    return invalid("历史条目 outcome 与 payload 不一致");
  }
  return {
    ok: true,
    value: {
      version: NODE_GENERATION_HISTORY_VERSION,
      entryId,
      canvasId,
      nodeId,
      kind: input.kind,
      createdAt: input.createdAt,
      // outcome：缺省（旧条目）不落字段，保持 round-trip 保真；消费方按缺省=succeeded 处理。
      ...(outcome === undefined ? {} : { outcome: effectiveOutcome }),
      sourceIdentity: encodeNodeGenerationIdentity(sourceIdentity),
      currentIdentity,
      recoverable: input.recoverable === true && isRecoverableOutcome(effectiveOutcome),
      previewable: input.previewable === true,
      source: source.value,
      payload: payload.value
    }
  };
}

/** outcome：缺省返回 undefined（兼容旧条目）；显式非法返回 null。 */
function decodeOutcome(input: unknown): NodeHistoryOutcome | undefined | null {
  if (input === undefined) return undefined;
  return isNodeHistoryOutcome(input) ? input : null;
}

function isNodeGenerationKind(value: unknown): value is NodeGenerationKind {
  return value === "text" || value === "image" || value === "video" || value === "audio" || value === "model";
}

function decodeSourceSummary(input: unknown): NodeHistoryDecodeResult<NodeHistorySourceSummary> {
  if (!isJsonObject(input)) return invalid("source 必须是对象");
  if (typeof input.label !== "string" || input.label.length > 200) return invalid("source.label 非法");
  const summary: NodeHistorySourceSummary = { label: input.label };
  for (const key of ["runId", "taskKey", "providerTaskId", "modelId", "sourceHash"] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 300) return invalid(`source.${key} 非法`);
      summary[key] = value;
    }
  }
  if (input.durationSeconds !== undefined) {
    if (!isFiniteNumber(input.durationSeconds) || input.durationSeconds < 0) return invalid("source.durationSeconds 非法");
    summary.durationSeconds = input.durationSeconds;
  }
  return { ok: true, value: summary };
}

function decodePayload(
  kind: NodeGenerationKind,
  input: unknown,
  options: { acceptedContentVersions?: readonly number[]; content?: ContentContributionResolver } = {}
): NodeHistoryDecodeResult<NodeHistoryPayload> {
  if (!isJsonObject(input)) return invalid("payload 必须是对象");
  if (input.kind === "failure") return decodeFailurePayload(kind, input);
  if (kind === "text") {
    const text = input.text;
    if (typeof text !== "string" || text.length > MAX_TEXT_PAYLOAD_CHARS) return invalid("文本 payload 非法或超长");
    return { ok: true, value: { kind: "text", text } };
  }
  if (kind === "model") {
    const modelScript = input.modelScript;
    const language = input.language;
    const version = input.version;
    const sourceHash = input.sourceHash;
    const animation = decodeAnimationPayload(input.animation, options);
    if (input.animation !== undefined && animation === null) return invalid("模型 payload animation 非法");
    // items-only 片场历史（schema 3）没有顶层 authored 模型：`modelScript` 允许为空，身份由完整
    // 片场定义承担（D8/D10）。这只放宽 schema-3 片场分支，普通 model3d 仍必须带真实脚本，
    // 也绝不造 placeholder 脚本冒充（change 2026-10-11-extract-film-set-extension）。
    const filmSetAnimation = animation !== null && (animation.schemaVersion === 3 || animation.schemaVersion === 4);
    if (typeof modelScript !== "string" || (!filmSetAnimation && modelScript.length === 0)) return invalid("模型 payload 缺少脚本");
    if (typeof language !== "string" || typeof version !== "string") return invalid("模型 payload descriptor 非法");
    if (typeof sourceHash !== "string" || sourceHash.length === 0) return invalid("模型 payload 缺少 sourceHash");
    const placement = decodeModelPlacement(input.placement);
    if (input.placement !== undefined && placement === null) return invalid("模型 payload placement 非法");
    let modelCameras: ModelCamera[] | undefined;
    if (input.modelCameras !== undefined) {
      const cameras = decodeModelCameras(input.modelCameras);
      if (!cameras.ok) return invalid(`模型 payload modelCameras 非法：${cameras.reason}`);
      modelCameras = cameras.value;
    }
    return {
      ok: true,
      value: {
        kind: "model",
        modelScript,
        language,
        version,
        sourceHash,
        ...(placement ? { placement } : {}),
        ...(modelCameras ? { modelCameras } : {}),
        ...(animation ? { animation } : {})
      }
    };
  }
  return decodeMediaPayload(kind, input);
}

/** 校验失败/取消/中断归档 payload（不受信任输入）。 */
function decodeFailurePayload(
  contentKind: NodeGenerationKind,
  input: Record<string, unknown>
): NodeHistoryDecodeResult<NodeHistoryFailurePayload> {
  if (!isNodeHistoryOutcome(input.outcome) || isRecoverableOutcome(input.outcome)) {
    return invalid("失败 payload outcome 非法");
  }
  const failureOutcome = input.outcome as Exclude<NodeHistoryOutcome, "succeeded">;
  if (input.failureKind !== contentKind) return invalid("失败 payload failureKind 与条目 kind 不一致");
  if (typeof input.message !== "string" || input.message.length === 0 || input.message.length > 2000) {
    return invalid("失败 payload message 非法");
  }
  if (input.code !== undefined && (typeof input.code !== "string" || input.code.length > 120)) {
    return invalid("失败 payload code 非法");
  }
  if (typeof input.inputSummary !== "string" || input.inputSummary.length > 2000) {
    return invalid("失败 payload inputSummary 非法");
  }
  const baseline = decodeFailureBaseline(input.baseline);
  if (input.baseline !== null && input.baseline !== undefined && baseline === null) {
    return invalid("失败 payload baseline 非法");
  }
  return {
    ok: true,
    value: {
      kind: "failure",
      outcome: failureOutcome,
      failureKind: contentKind,
      message: input.message,
      ...(typeof input.code === "string" ? { code: input.code } : {}),
      baseline: baseline ?? null,
      inputSummary: input.inputSummary
    }
  };
}

function decodeFailureBaseline(input: unknown): NodeHistoryFailurePayload["baseline"] | null {
  if (!isJsonObject(input)) return null;
  if (typeof input.identity !== "string" || input.identity.length === 0 || input.identity.length > 512) return null;
  if (typeof input.nodeType !== "string" || input.nodeType.length === 0 || input.nodeType.length > 60) return null;
  const baseline: NonNullable<NodeHistoryFailurePayload["baseline"]> = {
    identity: input.identity,
    nodeType: input.nodeType
  };
  if (input.entryId !== undefined) {
    if (!isBoundedId(input.entryId)) return null;
    baseline.entryId = input.entryId;
  }
  if (input.outputAssetId !== undefined) {
    if (!isBoundedId(input.outputAssetId)) return null;
    baseline.outputAssetId = input.outputAssetId;
  }
  return baseline;
}

/**
 * 校验并归一化动画版本 payload（不受信任输入）；非法返回 null。
 *
 * `options.acceptedContentVersions` 只供**离线迁移**读取上一代坐标语义的片场内容；生产入口
 * 不传，因此在线读取仍严格拒绝旧坐标版本（change: 2026-10-23-isolate-film-set-camera-space，D5）。
 */
export function decodeAnimationPayload(
  input: unknown,
  options: { acceptedContentVersions?: readonly number[]; content?: ContentContributionResolver } = {}
): NodeHistoryAnimationPayload | null {
  if (!isJsonObject(input)) return null;
  if (input.schemaVersion === 4) {
    if (Object.keys(input).some(key => key !== "schemaVersion" && key !== "filmSetGroup")) return null;
    const owned = decodeOwnedFilmSetGroupHistory(input.filmSetGroup, options.content);
    if (owned !== undefined) return owned;
    const marker = decodeFilmSetGroupMarker(input.filmSetGroup);
    return marker.ok ? { schemaVersion: 4, filmSetGroup: marker.value } : null;
  }
  // 片场 items-only payload（布局版本 3）：独立根 + 共享 items + 全部 clips；不另存顶层模型。
  // 内部 `filmSetContent` 必须是当前 schema（场景单位）；旧坐标语义只由离线迁移转换
  // （change: 2026-10-23-isolate-film-set-camera-space，design D5）。
  if (input.schemaVersion === 3) {
    if (["motionScript", "motionScriptVersion", "motionRevision", "motionSourceHash", "motionBasedOnModelVersion", "initialCamera", "timeline", "modelContentVersion", "modelScript", "modelScriptLanguage", "modelScriptVersion", "modelContentVersion", "modelPlacement"].some(key => input[key] !== undefined)) return null;
    const scenePlacement = decodeFilmSetLocalTransform(input.scenePlacement);
    if (!scenePlacement.ok) return null;
    const sceneCamera = decodeInitialShotCamera(input.sceneCamera);
    if (!sceneCamera.ok) return null;
    const ownedContent = decodeOwnedFilmSetContentHistory(input.filmSetContent, options.content);
    if (ownedContent === null) return null;
    const content = ownedContent !== undefined
      ? (isFilmSetContentShape(ownedContent) ? { ok: true as const, value: ownedContent } : null)
      : decodeFilmSetContent(
        input.filmSetContent,
        options.acceptedContentVersions ? { acceptedVersions: options.acceptedContentVersions } : {}
      );
    if (!content) return null;
    if (!content.ok) return null;
    const animations = decodeFilmSetAnimations(input.filmSetAnimations, content.value);
    if (!animations.ok) return null;
    const origin = decodeOrigin(input.origin);
    return { schemaVersion: 3, scenePlacement: scenePlacement.value, sceneCamera: sceneCamera.value, filmSetContent: content.value, filmSetAnimations: animations.value, ...(origin ? { origin } : {}) };
  }
  return null;
}

function isFilmSetContentShape(value: unknown): value is FilmSetContent {
  return isJsonObject(value) && typeof value.schemaVersion === "number" && Array.isArray(value.items);
}

/** 有 resolver 时只信 owner。返回 undefined 表示没有 owner 接手，调用方继续用内核解码。 */
function decodeOwnedFilmSetContentHistory(field: unknown, content: ContentContributionResolver | undefined): unknown | null | undefined {
  if (!content) return undefined;
  for (const contribution of content.implementations()) {
    const codec = contribution.nodeData;
    if (!codec?.inspect) continue;
    try {
      const report = codec.inspect({ filmSetContent: field });
      if (!report.ok) return null;
      if (report.report == null) continue;
      const decoded = codec.decode({ filmSetContent: field });
      if (!decoded.ok) return null;
      return decoded.value;
    } catch {
      return null;
    }
  }
  return undefined;
}

function decodeOwnedFilmSetGroupHistory(marker: unknown, content: ContentContributionResolver | undefined): NodeHistoryAnimationPayload | null | undefined {
  if (!content) return undefined;
  const data = { filmSetGroup: marker };
  for (const contribution of content.implementations()) {
    const codec = contribution.nodeData;
    if (!codec) continue;
    try {
      const diagnostic = codec.validatePatch({}, data);
      if (diagnostic) return null;
      const decoded = codec.decode(data);
      if (!decoded.ok) continue;
      const normalized = decodeFilmSetGroupMarker(decoded.value);
      return normalized.ok ? { schemaVersion: 4, filmSetGroup: normalized.value } : null;
    } catch {
      return null;
    }
  }
  return undefined;
}

function decodeOrigin(input: unknown): NodeHistoryAnimationPayload["origin"] | null {
  if (!isJsonObject(input)) return null;
  if (typeof input.importedModelContentHash !== "string" || input.importedModelContentHash.length === 0) return null;
  if (typeof input.importedAt !== "string" || input.importedAt.length === 0) return null;
  return {
    ...(typeof input.sourceNodeId === "string" && input.sourceNodeId.length > 0 ? { sourceNodeId: input.sourceNodeId } : {}),
    ...(typeof input.sourceCanvasId === "string" && input.sourceCanvasId.length > 0 ? { sourceCanvasId: input.sourceCanvasId } : {}),
    importedModelContentHash: input.importedModelContentHash,
    importedAt: input.importedAt
  };
}

/** 校验并归一化模型摆放（不受信任输入）；非法返回 null。 */
export function decodeModelPlacement(input: unknown): NodeHistoryModelPlacement | null {
  if (!isJsonObject(input)) return null;
  const offset = isJsonObject(input.offset) ? input.offset : null;
  if (!offset) return null;
  const x = offset.x;
  const y = offset.y;
  const z = offset.z;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
  if (!isFiniteNumber(input.scale) || !isFiniteNumber(input.yaw)) return null;
  return { offset: { x, y, z }, scale: input.scale, yaw: input.yaw };
}

function decodeMediaPayload(
  kind: "image" | "video" | "audio",
  input: Record<string, unknown>
): NodeHistoryDecodeResult<NodeHistoryMediaPayload> {
  if (!isValidStorageKey(input.storageKey)) return invalid("媒体 payload storageKey 非法");
  if (typeof input.checksum !== "string" || !/^[0-9a-f]{64}$/.test(input.checksum)) return invalid("媒体 payload checksum 非法");
  if (typeof input.contentType !== "string" || input.contentType.length === 0) return invalid("媒体 payload contentType 非法");
  if (!isNonNegativeInteger(input.size)) return invalid("媒体 payload size 非法");
  const payload: NodeHistoryMediaPayload = {
    kind,
    storageKey: input.storageKey,
    checksum: input.checksum,
    contentType: input.contentType,
    size: input.size
  };
  if (input.durationSeconds !== undefined) {
    if (!isFiniteNumber(input.durationSeconds) || input.durationSeconds < 0) return invalid("媒体 payload durationSeconds 非法");
    payload.durationSeconds = input.durationSeconds;
  }
  if (input.poster !== undefined) {
    if (!isJsonObject(input.poster)) return invalid("媒体 payload poster 非法");
    if (!isValidStorageKey(input.poster.storageKey)) return invalid("poster storageKey 非法");
    if (typeof input.poster.checksum !== "string" || !/^[0-9a-f]{64}$/.test(input.poster.checksum)) return invalid("poster checksum 非法");
    if (typeof input.poster.contentType !== "string" || input.poster.contentType.length === 0) return invalid("poster contentType 非法");
    if (!isNonNegativeInteger(input.poster.size)) return invalid("poster size 非法");
    payload.poster = {
      storageKey: input.poster.storageKey as string,
      checksum: input.poster.checksum,
      contentType: input.poster.contentType,
      size: input.poster.size as number
    };
  }
  // 图片编辑版本：可选稳定原图 metadata + 严格编辑定义（design D4）。
  if (kind === "image") {
    if (input.base !== undefined) {
      const base = decodeImageEditBase(input.base);
      if (!base) return invalid("图片 payload base 非法");
      payload.base = base;
    }
    if (input.imageEdit !== undefined && input.imageEdit !== null) {
      const edit = decodeImageEditDocument(input.imageEdit);
      if (!edit.ok) return invalid(`图片 payload imageEdit 非法：${edit.error}`);
      if (payload.base && (payload.base.sourceWidth !== edit.value.sourceWidth || payload.base.sourceHeight !== edit.value.sourceHeight)) {
        return invalid("图片 payload imageEdit 源尺寸与原图 metadata 不一致");
      }
      if (!payload.base && !isImageProjectDocument(edit.value) && edit.value.shapes.length > 0) {
        return invalid("图片 payload 携带 shapes 但没有原图 metadata");
      }
      // 工程分支：工程对象与合成输出成对保存；工程缺失时该版本只能预览 PNG。
      if (isImageProjectDocument(edit.value)) {
        if (!payload.base) return invalid("图片工程 payload 缺少原图 metadata");
        const project = decodeImageEditProjectObjectRef(input.project);
        if (!project || project.storageKey !== edit.value.project.storageKey) {
          return invalid("图片工程 payload 缺少与定义一致的工程对象 metadata");
        }
        payload.project = project;
      }      payload.imageEdit = edit.value;
    }
  }
  return { ok: true, value: payload };
}

/** 校验图片编辑版本的原图 metadata。 */
export function decodeImageEditBase(input: unknown): NodeHistoryImageEditBaseMetadata | null {
  if (!isJsonObject(input)) return null;
  if (!isBoundedId(input.baseAssetId)) return null;
  if (!isValidStorageKey(input.storageKey)) return null;
  if (typeof input.checksum !== "string" || !/^[0-9a-f]{64}$/.test(input.checksum)) return null;
  if (typeof input.contentType !== "string" || input.contentType.length === 0) return null;
  if (!isNonNegativeInteger(input.size)) return null;
  if (!isNonNegativeInteger(input.sourceWidth) || !isNonNegativeInteger(input.sourceHeight)) return null;
  if (input.sourceWidth < 1 || input.sourceHeight < 1) return null;
  return {
    baseAssetId: input.baseAssetId,
    storageKey: input.storageKey,
    checksum: input.checksum,
    contentType: input.contentType,
    size: input.size,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight
  };
}
