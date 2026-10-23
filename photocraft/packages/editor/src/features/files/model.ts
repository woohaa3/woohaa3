/**
 * 本域界面模型：只把内核 JSON 解码成有界、可渲染的数据
 * （change: 2026-10-22-add-photocraft-file-workflows，U01–U04）。
 *
 * 规则：
 * - 内核返回的每个值都重新校验（尺寸、上限、字段名），不因为「刚写过」就信任响应；
 * - 结构非法时返回 `{ok:false}`，界面显示「无法读取…」而不是渲染半截数据；
 * - 不复制文档模型：这里只有新建参数、预设/最近条目、File Info 与恢复报告。
 */
import {
  FILE_INFO_FIELDS,
  FILE_INFO_LIMITS,
  NEW_DOCUMENT_LIMITS,
  canReplayDocumentSpec,
  normalizePresetName,
  validateFileInfoPatch,
  validateNewDocumentSpec,
  type FileInfo,
  type FileInfoField,
  type NewDocumentSpec
} from "@woohaa3/photocraft-protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 内核 `file.new` 报告（`createDocument` 的返回）。 */
export type CreateDocumentReport = {
  name: string;
  width: number;
  height: number;
  resolution: number;
  background: string;
  /** 内核状态里实际文档名（与请求名可能不同，例如去空白后）。 */
  documentName: string;
  /** 最近设置是否记录成功（簿记失败不影响已创建的文档）。 */
  recentRecorded: boolean;
};

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; error: string };

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 解码新建报告：尺寸/分辨率必须与内核真实状态一致。 */
export function decodeCreateDocumentReport(raw: unknown): DecodeResult<CreateDocumentReport> {
  if (!isRecord(raw)) return { ok: false, error: "新建结果不是对象" };
  const state = isRecord(raw.state) ? raw.state : null;
  const document = state && isRecord(state.document) ? state.document : null;
  const width = numberOf(raw.width);
  const height = numberOf(raw.height);
  const resolution = numberOf(raw.resolution);
  if (width === null || height === null || resolution === null) {
    return { ok: false, error: "新建结果缺少尺寸或分辨率" };
  }
  if (document) {
    const actualWidth = numberOf(document.width);
    const actualHeight = numberOf(document.height);
    if (actualWidth !== width || actualHeight !== height) {
      return { ok: false, error: "新建结果与内核文档尺寸不一致" };
    }
  }
  return {
    ok: true,
    value: {
      name: typeof raw.name === "string" ? raw.name : "未命名",
      width,
      height,
      resolution,
      background: typeof raw.background === "string" ? raw.background : "white",
      documentName: document && typeof document.name === "string" ? document.name : typeof raw.name === "string" ? raw.name : "未命名",
      recentRecorded: raw.recentRecorded === true
    }
  };
}

/** 内核 `createDocumentFromImage` 报告。 */
export type CreateFromImageReport = { name: string; width: number; height: number; warnings: readonly string[] };

export function decodeCreateFromImageReport(raw: unknown): DecodeResult<CreateFromImageReport> {
  if (!isRecord(raw)) return { ok: false, error: "新建结果不是对象" };
  const width = numberOf(raw.width);
  const height = numberOf(raw.height);
  if (width === null || height === null || width < 1 || height < 1) {
    return { ok: false, error: "图片尺寸无效" };
  }
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter((item): item is string => typeof item === "string") : [];
  return {
    ok: true,
    value: { name: typeof raw.name === "string" ? raw.name : "剪贴板图像", width, height, warnings }
  };
}

/** 引擎的预设/最近设置条目 → 本域规范设置；不认识的模式/位深按不可用处理。 */
export function specFromKernelSettings(settings: unknown): NewDocumentSpec | null {
  if (!isRecord(settings)) return null;
  const candidate = {
    width: settings.width,
    height: settings.height,
    resolution: settings.resolution,
    mode: settings.mode,
    depth: settings.depth,
    background: settings.background,
    // 引擎把「跟随工具箱颜色」写成 `backgroundColor`；这里不支持，按不可用处理。
    name: "未命名"
  };
  const validated = validateNewDocumentSpec(candidate);
  return validated.ok ? validated.value : null;
}

/** 新建参数 → 内核 `file.new` 参数（不含显示单位与预设名）。 */
export function kernelParamsFromSpec(spec: NewDocumentSpec): Record<string, unknown> {
  return {
    width: spec.width,
    height: spec.height,
    resolution: spec.resolution,
    mode: spec.mode,
    depth: spec.depth,
    background: spec.background,
    name: spec.name
  };
}

/**
 * 保存预设的参数（引擎形状，含显示单位默认值）。
 *
 * 引擎的 `DocumentSettings` 只接受设置字段：`name` 属于预设名（在外层）而不是设置，带上会被
 * 内核以「未知的参数 `name`」整体拒绝。这里显式去掉，并用 `unit` 补上引擎要求的显示单位。
 */
export function presetParams(spec: NewDocumentSpec): Record<string, unknown> {
  const { width, height, resolution, mode, depth, background } = spec;
  return { width, height, resolution, mode, depth, background, unit: "px", resolutionUnit: "in" };
}

/**
 * 最近设置的参数形状。
 *
 * 与预设设置同形：`document.recent.add` 的 `settings` 也不接受 `name`（引擎按 `DocumentSettings`
 * 反序列化），因此不能复用 `kernelParamsFromSpec`。
 */
export function recentSettingsParams(spec: NewDocumentSpec): Record<string, unknown> {
  const { width, height, resolution, mode, depth, background } = spec;
  return { width, height, resolution, mode, depth, background };
}

export type DocumentPresetEntry = { name: string; settings: NewDocumentSpec };

/** 解码 `document.presets.list`：逐条跳过坏条目，保留其余。 */
export function decodePresetList(raw: unknown): DecodeResult<readonly DocumentPresetEntry[]> {
  if (!isRecord(raw) || !Array.isArray(raw.presets)) return { ok: false, error: "预设列表结构非法" };
  const presets: DocumentPresetEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw.presets) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const name = entry.name.trim();
    if (!normalizePresetName(name)) continue;
    const settings = specFromKernelSettings(entry.settings);
    if (!settings) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({ name, settings });
  }
  return { ok: true, value: presets };
}

/** 解码 `document.recent.list`：最新在前、去重、有界。 */
export function decodeRecentList(raw: unknown): DecodeResult<readonly NewDocumentSpec[]> {
  if (!isRecord(raw) || !Array.isArray(raw.recent)) return { ok: false, error: "最近设置结构非法" };
  const recent: NewDocumentSpec[] = [];
  for (const entry of raw.recent) {
    const settings = specFromKernelSettings(entry);
    if (!settings || !canReplayDocumentSpec(settings)) continue;
    if (recent.some((existing) => existing.width === settings.width && existing.height === settings.height
      && existing.resolution === settings.resolution && existing.background === settings.background)) continue;
    recent.push(settings);
    if (recent.length >= NEW_DOCUMENT_LIMITS.maxRecent) break;
  }
  return { ok: true, value: recent };
}

const CAMERA_FIELDS = ["make", "model", "dateTaken", "exposure", "fNumber", "iso", "focalLength", "focalLength35mm", "lens"] as const;

/** 解码 `file.fileInfo` 的读取结果：未知字段丢弃，长度超限整体拒绝。 */
export function decodeFileInfo(raw: unknown): DecodeResult<FileInfo> {
  if (!isRecord(raw)) return { ok: false, error: "File Info 结构非法" };
  const info: FileInfo = {};
  for (const field of FILE_INFO_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (field === "keywords") {
      if (!Array.isArray(value)) {
        // 引擎会把单串按 ; / , 拆开；非数组且非字符串时说明结构变了，明确拒绝。
        if (typeof value !== "string") return { ok: false, error: "File Info 关键字结构非法" };
        info.keywords = value.split(/[;,]/).map((item) => item.trim()).filter(Boolean).slice(0, FILE_INFO_LIMITS.maxKeywords);
        continue;
      }
      const keywords = value.filter((item): item is string => typeof item === "string" && item.length <= FILE_INFO_LIMITS.maxKeywordChars);
      info.keywords = keywords.slice(0, FILE_INFO_LIMITS.maxKeywords);
      continue;
    }
    if (typeof value !== "string") return { ok: false, error: "File Info 字段结构非法" };
    if (value.length > FILE_INFO_LIMITS.maxFieldChars) return { ok: false, error: "File Info 字段超长" };
    info[field as Exclude<FileInfoField, "keywords">] = value;
  }
  if (isRecord(raw.camera)) {
    const camera: NonNullable<FileInfo["camera"]> = {};
    for (const field of CAMERA_FIELDS) {
      const value = raw.camera[field];
      if (typeof value === "string" && value.length <= FILE_INFO_LIMITS.maxFieldChars) camera[field] = value;
    }
    if (Object.keys(camera).length > 0) info.camera = camera;
  }
  return { ok: true, value: info };
}

/** 解码 `restoreSavedBaseline` 报告。 */
export type RestoreReport = { width: number; height: number; layers: number; revision: number; documentContentHash: string; restored: boolean };

export function decodeRestoreReport(raw: unknown): DecodeResult<RestoreReport> {
  if (!isRecord(raw)) return { ok: false, error: "恢复结果不是对象" };
  const width = numberOf(raw.width);
  const height = numberOf(raw.height);
  const layers = numberOf(raw.layers);
  const revision = numberOf(raw.revision);
  if (width === null || height === null || layers === null || revision === null) {
    return { ok: false, error: "恢复结果缺少尺寸/层数/修订" };
  }
  return {
    ok: true,
    value: {
      restored: raw.restored === true,
      width,
      height,
      layers,
      revision,
      documentContentHash: typeof raw.documentContentHash === "string" ? raw.documentContentHash : ""
    }
  };
}

/** 把 File Info 读取结果转成表单值（关键字用分号拼接，便于单行编辑）。 */
export function fileInfoToForm(info: FileInfo): Record<string, string> {
  const form: Record<string, string> = {};
  for (const field of FILE_INFO_FIELDS) {
    const value = info[field];
    if (value === undefined) continue;
    form[field] = Array.isArray(value) ? value.join("; ") : String(value);
  }
  return form;
}

/** 表单值 → 内核写入参数；关键字按分号拆分并去空白。空表单表示只读。 */
export function formToFileInfoPatch(form: Record<string, string>): DecodeResult<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  for (const field of FILE_INFO_FIELDS) {
    const raw = form[field];
    if (raw === undefined) continue;
    if (field === "keywords") {
      patch.keywords = raw.split(";").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    patch[field] = raw;
  }
  const validated = validateFileInfoPatch(patch);
  return validated.ok ? { ok: true, value: { ...validated.value } } : { ok: false, error: validated.error };
}

/**
 * 两份表单在**内核可观察语义**上是否相同（用于「无变化不新增历史」的界面提示）。
 *
 * 比较转换后的写入参数而不是原始字符串：`"a; b"` 与 `"a;b"` 会落成同一个关键字数组，
 * 若按原文比较就会把「其实没改」误报成一次写入。转换失败的两份表单按不同处理（宁可多说一次写入）。
 */
export function sameFileInfoForm(left: Record<string, string>, right: Record<string, string>): boolean {
  const a = formToFileInfoPatch(left);
  const b = formToFileInfoPatch(right);
  if (!a.ok || !b.ok) return false;
  const normalize = (patch: Record<string, unknown>) =>
    JSON.stringify(
      FILE_INFO_FIELDS.map((field) => {
        const value = patch[field];
        // 缺失、空串与纯空白在内核里读回来都是空值，因此语义等价。
        if (field === "keywords") {
          const items = Array.isArray(value) ? value : [];
          return items.map((item) => String(item).trim()).filter(Boolean);
        }
        return typeof value === "string" ? value.trim() : "";
      })
    );
  return normalize(a.value) === normalize(b.value);
}

/** 新建参数是否与内核「当前没有文档」的候选槽位语义相符。 */
export function canCreateInSession(hasDocument: boolean): { ok: true } | { ok: false; reason: string } {
  return hasDocument
    ? { ok: false, reason: "当前编辑会话已有文档：新建需要工作区创建独立文档槽位（宿主端口未提供）" }
    : { ok: true };
}
