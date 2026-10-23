/**
 * 编辑器「最近文件」索引（本域纯数据）
 * （change: 2026-10-22-add-photocraft-file-workflows，U04 / design D3）。
 *
 * 与「最近的新建设置」不同：最近**文件**指向真实内容字节，因此必须同时回答两件事：
 *
 * 1. 这条记录还**能不能直接重开**（宿主是否仍持有字节引用）；
 * 2. 不能时要**明说需要重新选择文件**，不能把浏览器 `File.name` 当成路径权限去假装重开。
 *
 * 归属：索引是编辑器簿记（本机、版本化、不进 `.pcraft`、不改内容指纹/修订/未保存状态）；
 * **字节**由宿主持有（浏览器不授予路径权限，本域不复制、不缓存文件内容）。这里只存
 * 「身份 + 可核对的尺寸/字节数」，不存任何像素或工程字节。
 */
import { IMAGE_PROJECT_LIMITS } from "../../image-edit.js";

/** 快照版本：字段含义变化时递增；旧版本整体拒绝而不是猜字段。 */
export const RECENT_FILE_STORE_VERSION = 1;

/** 最近文件条数上限（与 8 个文档槽位解耦：关闭后仍可重开的都是历史记录）。 */
export const MAX_RECENT_FILES = 12;

/** 单条记录允许的最大工程字节数：与工程单项预算同源，不另立上限。 */
export const MAX_RECENT_FILE_BYTES = IMAGE_PROJECT_LIMITS.maxProjectBytes;

/**
 * 最近文件累计预算。
 *
 * 为什么是 3 倍单项预算：宿主只在内存里持有有限份字节，累计超预算时**逐出最旧**（不是拒绝
 * 新条目）。取值来自单项预算的整数倍，避免出现「单条能存、两条就一定失败」的荒谬组合。
 */
export const MAX_RECENT_TOTAL_BYTES = 3 * IMAGE_PROJECT_LIMITS.maxProjectBytes;

/** 一条最近文件记录（只含身份与可核对的大小，不含内容）。 */
export type RecentFileEntry = {
  /** 宿主分配的不透明 id（重开时用它取字节；不是路径、不是文件名）。 */
  id: string;
  /** 显示名（含扩展名），仅用于界面。 */
  name: string;
  /** 画布尺寸（重开前即可显示；与真实字节不一致时以内核为准）。 */
  width: number;
  height: number;
  /** 工程字节数（用于累计预算与「文件是否变了」的提示）。 */
  byteLength: number;
  /** 记录时间（毫秒，调用方提供；仅用于排序展示，不参与身份）。 */
  savedAt: number;
};

export type RecentFileStore = {
  version: typeof RECENT_FILE_STORE_VERSION;
  /** 最新在前。 */
  entries: RecentFileEntry[];
};

export type DecodeRecentFileStoreResult =
  | { ok: true; value: RecentFileStore }
  | { ok: false; error: string };

export function emptyRecentFileStore(): RecentFileStore {
  return { version: RECENT_FILE_STORE_VERSION, entries: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** 校验一条记录：id/name 必须非空且有界，尺寸/字节数必须是正整数。 */
function entryOf(value: unknown): RecentFileEntry | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!id || !name || id.length > 200 || name.length > 255) return null;
  if (id.includes("\0") || name.includes("\0")) return null;
  const width = positiveInt(value.width);
  const height = positiveInt(value.height);
  const byteLength = positiveInt(value.byteLength);
  const savedAt = typeof value.savedAt === "number" && Number.isFinite(value.savedAt) && value.savedAt >= 0 ? value.savedAt : null;
  if (width === null || height === null || byteLength === null || savedAt === null) return null;
  if (byteLength > MAX_RECENT_FILE_BYTES) return null;
  return { id, name, width, height, byteLength, savedAt };
}

/**
 * 解码版本化快照。
 *
 * 逐条独立校验：坏记录被跳过（手工改坏、旧字段、超限），其余保留；版本不认识整体拒绝，
 * 由调用方提示「仅本次会话」而不是静默清空。
 */
export function decodeRecentFileStore(input: unknown): DecodeRecentFileStoreResult {
  if (!isRecord(input)) return { ok: false, error: "最近文件存储不是对象" };
  if (input.version !== RECENT_FILE_STORE_VERSION) {
    return { ok: false, error: `最近文件存储版本不支持（${String(input.version)}）` };
  }
  const entries: RecentFileEntry[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(input.entries) ? input.entries : []) {
    if (entries.length >= MAX_RECENT_FILES) break;
    const entry = entryOf(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return { ok: true, value: { version: RECENT_FILE_STORE_VERSION, entries } };
}

export function parseRecentFileStore(text: string): DecodeRecentFileStoreResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "最近文件存储不是合法 JSON" };
  }
  return decodeRecentFileStore(parsed);
}

export function encodeRecentFileStore(store: RecentFileStore): string {
  return JSON.stringify({
    version: RECENT_FILE_STORE_VERSION,
    entries: store.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      width: entry.width,
      height: entry.height,
      byteLength: entry.byteLength,
      savedAt: entry.savedAt
    }))
  });
}

function totalBytes(entries: readonly RecentFileEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.byteLength, 0);
}

/**
 * 记录一次文件（最新在前）。
 *
 * 去重按宿主 id：同一文档重复保存只更新一条并把时间/尺寸刷新，不产生第二行。
 * 逐出规则：先按条数上限截断，再按累计字节预算从**最旧**开始丢弃——新条目永远保留
 * （否则「刚打开的文件立刻不在最近里」）。
 */
export function recordRecentFile(store: RecentFileStore, entry: RecentFileEntry): RecentFileStore {
  const validated = entryOf(entry);
  if (!validated) return store;
  const rest = store.entries.filter((existing) => existing.id !== validated.id);
  let entries = [validated, ...rest].slice(0, MAX_RECENT_FILES);
  while (entries.length > 1 && totalBytes(entries) > MAX_RECENT_TOTAL_BYTES) {
    entries = entries.slice(0, -1);
  }
  return { ...store, entries };
}

/** 移除一条（用户显式清理，或宿主报告字节已释放）。 */
export function removeRecentFile(store: RecentFileStore, id: string): RecentFileStore {
  const entries = store.entries.filter((entry) => entry.id !== id);
  return entries.length === store.entries.length ? store : { ...store, entries };
}

/** 重新打开的结果：拿不到字节时必须是**明确原因**，不能静默回退成新建。 */
export type ReopenRecentResult =
  | { ok: true }
  | { ok: false; code: "bytes-released" | "document-busy" | "not-found"; reason: string };

/**
 * 能否直接重开。
 *
 * `hasBytes` 由宿主回答（它持有内存字节引用）；`busy` 表示当前文档有未结算草稿或正在保存——
 * 此时切换/新开标签会丢掉未提交内容，因此拒绝并说明，而不是替用户丢弃。
 */
export function planReopenRecent(
  store: RecentFileStore,
  id: string,
  state: { hasBytes: boolean; busy: boolean }
): ReopenRecentResult {
  const entry = store.entries.find((item) => item.id === id);
  if (!entry) return { ok: false, code: "not-found", reason: "该文件已不在最近的记录里，请用「打开文件…」重新选择" };
  if (state.busy) {
    return { ok: false, code: "document-busy", reason: "当前文档还有未确认的草稿或正在保存，请先结算再重开最近文件" };
  }
  if (!state.hasBytes) {
    return {
      ok: false,
      code: "bytes-released",
      reason: "该文件的字节已被释放（浏览器不授予路径权限），请用「打开文件…」重新选择"
    };
  }
  return { ok: true };
}

/**
 * 重开按钮的文案。
 *
 * 只有**字节真的不在**时才是「需重新选择」。当前文档有草稿或正在保存时字节还在，若也写
 * 「需重新选择」，用户会以为文件丢了——这是两件不同的事，下一步动作也不同（先结算 vs
 * 重新选文件）。缺记录同理：按钮不可点，但原因由 `planReopenRecent` 自己说明。
 */
export function reopenRecentLabel(plan: ReopenRecentResult): string {
  if (!plan.ok && plan.code === "bytes-released") return "需重新选择";
  return "重开";
}

/**
 * 保存工程后应当用来替换宿主字节的那份内容。
 *
 * 「最近文件 ▸ 重开」用的是宿主内存里的字节。打开时持有的是**打开那一刻**的内容；用户保存
 * 过工程之后，磁盘上的内容已经前进——不同步的话重开会静默打开旧内容（记录还在、名字一样，
 * 画面却是保存前的）。
 *
 * 只接受与**当前修订**一致的冻结产物：编辑过而尚未保存时，冻结产物并不对应当前画面，
 * 拿它去更新会让重开跳到中间状态。返回 `null` 表示保持原字节不动。
 */
export function heldBytesAfterSave(input: {
  /** 当前文档修订（没有文档时为 null）。 */
  currentRevision: number | null;
  /** 最近一次冻结的成对产物（保存成功后仍在）。 */
  frozen: { revision: number; project: Uint8Array } | null;
}): Uint8Array | null {
  const { currentRevision, frozen } = input;
  if (!frozen || currentRevision === null) return null;
  if (frozen.revision !== currentRevision) return null;
  if (!(frozen.project instanceof Uint8Array) || frozen.project.length === 0) return null;
  return frozen.project;
}
