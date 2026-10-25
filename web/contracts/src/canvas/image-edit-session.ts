/**
 * 图片/模型编辑会话完成协议
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 1.4 / design D5/D6）。
 *
 * 版本化的 begin / complete / status 语义端口：Frontend 与 Canvas Service 共用同一份
 * 请求/响应 DTO、稳定错误码与回执状态。传输层可以是 HTTP，但语义完全由本模块描述。
 *
 * 关键约束：
 * - actor 由已有认证确认，**绝不**来自请求字段；
 * - `requestId` + 内容身份构成幂等键：相同 requestId 相同 payload 返回既有结果，
 *   不同 payload 返回稳定冲突；
 * - `sessionId` 是本地聚焦会话身份，用于把中间手势/写入与最终归档关联；
 * - `baseline` 是进入时的内容身份；complete 时服务端重新校验基线仍是当前。
 */
import {
  isNonNegativeInteger,
  isBoundedId,
  isJsonObject,
  isNonEmptyString,
  isValidStorageKey
} from "../validation.js";
import { decodeImageEditDocument, decodeImageEditProjectObjectRef, isImageProjectDocument, type ImageEditDocument, type ImageEditProjectObjectRef } from "./image-edit.js";

/** 编辑会话种类。 */
export const EDIT_SESSION_KINDS = ["image", "model"] as const;
export type EditSessionKind = (typeof EDIT_SESSION_KINDS)[number];

/** 完成回执状态（design D6）。 */
export const EDIT_COMPLETION_STATUSES = [
  "prepared",
  "history-pending",
  "completed",
  "conflict",
  "abandoned"
] as const;
export type EditCompletionStatus = (typeof EDIT_COMPLETION_STATUSES)[number];

export function isEditCompletionStatus(value: unknown): value is EditCompletionStatus {
  return typeof value === "string" && (EDIT_COMPLETION_STATUSES as readonly string[]).includes(value);
}

/** 稳定错误码（跨进程按字符串判定，design D4/D6）。 */
export const EDIT_SESSION_ERROR_CODES = [
  "EDIT_SESSION_NOT_FOUND",
  "EDIT_SESSION_INVALID",
  "EDIT_SESSION_UNAUTHORIZED",
  "EDIT_SESSION_CONFLICT",
  "EDIT_SESSION_TARGET_INVALID",
  "EDIT_SESSION_GENERATION_ACTIVE",
  "EDIT_SESSION_MEDIA_UNRESOLVABLE",
  "EDIT_SESSION_BASELINE_STALE",
  "EDIT_SESSION_UNRECOVERABLE",
  "EDIT_SESSION_CAPABILITY_UNAVAILABLE",
  "EDIT_SESSION_REQUEST_CONFLICT"
] as const;

export type EditSessionErrorCode = (typeof EDIT_SESSION_ERROR_CODES)[number];

export function isEditSessionErrorCode(value: unknown): value is EditSessionErrorCode {
  return typeof value === "string" && (EDIT_SESSION_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 图片完成请求的最终媒体 metadata（稳定资产引用；bytes 由 Media Service 持有）。
 *
 * `outputStorageKey` 是上传后的合成 PNG；`baseStorageKey` 是稳定原图；编辑定义为可选，
 * 缺省表示恢复为纯媒体（清除旧标注）。
 */
export type ImageEditCompleteMedia = {
  baseAssetId: string;
  baseStorageKey: string;
  sourceWidth: number;
  sourceHeight: number;
  outputAssetId: string;
  outputStorageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  /** 原图的稳定 metadata（checksum/contentType/size）；缺省回退到输出 metadata。 */
  baseChecksum?: string;
  baseContentType?: string;
  baseSize?: number;
  /** 可选严格编辑定义；缺省/零 shape 表示回原图。 */
  imageEdit?: ImageEditDocument;
  /**
   * 裁剪后的当前画布尺寸（工程分支必填；不等于原始来源尺寸）。
   * （编辑扩展工作区，design D4/D6）
   */
  canvasWidth?: number;
  canvasHeight?: number;
  /**
   * 工程对象的稳定 metadata（工程分支必填；与 `imageEdit.project` 一致）。
   * 只在受控工程上传/读取链路使用。
   */
  project?: ImageEditProjectObjectRef;
};

/** 模型完成请求：只归档已权威提交的会话内容，不额外推进 revision。 */
export type ModelEditCompletePayload = {
  /** 会话开始时由服务端捕获的基线内容身份；服务端重新校验。 */
  baselineSourceHash: string;
  /** 会话内最终脚本 descriptor（不重写脚本本身，服务端按脚本引用确认）。 */
  finalSourceHash: string;
};

/**
 * 编辑 begin 请求。
 *
 * `baselineContentIdentity` 为图片媒体身份（`media:<storageKey>` 或编辑身份）或模型
 * `model-source:<hash>` / `model-edit:<hash>:<key>`。begin-only 不推进 canvas revision。
 */
export type EditSessionBeginRequest = {
  canvasId: string;
  nodeId: string;
  sessionId: string;
  requestId: string;
  kind: EditSessionKind;
  baselineContentIdentity: string;
};

export type EditSessionBeginResponse = {
  ok: true;
  sessionId: string;
  kind: EditSessionKind;
  status: "prepared";
  /** 服务端捕获的基线内容身份（可能比客户端上报更权威）。 */
  baselineContentIdentity: string;
  /** 服务端为会话派生的稳定关联（模型命令归属用）。 */
  revision: number;
};

/** 图片 complete 请求（design D6）：冻结草稿在上传后由本请求提交。 */
export type ImageEditCompleteRequest = {
  canvasId: string;
  nodeId: string;
  sessionId: string;
  requestId: string;
  kind: "image";
  baselineContentIdentity: string;
  media: ImageEditCompleteMedia;
};

/** 模型 complete 请求：仅登记既有已提交状态；不产生额外 revision。 */
export type ModelEditCompleteRequest = {
  canvasId: string;
  nodeId: string;
  sessionId: string;
  requestId: string;
  kind: "model";
  baselineContentIdentity: string;
  model: ModelEditCompletePayload;
};

export type EditSessionCompleteRequest = ImageEditCompleteRequest | ModelEditCompleteRequest;

/** 完成回执（design D6）：completed 确认该操作保存的版本，不承诺仍是最新内容。 */
export type EditSessionCompletionReceipt = {
  requestId: string;
  sessionId: string;
  canvasId: string;
  nodeId: string;
  kind: EditSessionKind;
  status: EditCompletionStatus;
  /** 本操作提交的内容 identity（用于本地确认 canonical 回流）。 */
  contentIdentity: string;
  /** 已登记/待登记的历史条目 id（若有）。 */
  entryId: string | null;
  /** 本次操作推进后的 canvas revision。 */
  revision: number;
  /** 已经权威提交内容（history-pending 时为 true）。 */
  contentCommitted: boolean;
  /** 失败/冲突时的稳定错误码。 */
  errorCode?: EditSessionErrorCode;
  errorMessage?: string;
};

export type EditSessionCompleteResponse =
  | { ok: true; receipt: EditSessionCompletionReceipt }
  | { ok: false; code: EditSessionErrorCode; message: string; receipt?: EditSessionCompletionReceipt };

/** status 查询请求：客户端在响应丢失/刷新后据此确认。 */
export type EditSessionStatusRequest = {
  canvasId: string;
  nodeId: string;
  requestId: string;
};

export type EditSessionStatusResponse =
  | { ok: true; receipt: EditSessionCompletionReceipt }
  | { ok: false; code: EditSessionErrorCode; message: string };

/**
 * 显式恢复的并发保护（design D8）：客户端可携带它认为的当前内容身份，
 * 服务端在恢复前比较，避免处理草稿后与别人的写入竞争。
 */
export type NodeHistoryApplyRequest = {
  entryId: string;
  expectedCurrentIdentity?: string;
};

/** 校验 begin 请求（不受信任输入）；失败返回稳定错误码。 */
export function decodeEditSessionBeginRequest(input: unknown):
  | { ok: true; value: EditSessionBeginRequest }
  | { ok: false; code: EditSessionErrorCode; message: string } {
  if (!isJsonObject(input)) return invalidBegin("begin 请求必须是对象");
  const canvasId = input.canvasId;
  const nodeId = input.nodeId;
  const sessionId = input.sessionId;
  const requestId = input.requestId;
  if (!isBoundedId(canvasId) || !isBoundedId(nodeId) || !isBoundedId(sessionId, 200) || !isBoundedId(requestId, 200)) {
    return invalidBegin("begin 请求缺少合法 id 字段");
  }
  const kind = input.kind === "image" || input.kind === "model" ? input.kind : null;
  if (!kind) return invalidBegin("begin 请求 kind 非法");
  const baseline = input.baselineContentIdentity;
  if (!isNonEmptyString(baseline) || baseline.length > 512) return invalidBegin("begin 基线内容身份非法");
  return {
    ok: true,
    value: { canvasId, nodeId, sessionId, requestId, kind, baselineContentIdentity: baseline }
  };
}

function invalidBegin(message: string) {
  return { ok: false as const, code: "EDIT_SESSION_INVALID" as const, message };
}

/** 校验图片完成 media metadata（不含 imageEdit 深度校验）。 */
export function decodeImageEditCompleteMedia(input: unknown):
  | { ok: true; value: ImageEditCompleteMedia }
  | { ok: false; code: EditSessionErrorCode; message: string } {
  if (!isJsonObject(input)) return invalidMedia("media 必须是对象");
  if (!isBoundedId(input.baseAssetId)) return invalidMedia("media 缺少合法 baseAssetId");
  if (!isValidStorageKey(input.baseStorageKey)) return invalidMedia("media baseStorageKey 非法");
  const sourceWidth = input.sourceWidth;
  const sourceHeight = input.sourceHeight;
  if (!isNonNegativeInteger(sourceWidth) || !isNonNegativeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    return invalidMedia("media 源尺寸非法");
  }
  if (!isBoundedId(input.outputAssetId)) return invalidMedia("media 缺少合法 outputAssetId");
  if (!isValidStorageKey(input.outputStorageKey)) return invalidMedia("media outputStorageKey 非法");
  if (typeof input.checksum !== "string" || !/^[0-9a-f]{64}$/.test(input.checksum)) return invalidMedia("media checksum 非法");
  if (!isNonEmptyString(input.contentType)) return invalidMedia("media contentType 非法");
  if (!isNonNegativeInteger(input.size)) return invalidMedia("media size 非法");
  if (input.baseChecksum !== undefined && !/^[0-9a-f]{64}$/.test(String(input.baseChecksum))) return invalidMedia("media baseChecksum 非法");
  if (input.baseContentType !== undefined && !isNonEmptyString(input.baseContentType)) return invalidMedia("media baseContentType 非法");
  if (input.baseSize !== undefined && !isNonNegativeInteger(input.baseSize)) return invalidMedia("media baseSize 非法");
  let imageEdit: ImageEditDocument | undefined;
  if (input.imageEdit !== undefined && input.imageEdit !== null) {
    const decoded = decodeImageEditDocument(input.imageEdit);
    if (!decoded.ok) return invalidMedia(`media.imageEdit 非法：${decoded.error}`);
    // v1 标注分支：源尺寸必须与媒体 metadata 一致。
    if (!isImageProjectDocument(decoded.value) && (decoded.value.sourceWidth !== sourceWidth || decoded.value.sourceHeight !== sourceHeight)) {
      return invalidMedia("media.imageEdit 源尺寸与媒体 metadata 不一致");
    }
    imageEdit = decoded.value;
  }
  // 工程分支：画布尺寸与工程对象配对必须显式声明（不从来源尺寸猜测）。
  let canvasWidth: number | undefined;
  let canvasHeight: number | undefined;
  let project: ImageEditProjectObjectRef | undefined;
  if (imageEdit && isImageProjectDocument(imageEdit)) {
    if (!isNonNegativeInteger(input.canvasWidth) || !isNonNegativeInteger(input.canvasHeight) || input.canvasWidth < 1 || input.canvasHeight < 1) {
      return invalidMedia("media 工程分支缺少合法画布尺寸");
    }
    if (input.canvasWidth !== imageEdit.canvasWidth || input.canvasHeight !== imageEdit.canvasHeight) {
      return invalidMedia("media 画布尺寸与工程定义不一致");
    }
    const decodedProject = decodeImageEditProjectObjectRef(input.project ?? imageEdit.project);
    if (!decodedProject) return invalidMedia("media 工程分支缺少合法工程对象 metadata");
    if (decodedProject.storageKey !== imageEdit.project.storageKey) {
      return invalidMedia("media 工程对象与工程定义不一致");
    }
    canvasWidth = input.canvasWidth;
    canvasHeight = input.canvasHeight;
    project = decodedProject;
  } else if (input.canvasWidth !== undefined || input.canvasHeight !== undefined || input.project !== undefined) {
    return invalidMedia("media 非工程分支不得携带画布尺寸或工程对象");
  }
  return {
    ok: true,
    value: {
      baseAssetId: input.baseAssetId,
      baseStorageKey: input.baseStorageKey,
      sourceWidth,
      sourceHeight,
      outputAssetId: input.outputAssetId,
      outputStorageKey: input.outputStorageKey,
      checksum: input.checksum,
      contentType: input.contentType,
      size: input.size,
      ...(typeof input.baseChecksum === "string" ? { baseChecksum: input.baseChecksum } : {}),
      ...(typeof input.baseContentType === "string" ? { baseContentType: input.baseContentType } : {}),
      ...(typeof input.baseSize === "number" ? { baseSize: input.baseSize } : {}),
      ...(imageEdit ? { imageEdit } : {}),
      ...(canvasWidth !== undefined && canvasHeight !== undefined ? { canvasWidth, canvasHeight } : {}),
      ...(project ? { project } : {})
    }
  };
}

function invalidMedia(message: string) {
  return { ok: false as const, code: "EDIT_SESSION_INVALID" as const, message };
}

/** 校验 complete 请求（不受信任输入）。 */
export function decodeEditSessionCompleteRequest(input: unknown):
  | { ok: true; value: EditSessionCompleteRequest }
  | { ok: false; code: EditSessionErrorCode; message: string } {
  if (!isJsonObject(input)) return { ok: false, code: "EDIT_SESSION_INVALID", message: "complete 请求必须是对象" };
  const canvasId = input.canvasId;
  const nodeId = input.nodeId;
  const sessionId = input.sessionId;
  const requestId = input.requestId;
  if (!isBoundedId(canvasId) || !isBoundedId(nodeId) || !isBoundedId(sessionId, 200) || !isBoundedId(requestId, 200)) {
    return { ok: false, code: "EDIT_SESSION_INVALID", message: "complete 请求缺少合法 id 字段" };
  }
  const baselineContentIdentity = input.baselineContentIdentity;
  if (!isNonEmptyString(baselineContentIdentity) || baselineContentIdentity.length > 512) {
    return { ok: false, code: "EDIT_SESSION_INVALID", message: "complete 基线内容身份非法" };
  }
  if (input.kind === "image") {
    const media = decodeImageEditCompleteMedia(input.media);
    if (!media.ok) return media;
    return {
      ok: true,
      value: { canvasId, nodeId, sessionId, requestId, kind: "image", baselineContentIdentity, media: media.value }
    };
  }
  if (input.kind === "model") {
    const model = input.model;
    if (!isJsonObject(model)) return { ok: false, code: "EDIT_SESSION_INVALID", message: "model payload 非法" };
    if (!isNonEmptyString(model.baselineSourceHash) || !isNonEmptyString(model.finalSourceHash)) {
      return { ok: false, code: "EDIT_SESSION_INVALID", message: "model source hash 非法" };
    }
    return {
      ok: true,
      value: {
        canvasId,
        nodeId,
        sessionId,
        requestId,
        kind: "model",
        baselineContentIdentity,
        model: { baselineSourceHash: model.baselineSourceHash, finalSourceHash: model.finalSourceHash }
      }
    };
  }
  return { ok: false, code: "EDIT_SESSION_INVALID", message: "complete 请求 kind 非法" };
}

/** 校验 status 查询请求。 */
export function decodeEditSessionStatusRequest(input: unknown):
  | { ok: true; value: EditSessionStatusRequest }
  | { ok: false; code: EditSessionErrorCode; message: string } {
  if (!isJsonObject(input)) return { ok: false, code: "EDIT_SESSION_INVALID", message: "status 请求必须是对象" };
  const { canvasId, nodeId, requestId } = input;
  if (!isBoundedId(canvasId) || !isBoundedId(nodeId) || !isBoundedId(requestId, 200)) {
    return { ok: false, code: "EDIT_SESSION_INVALID", message: "status 请求缺少合法 id 字段" };
  }
  return { ok: true, value: { canvasId, nodeId, requestId } };
}

/** 校验恢复请求的并发保护字段。 */
export function decodeExpectedCurrentIdentity(input: unknown):
  | { ok: true; value: string | undefined }
  | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (typeof input !== "string" || input.length === 0 || input.length > 512) {
    return { ok: false, message: "expectedCurrentIdentity 非法" };
  }
  return { ok: true, value: input };
}

/**
 * 内容身份比较：由稳定字符串判定，比较前不做归一化（身份已规范化）。
 */
export function contentIdentityMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b;
}

/** 图片编辑身份 helper：`image-edit:<baseStorageKey>:<WxH>:<shapesHash>:<outputStorageKey>`。 */
export function imageEditContentIdentityFromComponents(input: {
  baseStorageKey: string;
  sourceWidth: number;
  sourceHeight: number;
  shapesHash: string;
  outputStorageKey: string;
}): string {
  return `image-edit:${input.baseStorageKey}:${input.sourceWidth}x${input.sourceHeight}:${input.shapesHash}:${input.outputStorageKey}`;
}

/** 请求 payload 指纹：用于「同 requestId 不同 payload → 冲突」判定。 */
export function editCompletePayloadFingerprint(request: EditSessionCompleteRequest): string {
  if (request.kind === "image") {
    return [
      request.canvasId,
      request.nodeId,
      request.baselineContentIdentity,
      request.media.baseAssetId,
      request.media.baseStorageKey,
      `${request.media.sourceWidth}x${request.media.sourceHeight}`,
      request.media.outputStorageKey,
      request.media.checksum,
      request.media.imageEdit ? stableEditFingerprint(request.media.imageEdit) : "no-edit"
    ].join("|");
  }
  return [
    request.canvasId,
    request.nodeId,
    request.baselineContentIdentity,
    request.model.baselineSourceHash,
    request.model.finalSourceHash
  ].join("|");
}

/** 编辑定义的安全指纹（不含艺术字/文档内容字节，只用于同 requestId 冲突判定）。 */
function stableEditFingerprint(imageEdit: ImageEditDocument): string {
  if (isImageProjectDocument(imageEdit)) {
    return [
      "project",
      imageEdit.engineVersion,
      String(imageEdit.formatVersion),
      imageEdit.documentContentHash,
      `${imageEdit.canvasWidth}x${imageEdit.canvasHeight}`,
      imageEdit.project.storageKey
    ].join(":");
  }
  return JSON.stringify(imageEdit.shapes);
}

/** 幂等键：`(canvasId, nodeId, requestId)`。 */
export function editCompletionKey(input: { canvasId: string; nodeId: string; requestId: string }): string {
  return `${input.canvasId}\u0000${input.nodeId}\u0000${input.requestId}`;
}
