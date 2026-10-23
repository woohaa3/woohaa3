/**
 * 媒体写入策略与内容寻址 ingest（change: split-web-runtime-services，任务 3.1）。
 *
 * 从 `apps/site/server/media.ts` 迁入 Media Service。键形态与允许类型来自 `contracts`
 * （跨边界事实），这里只保留**媒体写入策略**：
 * - 对象键只由内容决定（SHA-256），相同 bytes 天然幂等；
 * - 先校验、再上传，COS put 成功后才返回 metadata；
 * - 失败时不产生可提交的 asset。
 */
import { ALLOWED_MEDIA_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  IMAGE_PROJECT_CONTENT_TYPE,
  IMAGE_PROJECT_LIMITS,
  computeGeneratedStorageKey,
  computeStorageKey,
  isAllowedMediaType,
  normalizeMediaType } from "@woohaa3/contracts";
import type { MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import {
  ProjectVerificationError,
  createProcessOnlyVerifier,
  inspectEmbeddedPhotocraftProject,
  type NativeProjectVerifier
} from "@woohaa3/photocraft-project-verifier";

/**
 * 默认核验实例：只做进程内有界核验。
 *
 * change: 2026-10-21-extract-photocraft-subproject，任务 3.2 / design D5：核验能力迁入
 * PhotoCraft 后，Media 的**接收政策**（上传路由、认证、部署上限、内容寻址、错误映射、
 * 引用保留）仍在这里，只把「核验实现」换成公共入口。生产装配会注入服务实例自己的
 * `createNativeProjectVerifier()`；未注入时保持迁移前的默认行为。
 */
const DEFAULT_VERIFIER: NativeProjectVerifier = createProcessOnlyVerifier();

/**
 * 工程保存的核验通道。
 *
 * 先按**普通上传口径**核验：不含智能对象的工程行为完全不变，任何既有拒绝原因原样返回。
 *
 * 只有「因为含嵌入智能对象而被拒」时，才改用专用于含源工程的通道：先用
 * `inspectEmbeddedPhotocraftProject` 做外层有界结构检查（它只放开 `smart` 这一种对象类型，
 * 填充/形状/画板/智能滤镜/外链/坏名称/不可逆仿射继续拒绝），再要求原生核验工具对整棵源树
 * 复核同一预算并校对根摘要（`verifyEmbeddedForIngest` 在原生不可用时**失败**，不回退）。
 *
 * 为什么必须放行这一条：U66「转回图层」只解包当前实例，同工程里其他共享实例仍是智能对象
 * （spec 的成功证据要求「其他共享实例不变」）。若保存入口整体拒绝这类工程，编辑结果在
 * Woohaa 里根本存不下来。放行范围严格限于「嵌入智能对象」，且仍以原生全树核验为前置。
 */
async function verifyProjectForSave(
  verifier: NativeProjectVerifier,
  bytes: Uint8Array,
  options: { maxBytes?: number }
): Promise<void> {
  try {
    await verifier.verifyForIngest(bytes, IMAGE_PROJECT_CONTENT_TYPE, options);
    return;
  } catch (error) {
    // 不是「含智能对象」的拒绝：保持原有失败语义，不做任何回退。
    if (!(error instanceof ProjectVerificationError) || error.code !== "unsupported-object") throw error;
    const summary = inspectEmbeddedPhotocraftProject(bytes, options);
    if (!summary.objectKinds.includes("smart")) throw error;
  }
  await verifier.verifyEmbeddedForIngest(bytes, IMAGE_PROJECT_CONTENT_TYPE, options);
}

export { ALLOWED_MEDIA_TYPES, DEFAULT_MAX_UPLOAD_BYTES };

/** 稳定拒绝原因（跨进程按字符串判定，测试与 UI 共用）。 */
export type MediaIngestErrorCode =
  | "empty-payload"
  | "payload-too-large"
  | "unsupported-media-type"
  | "invalid-storage-key"
  /** 工程 MIME 只允许走专用 ingest；普通上传不得绕过核验。 */
  | "project-requires-verification"
  | "project-verification-failed";

export class MediaIngestError extends Error {
  readonly code: MediaIngestErrorCode;

  constructor(code: MediaIngestErrorCode, message: string) {
    super(message);
    this.name = "MediaIngestError";
    this.code = code;
  }
}

/** HTTP 状态码映射；集中在这里，避免每个路由各写一遍。 */
export function mediaErrorStatus(code: MediaIngestErrorCode): number {
  switch (code) {
    case "payload-too-large":
      return 413;
    case "unsupported-media-type":
      return 415;
    case "project-requires-verification":
    case "project-verification-failed":
      return 422;
    case "empty-payload":
    case "invalid-storage-key":
      return 400;
  }
}

export { computeStorageKey, computeGeneratedStorageKey, normalizeMediaType };

/** Web Crypto 在 Node 20+ 与浏览器都可用。 */
export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes).buffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 同源读取地址；Canvas asset 的 `url` 只保存它，不保存临时签名 URL。 */
export function mediaObjectUrl(storageKey: string, basePath = "/api/media"): string {
  return `${basePath.replace(/\/$/, "")}/${storageKey}`;
}

export type MediaIngestResult = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
  url: string;
  deduplicated: boolean;
};

export type IngestMediaOptions = {
  storage: MediaStorage;
  bytes: Uint8Array;
  contentType: string;
  basePath?: string;
  maxBytes?: number;
  allowedTypes?: readonly string[];
  computeChecksum?: (bytes: Uint8Array) => Promise<string>;
  /**
   * 受控工程 ingest 开关（change: 2026-10-16-integrate-photocraft-image-editing）。
   *
   * 只有专用工程入口可置 true；普通媒体上传即使改 MIME 也拿不到核验，必须被拒绝。
   */
  projectIngest?: boolean;
  /**
   * 这次写入属于哪张画布（可选）。媒体服务只透传、不解释路由；缺省与旧版一致，
   * 写入当前主存储。
   */
  scope?: MediaStorageScope;
  /**
   * 核验实例（change: 2026-10-21-extract-photocraft-subproject，任务 3.2）。
   *
   * 由服务装配注入自己的可释放实例，使并发额度与关闭语义按服务实例隔离；缺省用只做
   * 进程内有界核验的默认实例，与迁移前的「未配置原生工具」路径一致。
   */
  verifier?: NativeProjectVerifier;
};

/**
 * 校验 + 内容寻址 + 写入。只有 `put` 成功返回后才返回 metadata。
 */
export async function ingestMediaObject(options: IngestMediaOptions): Promise<MediaIngestResult> {
  const contentType = normalizeMediaType(options.contentType);
  const allowed = options.allowedTypes ?? ALLOWED_MEDIA_TYPES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  if (options.bytes.byteLength === 0) {
    throw new MediaIngestError("empty-payload", "上传内容为空");
  }
  // 工程 MIME 不能被普通上传使用：必须先经过有界内容核验（spec canvas-media-storage）。
  if (contentType === IMAGE_PROJECT_CONTENT_TYPE && !options.projectIngest) {
    throw new MediaIngestError("project-requires-verification", "工程对象必须经专用核验入口上传");
  }
  if (options.bytes.byteLength > maxBytes) {
    throw new MediaIngestError(
      "payload-too-large",
      `上传内容超过上限：${options.bytes.byteLength} > ${maxBytes}`
    );
  }
  if (options.projectIngest) {
    if (contentType !== IMAGE_PROJECT_CONTENT_TYPE) {
      throw new MediaIngestError("unsupported-media-type", `专用工程入口只接受 ${IMAGE_PROJECT_CONTENT_TYPE}`);
    }
    try {
      await verifyProjectForSave(options.verifier ?? DEFAULT_VERIFIER, options.bytes, {
        maxBytes: Math.min(maxBytes, IMAGE_PROJECT_LIMITS.maxProjectBytes)
      });
    } catch (error) {
      const reason = error instanceof ProjectVerificationError ? `${error.code}: ${error.message}` : "工程核验失败";
      throw new MediaIngestError("project-verification-failed", reason);
    }
  } else if (!isAllowedMediaType(contentType, allowed)) {
    throw new MediaIngestError("unsupported-media-type", `不支持的媒体类型：${contentType || "(空)"}`);
  }

  const checksum = await (options.computeChecksum ?? computeSha256Hex)(options.bytes);
  const storageKey = computeStorageKey(checksum);

  const exists = await options.storage.exists(storageKey, options.scope);
  if (!exists) {
    await options.storage.put(storageKey, options.bytes, contentType, options.scope);
  }

  return {
    storageKey,
    checksum,
    contentType,
    size: options.bytes.byteLength,
    url: mediaObjectUrl(storageKey, options.basePath),
    deduplicated: exists
  };
}
