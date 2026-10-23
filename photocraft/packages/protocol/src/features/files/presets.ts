/**
 * 新建预设与最近设置的版本化本机编解码（本域纯数据）
 * （change: 2026-10-22-add-photocraft-file-workflows，U04 / design D3）。
 *
 * 上游把预设与最近设置存在偏好里；浏览器侧没有偏好文件，因此本域用**版本化快照**交给宿主
 * 存储端口。读取时逐条校验：坏条目被丢弃、其余保留（与上游 `document_preset_cmds::load` 一致），
 * 版本不认识时整体不可用并由调用方显示「仅本次会话」。
 */
import {
  NEW_DOCUMENT_LIMITS,
  normalizePresetName,
  validateNewDocumentSpec,
  type DocumentPreset,
  type NewDocumentSpec
} from "./document-spec.js";

/** 快照版本：字段含义变化时递增，旧版本整体拒绝而不是猜字段。 */
export const DOCUMENT_PRESET_STORE_VERSION = 1;

export type DocumentPresetStore = {
  version: typeof DOCUMENT_PRESET_STORE_VERSION;
  /** 新建预设（名称唯一，忽略 ASCII 大小写）。 */
  presets: DocumentPreset[];
  /** 最近的新建设置，最新在前。 */
  recent: NewDocumentSpec[];
};

export type DecodePresetStoreResult =
  | { ok: true; value: DocumentPresetStore }
  | { ok: false; error: string };

/** 空快照（首次使用或读取失败后的安全起点）。 */
export function emptyDocumentPresetStore(): DocumentPresetStore {
  return { version: DOCUMENT_PRESET_STORE_VERSION, presets: [], recent: [] };
}

function specOf(value: unknown): NewDocumentSpec | null {
  const result = validateNewDocumentSpec(value);
  return result.ok ? result.value : null;
}

function sameSettings(a: NewDocumentSpec, b: NewDocumentSpec): boolean {
  return a.width === b.width && a.height === b.height && a.resolution === b.resolution
    && a.mode === b.mode && a.depth === b.depth && a.background === b.background;
}

/**
 * 解码版本化快照。
 *
 * 逐条独立校验：损坏的预设/最近项被跳过而不是让整个存储不可用；名称大小写重复与设置重复
 * 都折叠成第一条（与上游行为一致）。
 */
export function decodeDocumentPresetStore(input: unknown): DecodePresetStoreResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "本机预设存储不是对象" };
  }
  const value = input as Record<string, unknown>;
  if (value.version !== DOCUMENT_PRESET_STORE_VERSION) {
    return { ok: false, error: `本机预设存储版本不支持（${String(value.version)}）` };
  }
  const presets: DocumentPreset[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(value.presets) ? value.presets : []) {
    if (presets.length >= NEW_DOCUMENT_LIMITS.maxPresets) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = normalizePresetName(record.name);
    const settings = specOf(record.settings);
    if (!name || !settings) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({ name, settings });
  }
  const recent: NewDocumentSpec[] = [];
  for (const entry of Array.isArray(value.recent) ? value.recent : []) {
    if (recent.length >= NEW_DOCUMENT_LIMITS.maxRecent) break;
    const settings = specOf(entry);
    if (!settings) continue;
    if (recent.some((existing) => sameSettings(existing, settings))) continue;
    recent.push(settings);
  }
  return { ok: true, value: { version: DOCUMENT_PRESET_STORE_VERSION, presets, recent } };
}

/**
 * 本机预设/最近设置的存储端口
 * （change: 2026-10-22-add-photocraft-file-workflows，U04 / design D3）。
 *
 * 上游把新建预设与最近设置存在偏好文件里；浏览器没有偏好文件，因此这里只声明
 * 「读一段文本 / 写一段文本」的最小端口，编码与逐条校验都在本域纯数据里完成
 * （与 `BrushLibraryStorage` 同形的既有约定，不新造第二套存储抽象）。
 *
 * 失败必须如实返回 `"failed"`：调用方据此显示「仅本次会话」，**不得**因为写失败就假装已保存。
 */
export type DocumentPresetStorage = {
  load(): Promise<string | null>;
  save(text: string): Promise<"saved" | "failed">;
};

/** 浏览器本地存储适配（`localStorage`）；不可用或配额失败时抛错由调用方降级。 */
export function createLocalDocumentPresetStorage(key = "woohaa.photocraft.document-presets.v1"): DocumentPresetStorage {
  return {
    load: async () => {
      try {
        return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    save: async (text) => {
      try {
        if (typeof localStorage === "undefined") return "failed";
        localStorage.setItem(key, text);
        return "saved";
      } catch {
        // 配额/隐私模式：明确失败，让界面提示「仅本次会话」。
        return "failed";
      }
    }
  };
}

/**
 * 从任意 JSON 文本解码；解析失败明确报错而不是返回空快照冒充「没有预设」。
 */
export function parseDocumentPresetStore(text: string): DecodePresetStoreResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "本机预设存储不是合法 JSON" };
  }
  return decodeDocumentPresetStore(parsed);
}

/** 编码为可持久化的 JSON 文本（只写版本化信封，不含显示状态）。 */
export function encodeDocumentPresetStore(store: DocumentPresetStore): string {
  return JSON.stringify({
    version: DOCUMENT_PRESET_STORE_VERSION,
    presets: store.presets.map((preset) => ({ name: preset.name, settings: preset.settings })),
    recent: store.recent.map((settings) => ({ ...settings }))
  });
}

/** 保存预设：名称唯一（ASCII 大小写）、数量有界；成功返回新快照，不修改入参。 */
export function addDocumentPreset(
  store: DocumentPresetStore,
  nameInput: unknown,
  settingsInput: unknown
): { ok: true; value: DocumentPresetStore } | { ok: false; error: string } {
  const name = normalizePresetName(nameInput);
  if (!name) return { ok: false, error: `预设名去空白后必须是 1–${NEW_DOCUMENT_LIMITS.maxNameChars} 个字符` };
  const settings = specOf(settingsInput);
  if (!settings) return { ok: false, error: "预设设置不合法" };
  if (store.presets.some((preset) => preset.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `已存在名为「${name}」的预设，请换一个名称` };
  }
  if (store.presets.length >= NEW_DOCUMENT_LIMITS.maxPresets) {
    return { ok: false, error: `最多保存 ${NEW_DOCUMENT_LIMITS.maxPresets} 个新建预设` };
  }
  return { ok: true, value: { ...store, presets: [...store.presets, { name, settings }] } };
}

/** 删除预设（按名称，忽略 ASCII 大小写）；不存在时明确失败而不是静默成功。 */
export function removeDocumentPreset(
  store: DocumentPresetStore,
  nameInput: unknown
): { ok: true; value: DocumentPresetStore } | { ok: false; error: string } {
  const name = normalizePresetName(nameInput);
  if (!name) return { ok: false, error: "缺少预设名" };
  const remaining = store.presets.filter((preset) => preset.name.toLowerCase() !== name.toLowerCase());
  if (remaining.length === store.presets.length) return { ok: false, error: `没有名为「${name}」的预设` };
  return { ok: true, value: { ...store, presets: remaining } };
}

/** 记录一次新建设置：去重后放到最前，超过上限丢弃最旧。 */
export function recordRecentDocument(store: DocumentPresetStore, settingsInput: unknown): DocumentPresetStore {
  const settings = specOf(settingsInput);
  if (!settings) return store;
  const recent = [settings, ...store.recent.filter((existing) => !sameSettings(existing, settings))];
  return { ...store, recent: recent.slice(0, NEW_DOCUMENT_LIMITS.maxRecent) };
}

/**
 * 最近项能否直接重开。
 *
 * 这里只声明设置本身是否仍然合法；**字节**由宿主最近的工程/文件引用持有，缺失时界面要求
 * 用户重新选择文件——不把浏览器文件名当成路径权限。
 */
export function canReopenRecent(settings: NewDocumentSpec): boolean {
  return validateNewDocumentSpec(settings).ok;
}
