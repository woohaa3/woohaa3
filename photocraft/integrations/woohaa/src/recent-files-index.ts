/**
 * 宿主的最近文件索引适配
 * （change: 2026-10-22-add-photocraft-file-workflows，U04）。
 *
 * 归属划分：索引的**数据契约**（版本化快照、去重、逐出预算、重开前置判定）在协议域
 * `@woohaa3/photocraft-protocol`；本模块只做宿主侧的两件事：
 *
 * 1. 把「文档打开/保存后仍持有字节」的事实翻译成一条索引记录（读画布尺寸由调用方给）；
 * 2. 提供本机持久化端口（`localStorage`），写失败如实降级为「仅本次会话」。
 *
 * 字节**不**在这里：`fileBytes` 仍由插件持有，索引只记身份与大小。这样浏览器刷新后
 * 记录还在、字节没了——界面据此显示「需重新选择」，而不是假装能重开。
 */
import {
  MAX_RECENT_FILE_BYTES,
  RECENT_FILE_STORE_VERSION,
  emptyRecentFileStore,
  encodeRecentFileStore,
  parseRecentFileStore,
  recordRecentFile,
  removeRecentFile,
  type RecentFileEntry,
  type RecentFileStore
} from "@woohaa3/photocraft-protocol";

const STORAGE_KEY = "woohaa.photocraft.recent-files.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 从一次真实的字节持有构造索引记录。
 *
 * 拒绝而不是猜测：字节为空/超单项预算、名字为空、尺寸无效时返回 `null`，调用方跳过记录。
 * 这里不做「大概能用」的补默认值——一条错误的最近记录会把用户引到打不开的条目上。
 */
export function recentEntryOf(input: {
  id: string;
  name: string;
  width: number;
  height: number;
  bytes: Uint8Array;
  savedAt?: number;
}): RecentFileEntry | null {
  const name = input.name.trim();
  if (!name || !input.id.trim()) return null;
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) return null;
  if (input.bytes.length > MAX_RECENT_FILE_BYTES) return null;
  const width = Math.round(input.width);
  const height = Math.round(input.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return {
    id: input.id,
    name,
    width,
    height,
    byteLength: input.bytes.length,
    savedAt: input.savedAt ?? Date.now()
  };
}

/**
 * 最近文件索引（内存 + 可选本机持久化）。
 *
 * 写失败不改内存状态、不抛错，只把 `lastError` 置为可见原因；界面据此提示「仅本次会话」。
 */
export class RecentFilesIndex {
  private store: RecentFileStore = emptyRecentFileStore();
  private readonly storage: StorageLike | null;
  private readonly listeners = new Set<() => void>();
  lastError: string | null = null;

  constructor(storage: StorageLike | null = defaultStorage()) {
    this.storage = storage;
    this.load();
  }

  snapshot(): RecentFileStore {
    return this.store;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 记录一次真实持有的文件。
   *
   * `bytes` 必须仍在宿主手里；调用方在释放字节时要同时 {@link remove}，否则界面会显示
   * 一条点不开的记录（这正是「最近项说明是否能直接重开」要避免的）。
   */
  record(input: Parameters<typeof recentEntryOf>[0]): RecentFileEntry | null {
    const entry = recentEntryOf(input);
    if (!entry) return null;
    this.commit(recordRecentFile(this.store, entry));
    return entry;
  }

  remove(id: string): void {
    const next = removeRecentFile(this.store, id);
    if (next === this.store) return;
    this.commit(next);
  }

  private commit(next: RecentFileStore): void {
    this.store = next;
    this.persist();
    for (const listener of this.listeners) listener();
  }

  private load(): void {
    if (!this.storage) return;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(STORAGE_KEY);
    } catch {
      this.lastError = "无法读取本机最近文件记录";
      return;
    }
    if (!raw) return;
    const decoded = parseRecentFileStore(raw);
    if (!decoded.ok) {
      // 坏快照不清空用户数据以外的任何内容；这里只丢弃索引本身并说明原因。
      this.lastError = `最近文件记录已损坏或不兼容（${decoded.error}），已从空列表开始`;
      try {
        this.storage.removeItem(STORAGE_KEY);
      } catch {
        // 清理失败不影响使用。
      }
      return;
    }
    this.store = decoded.value;
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, encodeRecentFileStore(this.store));
      this.lastError = null;
    } catch {
      this.lastError = "本机最近文件记录保存失败（存储不可用或已满）：仅在本次会话保留";
    }
  }
}

/**
 * 等内核真正打开文档后再记录（打开路径只拿到字节，控制器是异步建好的）。
 *
 * 打开文件时 `currentView().document` 还是 null：此刻直接记录会**静默漏掉**每一条最近
 * 文件（记录函数拿不到真实画布尺寸，按设计拒绝记录）。这里等第一份带文档的视图出现，
 * 再交给调用方记录一次，然后自动退订。
 *
 * 返回取消函数：文档在视图出现前被关闭/发布时必须调用它，否则会记录一条已不存在的文档。
 */
export function trackDocumentWhenReady(
  controller: {
    currentView(): { document: unknown | null };
    subscribe(listener: () => void): () => void;
  },
  onReady: () => void
): () => void {
  if (controller.currentView().document) {
    onReady();
    return () => undefined;
  }
  let active = true;
  const unsubscribe = controller.subscribe(() => {
    if (!active) return;
    if (!controller.currentView().document) return;
    active = false;
    unsubscribe();
    onReady();
  });
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
  };
}

/**
 * 哪些字节应当释放（最近文件索引的预算收敛）。
 *
 * 宿主把已打开文件的字节留在内存里，是为了让「最近文件 ▸ 重开」真的用原字节打开，
 * 而不是让用户重新选文件。但这份保留必须有界，否则关掉一小时的文档仍占着内存：
 *
 * - **仍在打开**的文档一律保留（保存/导出/发布都要用）；
 * - 有最近记录的保留（重开入口依赖它）；
 * - 两者都不是 → 释放。
 *
 * 返回的是**要删的 id**（调用方持有实际 Map），这样规则可单测，宿主只管 delete。
 */
export function planReleasedBytes(input: {
  bytes: Iterable<string>;
  recorded: Iterable<string>;
  open: Iterable<string>;
}): string[] {
  const recorded = new Set(input.recorded);
  const open = new Set(input.open);
  const released: string[] = [];
  for (const id of input.bytes) {
    if (recorded.has(id) || open.has(id)) continue;
    released.push(id);
  }
  return released;
}

/** 存储键（宿主与测试共用；不导出内部实现）。 */
export const RECENT_FILES_STORAGE_KEY = STORAGE_KEY;

/** 版本号再导出，便于宿主显示「已升级记录格式」类提示。 */
export { RECENT_FILE_STORE_VERSION };
