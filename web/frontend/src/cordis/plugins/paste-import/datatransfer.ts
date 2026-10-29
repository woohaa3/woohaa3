/**
 * DataTransfer 文件提取与去重
 * （change: add-paste-import-workflows，任务 2.1 / 2.2 / design D3）。
 *
 * 纯函数（可在无 DOM 环境下用结构替身单测）：
 * 1. 合并 `DataTransfer.files` 与 kind 为 `file` 的 `DataTransferItem.getAsFile()`；
 * 2. 按「同一对象引用 + name/type/size/lastModified」做 metadata 初筛；
 * 3. 在 Web Crypto 可用且单文件/总字节不超过阈值时按 SHA-256 内容去重。
 *
 * 命中内容 hash 时以内容为准：metadata 相同但 hash 不同不会被误删；hash 不可用或失败时
 * 保留候选，交由 Media Service 内容寻址收敛。去重只作用于**同一次**请求。
 */
import { ALLOWED_MEDIA_TYPES, GLB_MEDIA_TYPE, isGlbFile, mediaKindForType, normalizeMediaType, uploadedMediaKind } from "@woohaa3/contracts";

/** 粘贴/拖放支持的文件类别（与上传白名单一致）。 */
export type PasteFileKind = "image" | "video" | "audio" | "text" | "model3d";

export type ClassifiedFile = {
  /** 浏览器 File 的结构子集（便于单测传字面量）。 */
  file: File;
  kind: PasteFileKind;
  name: string;
  type: string;
  size: number;
  lastModified: number;
};

export type RejectedTransferFile = {
  name: string;
  reason: string;
};

export type ExtractedTransferFiles = {
  files: ClassifiedFile[];
  rejected: RejectedTransferFile[];
};

/** 计算内容 hash 的单文件与总字节阈值（超过只做 metadata 去重）。 */
export const HASH_SINGLE_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const HASH_TOTAL_MAX_BYTES = 64 * 1024 * 1024;

const ALLOWED_TYPE_SET = new Set<string>(ALLOWED_MEDIA_TYPES);

/** 从文件三要素判定支持的类别；不支持（目录、二进制、零字节）返回 `null`。 */
export function classifyPasteFile(file: { name: string; type: string; size: number }): PasteFileKind | null {
  const name = (file.name || "").trim();
  if (name === "") return null;
  // 目录在多数浏览器表现为 size 0 且无 MIME；明确拒绝零字节文件（spec「零字节」）。
  if (file.size <= 0) return null;
  // GLB 文件模型（change: 2026-10-28-support-glb-model-nodes）：扩展名优先，`.gltf` 拒绝。
  if (isGlbFile(file)) return "model3d";
  const type = normalizeMediaType(file.type);
  if (ALLOWED_TYPE_SET.has(type)) {
    const kind = mediaKindForType(type);
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "text") return kind;
    return null;
  }
  // 浏览器可能不提供 MIME（例如 .md）：回退到扩展名推断，再要求落入受支持类别。
  const inferred = uploadedMediaKind({ name, type });
  if (inferred === "image" || inferred === "video" || inferred === "audio" || inferred === "text") {
    return inferred;
  }
  return null;
}

/**
 * 仅凭 MIME 类型判定是否可能受支持（dragover 阶段用）。
 *
 * `dragover` 时浏览器**不暴露**文件内容：`DataTransfer.files` 为空且
 * `item.getAsFile()` 返回 null，只有 `item.kind` 与 `item.type`（MIME）可用。因此这里
 * 只做 MIME 判定，不能依赖 `classifyPasteFile`（它需要 name/size）。
 *
 * 空 MIME 视为「可能」（目录、无扩展名文件在 dragover 阶段的 type 就是空串），
 * 真正的拒绝交给 drop 阶段的分类（零字节/不支持类型）。
 */
export function isSupportedMimeType(mime: string | null | undefined): boolean {
  const type = normalizeMediaType(mime ?? "");
  if (type === "") return true;
  if (type === GLB_MEDIA_TYPE) return true;
  if (ALLOWED_TYPE_SET.has(type)) {
    const kind = mediaKindForType(type);
    return kind === "image" || kind === "video" || kind === "audio" || kind === "text";
  }
  // 非白名单 MIME：保守拒绝（避免对可执行文件显示 drop 反馈）。
  return false;
}

/** 合并 files 与 file items；同一对象引用只保留一次。 */
export function collectTransferFiles(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  const out: File[] = [];
  const seen = new Set<File>();
  const push = (file: File | null | undefined) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    out.push(file);
  };
  const files = transfer.files;
  if (files) {
    for (let index = 0; index < files.length; index += 1) push(files.item(index));
  }
  const items = transfer.items;
  if (items) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item || item.kind !== "file") continue;
      try {
        push(item.getAsFile());
      } catch {
        // 某些浏览器在 item 被消费后抛错；忽略该表示，不阻断其它文件。
      }
    }
  }
  return out;
}

export type DedupeOptions = {
  /** 注入的 Web Crypto（缺省 globalThis.crypto.subtle）；不可用时跳过内容 hash。 */
  subtle?: { digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer> };
  /** 内容 hash 阈值覆盖（测试用）。 */
  hashSingleMaxBytes?: number;
  hashTotalMaxBytes?: number;
};

/**
 * 同步分类：合并 files/items，按 metadata 初筛，得到受支持文件与拒绝项。
 *
 * 这一阶段不读文件内容，因此可在 paste/drop 事件同步阶段调用（用于 claim 判定）。
 */
export function classifyTransferFiles(transfer: DataTransfer | null | undefined): ExtractedTransferFiles {
  const raw = collectTransferFiles(transfer);
  const files: ClassifiedFile[] = [];
  const rejected: RejectedTransferFile[] = [];

  for (const file of raw) {
    const kind = classifyPasteFile(file);
    if (!kind) {
      rejected.push({ name: file.name || "(未命名文件)", reason: rejectionReason(file) });
      continue;
    }
    const entry: ClassifiedFile = {
      file,
      kind,
      name: file.name,
      type: normalizeMediaType(file.type),
      size: file.size,
      lastModified: file.lastModified
    };
    if (!files.some((candidate) => sameMetadata(candidate, entry))) files.push(entry);
  }
  return { files, rejected };
}

/** 对普通 File 列表做与 transfer 同口径的分类 + metadata 初筛（供 picker/paste 复用）。 */
export function classifyFileList(files: readonly File[]): ExtractedTransferFiles {
  const out: ClassifiedFile[] = [];
  const rejected: RejectedTransferFile[] = [];
  for (const file of files) {
    const kind = classifyPasteFile(file);
    if (!kind) {
      rejected.push({ name: file.name || "(未命名文件)", reason: rejectionReason(file) });
      continue;
    }
    const entry: ClassifiedFile = {
      file,
      kind,
      name: file.name,
      type: normalizeMediaType(file.type),
      size: file.size,
      lastModified: file.lastModified
    };
    if (!out.some((candidate) => sameMetadata(candidate, entry))) out.push(entry);
  }
  return { files: out, rejected };
}

/**
 * 异步内容去重：只对仍可能重复的候选按 SHA-256 收敛（阈值与可用性见 `dedupeByContent`）。
 */
export function dedupeClassifiedFiles(
  files: readonly ClassifiedFile[],
  options: DedupeOptions = {}
): Promise<ClassifiedFile[]> {
  return dedupeByContent(files, options);
}

/**
 * 从一次 paste/drop 的 DataTransfer 提取受支持文件并完成两级去重。
 * 目录、零字节与不支持类型进入 `rejected`。
 */
export async function extractTransferFiles(
  transfer: DataTransfer | null | undefined,
  options: DedupeOptions = {}
): Promise<ExtractedTransferFiles> {
  const { files, rejected } = classifyTransferFiles(transfer);
  const deduped = await dedupeClassifiedFiles(files, options);
  return { files: deduped, rejected };
}

function rejectionReason(file: { name: string; type: string; size: number }): string {
  if (file.size <= 0) return "零字节文件不受支持";
  return "不支持的文件类型";
}

function sameMetadata(a: ClassifiedFile, b: ClassifiedFile): boolean {
  return a.name === b.name && a.type === b.type && a.size === b.size && a.lastModified === b.lastModified;
}

/**
 * 内容级去重。
 *
 * 只有当注入/全局 Web Crypto 可用、单文件与总字节都在阈值内时才对候选计算 SHA-256；
 * 任何失败都保留候选（宁多勿误删），最终由 Media Service 内容寻址收敛。
 */
async function dedupeByContent(
  files: readonly ClassifiedFile[],
  options: DedupeOptions
): Promise<ClassifiedFile[]> {
  if (files.length < 2) return [...files];
  const subtle =
    options.subtle ??
    (globalThis.crypto && "subtle" in globalThis.crypto
      ? (globalThis.crypto.subtle as unknown as DedupeOptions["subtle"])
      : undefined);
  if (!subtle) return [...files];

  const singleMax = options.hashSingleMaxBytes ?? HASH_SINGLE_FILE_MAX_BYTES;
  const totalMax = options.hashTotalMaxBytes ?? HASH_TOTAL_MAX_BYTES;
  const total = files.reduce((sum, entry) => sum + entry.size, 0);
  if (total > totalMax) return [...files];

  const hashes = await Promise.all(
    files.map(async (entry) => {
      if (entry.size > singleMax) return null;
      try {
        const bytes = await entry.file.arrayBuffer();
        const digest = await subtle.digest("SHA-256", bytes);
        return toHex(new Uint8Array(digest));
      } catch {
        return null;
      }
    })
  );

  const out: ClassifiedFile[] = [];
  const seenHashes = new Set<string>();
  files.forEach((entry, index) => {
    const hash = hashes[index];
    if (hash) {
      if (seenHashes.has(hash)) return;
      seenHashes.add(hash);
    }
    out.push(entry);
  });
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** `DataTransfer` 是否包含可接受的本地文件（dragover 反馈用；只看 types，不读内容）。 */
export function transferMentionsFiles(transfer: DataTransfer | null | undefined): boolean {
  if (!transfer) return false;
  const types = transfer.types;
  if (!types) return false;
  const list = Array.from(types as ArrayLike<string>);
  return list.includes("Files");
}
