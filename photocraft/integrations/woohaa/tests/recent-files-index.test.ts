/**
 * 宿主最近文件索引回归（change: 2026-10-22-add-photocraft-file-workflows，U04）。
 *
 * 断言宿主侧只记「身份与大小」、坏快照的降级、写失败不谎称已保存，以及
 * 释放字节后记录可被同一条规则清除（重开前置由协议域的纯规则判定）。
 */
import { describe, expect, it, vi } from "vitest";
import { RecentFilesIndex, RECENT_FILES_STORAGE_KEY, planReleasedBytes, recentEntryOf, trackDocumentWhenReady } from "../src/recent-files-index.js";
import { DocumentWorkspaceStore, INITIAL_WORKSPACE_UI } from "../src/workspace-store.js";
import { planReopenRecent } from "@woohaa3/photocraft-protocol";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  let failWrites = false;
  return {
    getItem: () => value,
    setItem: (_key: string, text: string) => {
      if (failWrites) throw new Error("quota");
      value = text;
    },
    removeItem: () => { value = null; },
    read: () => value,
    failWrites: (next: boolean) => { failWrites = next; }
  };
}

const bytes = (length: number) => new Uint8Array(length);

describe("从字节持有构造索引记录", () => {
  it("保留身份与大小，不复制内容", () => {
    const entry = recentEntryOf({ id: "doc-1", name: "海报.pcraft", width: 800.4, height: 600, bytes: bytes(2048), savedAt: 7 });
    expect(entry).toEqual({ id: "doc-1", name: "海报.pcraft", width: 800, height: 600, byteLength: 2048, savedAt: 7 });
    expect(JSON.stringify(entry)).not.toContain("0,0");
  });

  it.each([
    { label: "空字节", input: { id: "a", name: "a.pcraft", width: 1, height: 1, bytes: bytes(0) } },
    { label: "空名", input: { id: "a", name: "   ", width: 1, height: 1, bytes: bytes(4) } },
    { label: "无 id", input: { id: "", name: "a.pcraft", width: 1, height: 1, bytes: bytes(4) } },
    { label: "零尺寸", input: { id: "a", name: "a.pcraft", width: 0, height: 1, bytes: bytes(4) } }
  ])("$label 不产生记录（不猜默认值）", ({ input }) => {
    expect(recentEntryOf(input)).toBeNull();
  });
});

describe("最近文件索引", () => {
  it("记录后立即出现在快照里，并通知订阅者", () => {
    const index = new RecentFilesIndex(null);
    let notified = 0;
    index.subscribe(() => { notified += 1; });
    expect(index.record({ id: "doc-1", name: "海报.pcraft", width: 800, height: 600, bytes: bytes(16) })).not.toBeNull();
    expect(index.snapshot().entries.map((entry) => entry.id)).toEqual(["doc-1"]);
    expect(notified).toBe(1);
  });

  it("同一宿主 id 重复记录只更新一条", () => {
    const index = new RecentFilesIndex(null);
    index.record({ id: "doc-1", name: "海报.pcraft", width: 800, height: 600, bytes: bytes(16), savedAt: 1 });
    index.record({ id: "doc-1", name: "海报.pcraft", width: 1024, height: 768, bytes: bytes(32), savedAt: 2 });
    expect(index.snapshot().entries).toHaveLength(1);
    expect(index.snapshot().entries[0]).toMatchObject({ width: 1024, byteLength: 32 });
  });

  it("第 9 条以外的旧记录按协议预算逐出；移除后重开判定立即变成 not-found", () => {
    const index = new RecentFilesIndex(null);
    for (let count = 0; count < 20; count += 1) {
      index.record({ id: `doc-${count}`, name: `第${count}.pcraft`, width: 100, height: 100, bytes: bytes(8), savedAt: count });
    }
    const entries = index.snapshot().entries;
    expect(entries.length).toBeLessThan(20);
    expect(entries[0]!.id).toBe("doc-19");
    index.remove("doc-19");
    expect(planReopenRecent(index.snapshot(), "doc-19", { hasBytes: true, busy: false })).toMatchObject({ ok: false, code: "not-found" });
  });

  it("本机持久化往返：重开新实例仍能读到记录", () => {
    const storage = memoryStorage();
    const first = new RecentFilesIndex(storage);
    first.record({ id: "doc-1", name: "海报.pcraft", width: 800, height: 600, bytes: bytes(16) });
    const second = new RecentFilesIndex(storage);
    expect(second.snapshot().entries.map((entry) => entry.id)).toEqual(["doc-1"]);
    expect(storage.read()).toContain("doc-1");
  });

  it("坏快照被丢弃并说明原因，从空列表开始", () => {
    const storage = memoryStorage("{not json");
    const index = new RecentFilesIndex(storage);
    expect(index.snapshot().entries).toEqual([]);
    expect(index.lastError).toContain("最近文件记录已损坏");
    expect(storage.read()).toBeNull();
  });

  it("写失败不谎称已保存：内存仍可用，错误可见", () => {
    const storage = memoryStorage();
    const index = new RecentFilesIndex(storage);
    storage.failWrites(true);
    index.record({ id: "doc-1", name: "海报.pcraft", width: 800, height: 600, bytes: bytes(16) });
    expect(index.snapshot().entries).toHaveLength(1);
    expect(index.lastError).toContain("仅在本次会话保留");
    expect(RECENT_FILES_STORAGE_KEY).toBe("woohaa.photocraft.recent-files.v1");
  });
});

describe("字节保留预算（重开依赖它，所以必须收敛）", () => {
  it("只在最近记录里、且已关闭的字节可以释放", () => {
    expect(planReleasedBytes({
      bytes: ["closed-unrecorded", "closed-recorded", "still-open"],
      recorded: ["closed-recorded"],
      open: ["still-open"]
    })).toEqual(["closed-unrecorded"]);
  });

  it("仍在打开的文档即使没有记录也不释放（保存/导出还要用）", () => {
    expect(planReleasedBytes({ bytes: ["doc-1"], recorded: [], open: ["doc-1"] })).toEqual([]);
  });

  it("被预算逐出的记录让对应字节立刻可释放（不会无限留内存）", () => {
    const index = new RecentFilesIndex(null);
    // 逐条记录超过条数上限，最早的会被逐出。
    for (let count = 0; count < 20; count += 1) {
      index.record({ id: `doc-${count}`, name: `${count}.pcraft`, width: 10, height: 10, bytes: bytes(4), savedAt: count });
    }
    const recorded = index.snapshot().entries.map((entry) => entry.id);
    expect(recorded).not.toContain("doc-0");
    expect(planReleasedBytes({ bytes: ["doc-0", "doc-19"], recorded, open: [] })).toEqual(["doc-0"]);
  });

  it("用户移除记录后字节可释放", () => {
    const index = new RecentFilesIndex(null);
    index.record({ id: "doc-1", name: "海报.pcraft", width: 10, height: 10, bytes: bytes(4) });
    index.remove("doc-1");
    expect(planReleasedBytes({ bytes: ["doc-1"], recorded: index.snapshot().entries.map((e) => e.id), open: [] }))
      .toEqual(["doc-1"]);
  });
});

describe("工作区快照带最近文件（没有活动文档时也要能重开）", () => {
  it("初始快照是合法空索引，而不是 undefined", () => {
    expect(INITIAL_WORKSPACE_UI.recentFiles).toEqual({ version: 1, entries: [] });
    expect(new DocumentWorkspaceStore().getSnapshot().recentFiles.entries).toEqual([]);
  });

  it("索引更新会通知订阅者（面板不是只在打开文档时才刷新）", () => {
    const store = new DocumentWorkspaceStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const index = new RecentFilesIndex(null);
    index.record({ id: "doc-1", name: "海报.pcraft", width: 10, height: 10, bytes: bytes(4) });
    store.update({ recentFiles: index.snapshot() });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().recentFiles.entries[0]!.id).toBe("doc-1");
    // 同一引用不重复发布（useSyncExternalStore 的稳定性要求）。
    store.update({ recentFiles: index.snapshot() });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("等内核真正打开后再记录（否则每一条最近文件都会静默漏掉）", () => {
  function fakeController(initiallyOpen: boolean) {
    let open = initiallyOpen;
    const listeners = new Set<() => void>();
    return {
      controller: {
        currentView: () => ({ document: open ? { width: 100, height: 80 } : null }),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }
      },
      /** 模拟内核打开完成。 */
      open: () => { open = true; for (const listener of [...listeners]) listener(); },
      listeners
    };
  }

  it("视图已经就绪时立即记录，不订阅", () => {
    const fake = fakeController(true);
    const onReady = vi.fn();
    trackDocumentWhenReady(fake.controller, onReady);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(fake.listeners.size).toBe(0);
  });

  it("视图未就绪时等打开完成再记录一次，并自动退订", () => {
    const fake = fakeController(false);
    const onReady = vi.fn();
    trackDocumentWhenReady(fake.controller, onReady);
    expect(onReady).not.toHaveBeenCalled();
    fake.open();
    expect(onReady).toHaveBeenCalledTimes(1);
    // 后续修订变化不得重复记录。
    fake.open();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(fake.listeners.size).toBe(0);
  });

  it("取消后不再记录（文档在打开前被关闭/发布）", () => {
    const fake = fakeController(false);
    const onReady = vi.fn();
    const cancel = trackDocumentWhenReady(fake.controller, onReady);
    cancel();
    fake.open();
    expect(onReady).not.toHaveBeenCalled();
    expect(fake.listeners.size).toBe(0);
  });
});
