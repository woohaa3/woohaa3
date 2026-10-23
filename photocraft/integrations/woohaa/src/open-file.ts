/**
 * 独立文件打开的类型与校验（纯逻辑）
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 3.1 / design D2；
 *  栅格格式扩充见 change: 2026-10-22-add-photocraft-raster-interchange，任务 3.4）。
 *
 * Woohaa 的“打开文件”入口接受内核矩阵里**可打开**的栅格格式与受支持的 `.pcraft`：
 * - 可编辑打开的栅格（PNG/JPEG/TIFF/WebP/GIF/BMP/TGA/ICO/QOI/PNM…）→ 以原图为背景层开新工程；
 * - 只读交换格式（PCX/XPM/DDS）→ 同样可建成可编辑文档，但不写回该扩展名；
 * - `.pcraft` → 直接打开已核验工程；过新/不支持的引擎或格式版本明确拒绝，**不**压平成图片；
 * - PSD/PSB 等其他分层格式仍不开放（不通过内核通配 `file.*` 或“图片置入”路径进入）。
 *
 * 格式清单唯一权威是 `@woohaa3/photocraft-protocol` 的 `OPEN_RASTER_*`：它与内核矩阵同源，
 * 并由本 change 的真实 WASM 用例（`wasm-integration.test.ts`）断言两边逐项一致。
 * 这里不再自己维护第二份扩展名/MIME 表。
 *
 * 本模块不读文件、不访问内核：`classifyOpenFile` 只按文件名与 MIME 判定候选类型，
 * 供插件与测试共用同一口径。
 */
import { SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS, SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS, decodeImageEditDocument, isImageProjectDocument } from "@woohaa3/contracts";
import { OPEN_RASTER_ACCEPT, OPEN_RASTER_EXTENSIONS, OPEN_RASTER_MIMES } from "@woohaa3/photocraft-protocol";

/** 打开文件的候选类型。 */
export type OpenFileKind = "image" | "project";

export type OpenFileClassification =
  | { ok: true; kind: OpenFileKind }
  | { ok: false; reason: string };

/** 受支持的位图 MIME（唯一权威：协议域的 `OPEN_RASTER_MIMES`，与内核矩阵同源）。 */
const IMAGE_TYPES = new Set<string>(OPEN_RASTER_MIMES);

/** 明确不开放的分层格式（给出具体原因，而不是泛泛的“不支持”）。 */
const LAYERED_FORMATS = [
  { extensions: [".psd"], label: "PSD" },
  { extensions: [".psb"], label: "PSB" }
] as const;

/** 工程扩展名（`.pcraft`，大小写不敏感）。 */
export const PROJECT_EXTENSION = ".pcraft";

/**
 * 打开文件选择器的 `accept` 值。
 *
 * 栅格部分来自协议域的 `OPEN_RASTER_ACCEPT`（= 内核矩阵里可打开的行），再补工程与
 * octet-stream 兜底。这样新增格式只在内核/协议改一次，宿主自然同步。
 */
export const OPEN_FILE_ACCEPT = `${OPEN_RASTER_ACCEPT},${PROJECT_EXTENSION},application/octet-stream`;

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

/** 按文件名/MIME 判定候选类型；不读内容、不访问内核。 */
export function classifyOpenFile(input: { name: string; type?: string | null }): OpenFileClassification {
  const name = input.name.trim();
  if (!name) return { ok: false, reason: "未选择文件" };
  const extension = extensionOf(name);
  const layered = LAYERED_FORMATS.find((format) => (format.extensions as readonly string[]).includes(extension));
  if (layered) {
    return { ok: false, reason: `暂不支持 ${layered.label} 分层格式，可在外部导出为 PNG/JPEG/WebP 后再打开` };
  }
  if (extension === PROJECT_EXTENSION) return { ok: true, kind: "project" };
  const type = (input.type ?? "").toLowerCase();
  if (IMAGE_TYPES.has(type)) return { ok: true, kind: "image" };
  // 部分环境不提供 MIME：按扩展名兜底，但只认内核矩阵里可打开的栅格。
  if (OPEN_RASTER_EXTENSIONS.some((candidate) => `.${candidate}` === extension)) return { ok: true, kind: "image" };
  return { ok: false, reason: "只支持内核矩阵里可打开的栅格格式与受支持的 .pcraft 工程" };
}

/** 工程版本的受支持判定（过新/未知引擎都拒绝，不做降级压平）。 */
export function projectVersionSupported(document: { engineVersion: string; formatVersion: number }): boolean {
  return SUPPORTED_PHOTOCRAFT_ENGINE_VERSIONS.includes(document.engineVersion)
    && SUPPORTED_PHOTOCRAFT_FORMAT_VERSIONS.includes(document.formatVersion);
}

export type OpenProjectDocumentResult =
  | { ok: true; kind: "project" }
  | { ok: false; reason: string };

/**
 * 校验一份“结构上像工程”的定义是否可打开。
 *
 * 只接受受支持的引擎/格式版本；旧 v1 标注与任意其它 JSON 都不是 `.pcraft`，返回明确原因。
 */
export function validateOpenProjectDocument(value: unknown): OpenProjectDocumentResult {
  const decoded = decodeImageEditDocument(value);
  if (!decoded.ok) return { ok: false, reason: "该文件不是受支持的 .pcraft 工程" };
  if (!isImageProjectDocument(decoded.value)) {
    return { ok: false, reason: "该文件是旧标注定义，不是可编辑的 .pcraft 工程" };
  }
  if (!projectVersionSupported(decoded.value)) {
    return { ok: false, reason: "工程版本过新或引擎不匹配，无法编辑（可继续查看原工程文件）" };
  }
  return { ok: true, kind: "project" };
}
