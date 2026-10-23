/**
 * 导出预设（change: 2026-10-22-add-photocraft-raster-interchange，design D3）。
 *
 * 预设是**本域本机设置**：只影响下次打开的导出参数，不进入文档内容、不进内容指纹、不进
 * `.pcraft`。因此这里不读写工程，只提供一层内存 + 宿主存储的组合：
 *
 * - 纯函数 `normalizePresetList` 做有界/唯一性/合法性校验（与协议包同一份规则）；
 * - `ExportPresetStore` 在可用时用 `localStorage` 持久化，坏数据**丢弃并回退到内置预设**，
 *   而不是让编辑器打不开；
 * - 内置预设与内核 `web_cmds::PRESETS` 的常用项对应，但不冒充全部上游预设。
 */
import {
  INTERCHANGE_BUDGETS,
  decodeExportPresets,
  type ExportPreset,
  type ExportSettings
} from "@woohaa3/photocraft-protocol";

/** 内置预设（每次启动都在；用户预设追加在后面并可删除）。 */
export const BUILTIN_EXPORT_PRESETS: readonly ExportPreset[] = [
  { name: "JPEG 高", settings: { mode: "export", format: "jpg", quality: 90, chromaSubsampling: true, metadata: "none" } },
  { name: "JPEG 中", settings: { mode: "export", format: "jpg", quality: 60, chromaSubsampling: true, metadata: "none" } },
  { name: "WebP 有损", settings: { mode: "export", format: "webp", webpLossless: false, webpQuality: 80, metadata: "none" } },
  { name: "WebP 无损", settings: { mode: "export", format: "webp", webpLossless: true, metadata: "none" } },
  { name: "TIFF LZW", settings: { mode: "export", format: "tif", tiffCompression: "lzw", metadata: "none" } },
  { name: "PNG 优化", settings: { mode: "export", format: "png", pngCompression: "best", metadata: "none" } },
  { name: "网页 PNG-24", settings: { mode: "web", format: "png24", transparency: true, metadata: "none" } },
  { name: "网页 GIF 128", settings: { mode: "web", format: "gif", colors: 128, dither: "diffusion", ditherAmount: 88 } }
];

/** 用户预设条数上限（内置预设不吃这个额度，但总数仍有界）。 */
export const MAX_USER_PRESETS = INTERCHANGE_BUDGETS.maxExportPresets;

/** 校验用户预设；非法项整体拒绝（不做「尽力保留一半」）。 */
export function normalizePresetList(raw: unknown): { ok: true; value: ExportPreset[] } | { ok: false; message: string } {
  return decodeExportPresets(raw);
}

/** 合并内置与用户预设：同名用户预设覆盖内置项，其余保持顺序。 */
export function mergePresets(user: readonly ExportPreset[]): ExportPreset[] {
  const names = new Set(user.map((preset) => preset.name));
  return [...BUILTIN_EXPORT_PRESETS.filter((preset) => !names.has(preset.name)), ...user];
}

const STORAGE_KEY = "photocraft.export-presets.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // 隐私模式/禁用存储：预设仍在本会话可用。
    return null;
  }
}

/**
 * 用户预设存储。
 *
 * 读写都走同一道校验：坏快照（手工改坏、旧版本字段、超限）被**丢弃**而不是抛错，并把原因
 * 记录在 `lastError` 里供界面提示。写失败（配额/禁用）同样不抛，返回布尔。
 */
export class ExportPresetStore {
  private presets: ExportPreset[] = [];
  private readonly storage: StorageLike | null;
  lastError: string | null = null;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
    this.load();
  }

  /** 当前用户预设（不含内置项）。 */
  list(): readonly ExportPreset[] {
    return this.presets;
  }

  /** 内置 + 用户，可直接渲染到下拉框。 */
  all(): readonly ExportPreset[] {
    return mergePresets(this.presets);
  }

  find(name: string): ExportSettings | null {
    return this.all().find((preset) => preset.name === name)?.settings ?? null;
  }

  /** 保存一条预设：同名覆盖，超出上限拒绝。 */
  save(name: string, settings: ExportSettings): boolean {
    const trimmed = name.trim();
    if (!trimmed) {
      this.lastError = "预设名不能为空";
      return false;
    }
    if (trimmed.length > INTERCHANGE_BUDGETS.maxPresetNameLength) {
      this.lastError = `预设名最多 ${INTERCHANGE_BUDGETS.maxPresetNameLength} 个字符`;
      return false;
    }
    const next = this.presets.filter((preset) => preset.name !== trimmed);
    if (next.length >= MAX_USER_PRESETS) {
      this.lastError = `最多保存 ${MAX_USER_PRESETS} 条预设`;
      return false;
    }
    const candidate: ExportPreset = { name: trimmed, settings };
    const validated = decodeExportPresets([...next, candidate]);
    if (!validated.ok) {
      this.lastError = validated.message;
      return false;
    }
    this.presets = validated.value;
    this.lastError = null;
    this.persist();
    return true;
  }

  remove(name: string): boolean {
    if (!this.presets.some((preset) => preset.name === name)) return false;
    this.presets = this.presets.filter((preset) => preset.name !== name);
    this.lastError = null;
    this.persist();
    return true;
  }

  private load(): void {
    if (!this.storage) return;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(STORAGE_KEY);
    } catch {
      this.lastError = "无法读取本机导出预设";
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.lastError = "本机导出预设不是合法 JSON，已回退到内置预设";
      this.clearStorage();
      return;
    }
    const validated = decodeExportPresets(parsed);
    if (!validated.ok) {
      this.lastError = `本机导出预设无效（${validated.message}），已回退到内置预设`;
      this.clearStorage();
      return;
    }
    this.presets = validated.value;
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.presets));
    } catch {
      this.lastError = "本机导出预设保存失败（存储不可用或已满）";
    }
  }

  private clearStorage(): void {
    try {
      this.storage?.removeItem(STORAGE_KEY);
    } catch {
      // 清理失败不影响可用性。
    }
  }
}
