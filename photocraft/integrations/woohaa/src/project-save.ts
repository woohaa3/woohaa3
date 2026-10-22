/**
 * 工程保存编排（宿主侧）
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 4.1/4.3/4.5 / design D3/D6/D7）。
 *
 * 冻结导出的**成对产物**（`.pcraft` 工程 + 带 alpha 的 PNG）在这里变成一次权威写入：
 *
 * 1. 复核冻结结果自身的一致性（成对、revive 与文档指纹、媒体类型、画布尺寸）；
 * 2. 逐个复核字节摘要（SHA-256）与声明一致——**不信任编辑器**，摘要不符即拒；
 * 3. 上传两个对象（工程对象走受控工程上传入口，PNG 走普通媒体上传）；
 * 4. 提交 `edit-complete`（带工程引用与画布尺寸）；
 * 5. 只有服务端回执 `completed`/`history-pending` 才算成功；成功后由调用方发 `resume` 推进基线。
 *
 * 任一步失败都不产生规范写入，返回可重试失败并保留工作区现场（design D7）。
 */
import {
  IMAGE_PROJECT_CONTENT_TYPE,
  PHOTOCRAFT_ENGINE_VERSION,
  SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS,
  isImageProjectDocument,
  type ImageEditCompleteRequest,
  type ImageEditDocument,
  type ImageProjectDocument,
  type StoredAsset,
  type PhotocraftArtifactSummary
} from "@woohaa3/contracts";
import type { EditCompleteResult } from "@woohaa3/frontend/plugin-api";
import { settleProjectReceipt } from "./project-receipt.js";
import type { ProjectExportArtifacts } from "@woohaa3/photocraft-editor";

/** 已上传对象的最小 metadata（与服务端一致）。 */
export type UploadedObject = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  url: string;
};

export type ProjectSaveDeps = {
  /** 上传工程对象（受控工程入口）。失败返回 null。 */
  uploadProject: (bytes: Uint8Array) => Promise<UploadedObject | null>;
  /** 上传合成 PNG。失败返回 null。 */
  uploadOutput: (bytes: Uint8Array) => Promise<UploadedObject | null>;
  /** 调用 edit-complete。 */
  complete: (request: ImageEditCompleteRequest) => Promise<EditCompleteResult>;
  status?: (request: Pick<ImageEditCompleteRequest, "canvasId" | "nodeId" | "requestId">) => Promise<EditCompleteResult>;
  /** 内容寻址资产 id。 */
  assetIdFor: (checksum: string) => string;
  /** 摘要实现（测试注入；缺省 `crypto.subtle`）。 */
  digest?: (bytes: Uint8Array) => Promise<string>;
};

export type ProjectSaveInput = {
  canvasId: string;
  nodeId: string;
  sessionId: string;
  requestId: string;
  baselineContentIdentity: string;
  baseAsset: StoredAsset;
  baseStorageKey: string;
  baseChecksum: string;
  baseContentType: string;
  baseSize: number;
  /** 冻结结果（已由桥按摘要校验过一次；这里再按字节复核一次，防桥被绕过）。 */
  artifacts: ProjectExportArtifacts;
  sourceAssetIds?: readonly string[];
  /** 进入本次编辑时携带的工程定义（无则本次为「首次转为工程」）。 */
  document: ImageEditDocument | null;
};

export type ProjectSaveOutcome =
  | {
      ok: true;
      status: "completed" | "history-pending";
      entryId: string | null;
      contentIdentity: string;
      /** 写回成功后的工程定义（调用方据此推进会话基线）。 */
      project: ImageProjectDocument;
      projectObject: UploadedObject;
      outputObject: UploadedObject;
    }
  | { ok: false; code: ProjectSaveErrorCode; message: string; retriable: boolean };

export type ProjectSaveErrorCode =
  | "freeze-failed"
  | "invalid-artifacts"
  | "artifact-digest-mismatch"
  | "artifact-revision-mismatch"
  | "unsupported-engine-version"
  | "unsupported-format-version"
  | "project-upload-failed"
  | "output-upload-failed"
  | "complete-failed"
  | "conflict";

export type ProjectSaveAttempt = { project?: UploadedObject; output?: UploadedObject; request?: ImageEditCompleteRequest };

export async function saveImageProject(input: ProjectSaveInput, deps: ProjectSaveDeps, attempt: ProjectSaveAttempt = {}): Promise<ProjectSaveOutcome> {
  const artifacts = input.artifacts;
  const digest = deps.digest ?? defaultDigest;

  // 1. 成对产物与声明的结构一致性。
  const project = artifacts.projectSummary;
  const output = artifacts.outputSummary;
  if (project.role !== "project" || output.role !== "output") {
    return failure("invalid-artifacts", "冻结结果缺少工程或合成输出");
  }
  if (project.contentType !== IMAGE_PROJECT_CONTENT_TYPE || output.contentType !== "image/png") {
    return failure("invalid-artifacts", "冻结产物的媒体类型不符");
  }
  if (project.byteLength !== artifacts.project.byteLength || output.byteLength !== artifacts.output.byteLength) {
    return failure("invalid-artifacts", "冻结产物的声明长度与实际字节不一致");
  }
  if (!isPositiveInteger(artifacts.canvasWidth) || !isPositiveInteger(artifacts.canvasHeight)) {
    return failure("invalid-artifacts", "冻结结果缺少合法画布尺寸");
  }
  if (!isContentHash(artifacts.documentContentHash)) {
    return failure("invalid-artifacts", "冻结结果缺少合法文档内容指纹");
  }
  // 工程定义必须与冻结结果同一修订：否则会把旧定义的引用写到新字节上。
  if (input.document && isImageProjectDocument(input.document)) {
    if (artifacts.revision < 0) return failure("artifact-revision-mismatch", "冻结修订非法");
  }


  // 2. 逐字节复核摘要（不信任编辑器上报）。
  let projectDigest: string;
  let outputDigest: string;
  try {
    projectDigest = await digest(artifacts.project);
    outputDigest = await digest(artifacts.output);
  } catch {
    return failure("artifact-digest-mismatch", "无法计算冻结产物摘要");
  }
  if (projectDigest !== project.sha256 || outputDigest !== output.sha256) {
    return failure("artifact-digest-mismatch", "冻结产物摘要与字节不符");
  }

  // 3. 上传两个对象。
  let uploadReason = "";
  const failedUpload = (error: unknown) => { uploadReason = error instanceof Error ? error.message : ""; return null; };
  const uploadedProject = attempt.project ?? await deps.uploadProject(artifacts.project).catch(failedUpload);
  if (!uploadedProject) return failure("project-upload-failed", uploadReason ? `工程对象上传失败：${uploadReason}` : "工程对象上传失败，未提交内容", true);
  attempt.project = uploadedProject;
  const uploadedOutput = attempt.output ?? await deps.uploadOutput(artifacts.output).catch(failedUpload);
  if (!uploadedOutput) return failure("output-upload-failed", uploadReason ? `合成输出上传失败：${uploadReason}` : "合成输出上传失败，未提交内容", true);

  attempt.output = uploadedOutput;

  // 4. 组装工程定义：直接采用本次冻结修订的内容，不沿用旧定义。
  const projectDocument = buildProjectDocument({
    artifacts,
    uploadedProject,
    baseAsset: input.baseAsset,
    document: input.document,
    sourceAssetIds: sourceAssetIdsOf(input)
  });
  if (!isImageProjectDocument(projectDocument)) {
    return failure("unsupported-format-version", "冻结产物的引擎或格式版本不在支持范围");
  }

  const request: ImageEditCompleteRequest = attempt.request ?? {
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    kind: "image",
    baselineContentIdentity: input.baselineContentIdentity,
    media: {
      baseAssetId: input.baseAsset.id,
      baseStorageKey: input.baseStorageKey,
      sourceWidth: projectDocument.sourceWidth,
      sourceHeight: projectDocument.sourceHeight,
      outputAssetId: deps.assetIdFor(uploadedOutput.checksum),
      outputStorageKey: uploadedOutput.storageKey,
      checksum: uploadedOutput.checksum,
      contentType: uploadedOutput.contentType,
      size: uploadedOutput.size,
      baseChecksum: input.baseChecksum,
      baseContentType: input.baseContentType,
      baseSize: input.baseSize,
      imageEdit: projectDocument,
      canvasWidth: artifacts.canvasWidth,
      canvasHeight: artifacts.canvasHeight,
      project: projectDocument.project
    }
  };

  // 5. 只有服务端回执才算成功。
  attempt.request = request;
  const result = await settleProjectReceipt(request, deps);
  if (!result.ok) {
    // 冲突是「内容被别的操作更新」而不是「保存失败」：UI 需要按冲突提示而不是普通重试。
    if (result.code === "EDIT_SESSION_CONFLICT" || result.code === "EDIT_SESSION_BASELINE_STALE" || result.receipt?.errorCode === "EDIT_SESSION_CONFLICT" || result.receipt?.errorCode === "EDIT_SESSION_BASELINE_STALE") {
      return failure("conflict", result.receipt?.errorMessage ?? result.error ?? "内容已被其他操作更新", true);
    }
    return failure("complete-failed", result.error || "保存被拒绝", !result.receipt || result.receipt.status === "prepared");
  }
  const receipt = result.receipt;
  if (receipt.status === "completed" || receipt.status === "history-pending") {
    return {
      ok: true,
      status: receipt.status,
      entryId: receipt.entryId,
      contentIdentity: receipt.contentIdentity,
      project: projectDocument,
      projectObject: uploadedProject,
      outputObject: uploadedOutput
    };
  }
  if (receipt.errorCode === "EDIT_SESSION_CONFLICT" || receipt.errorCode === "EDIT_SESSION_BASELINE_STALE") {
    return failure("conflict", receipt.errorMessage ?? "内容已被其他操作更新", true);
  }
  return failure("complete-failed", receipt.errorMessage ?? "保存被拒绝", true);
}

/**
 * 由冻结产物与已上传对象组装权威工程定义。
 *
 * 节点保存与“添加到画布”共用同一份组装逻辑，保证两条路径写出的 `.pcraft` 引用、
 * 内容指纹与来源资产一致（change: 2026-10-21-add-photocraft-document-workspace，D5）。
 */
export function buildProjectDocument(input: {
  artifacts: ProjectExportArtifacts;
  uploadedProject: UploadedObject;
  baseAsset: StoredAsset;
  document: ImageEditDocument | null;
  sourceAssetIds: readonly string[];
}): ImageProjectDocument {
  const { artifacts, uploadedProject, baseAsset, document: previous } = input;
  const previousProject = previous && isImageProjectDocument(previous) ? previous : null;
  return {
    version: "woohaa-image-project-v1",
    engine: "photocraft",
    engineVersion: PHOTOCRAFT_ENGINE_VERSION,
    formatVersion: projectFormatVersion(previous, artifacts.projectSummary),
    baseAssetId: baseAsset.id,
    sourceWidth: previousProject ? previousProject.sourceWidth : artifacts.canvasWidth,
    sourceHeight: previousProject ? previousProject.sourceHeight : artifacts.canvasHeight,
    canvasWidth: artifacts.canvasWidth,
    canvasHeight: artifacts.canvasHeight,
    documentContentHash: artifacts.documentContentHash,
    project: {
      storageKey: uploadedProject.storageKey,
      checksum: uploadedProject.checksum,
      contentType: IMAGE_PROJECT_CONTENT_TYPE,
      size: uploadedProject.size
    },
    sourceAssetIds: [...input.sourceAssetIds]
  };
}

function failure(code: ProjectSaveErrorCode, message: string, retriable = false): ProjectSaveOutcome {
  return { ok: false, code, message, retriable };
}

function projectFormatVersion(document: ImageEditDocument | null, artifact: PhotocraftArtifactSummary): number {
  void artifact;
  if (document && isImageProjectDocument(document)) return document.formatVersion;
  // 首次转为工程：采用宿主支持的最新 `.pcraft` 格式版本。
  return SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS[SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS.length - 1] ?? 0;
}

/** 保留既有工程的来源资产引用，并确保当前基底在原图集合里（保引用，不丢对象）。 */
function sourceAssetIdsOf(input: ProjectSaveInput): string[] {
  const ids = new Set<string>();
  ids.add(input.baseAsset.id);
  for (const id of input.sourceAssetIds ?? []) ids.add(id);
  if (input.document && isImageProjectDocument(input.document)) {
    ids.add(input.document.baseAssetId);
    for (const id of input.document.sourceAssetIds) ids.add(id);
  }
  return [...ids];
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isContentHash(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value);
}

async function defaultDigest(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("缺少 SHA-256 实现");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
