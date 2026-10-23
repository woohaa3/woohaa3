/**
 * 最近文件索引回归（change: 2026-10-22-add-photocraft-file-workflows，U04）。
 *
 * 覆盖：版本化编解码、逐条丢弃坏记录、按 id 去重、条数与累计字节双重预算从最旧逐出、
 * 以及「不能重开」的三种原因必须各自给出下一步（不静默新建、不冒称有路径权限）。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_RECENT_FILES,
  MAX_RECENT_FILE_BYTES,
  MAX_RECENT_TOTAL_BYTES,
  RECENT_FILE_STORE_VERSION,
  decodeRecentFileStore,
  emptyRecentFileStore,
  encodeRecentFileStore,
  parseRecentFileStore,
  heldBytesAfterSave,
  planReopenRecent,
  recordRecentFile,
  removeRecentFile,
  reopenRecentLabel,
  type RecentFileEntry,
  type RecentFileStore
} from "./recent-files.js";

const entry = (id: string, patch: Partial<RecentFileEntry> = {}): RecentFileEntry => ({
  id,
  name: `${id}.pcraft`,
  width: 800,
  height: 600,
  byteLength: 1024,
  savedAt: 1,
  ...patch
});

describe("最近文件索引的编解码", () => {
  it("往返保持身份字段，且不写入任何内容字节", () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("doc-1"));
    const text = encodeRecentFileStore(store);
    expect(text).not.toContain("Uint8Array");
    expect(parseRecentFileStore(text)).toEqual({ ok: true, value: store });
    expect(JSON.parse(text).version).toBe(RECENT_FILE_STORE_VERSION);
  });

  it("版本不认识时整体拒绝，而不是猜字段", () => {
    expect(decodeRecentFileStore({ version: 99, entries: [] })).toMatchObject({ ok: false });
    expect(decodeRecentFileStore(null)).toMatchObject({ ok: false });
    expect(parseRecentFileStore("not json")).toMatchObject({ ok: false, error: "最近文件存储不是合法 JSON" });
  });

  it("逐条跳过坏记录，其余保留", () => {
    const decoded = decodeRecentFileStore({
      version: 1,
      entries: [
        entry("ok-1"),
        { id: "", name: "x.pcraft", width: 1, height: 1, byteLength: 1, savedAt: 1 },
        { id: "no-size", name: "x.pcraft", width: 0, height: 1, byteLength: 1, savedAt: 1 },
        { id: "too-big", name: "x.pcraft", width: 1, height: 1, byteLength: MAX_RECENT_FILE_BYTES + 1, savedAt: 1 },
        { id: "nul\0", name: "x.pcraft", width: 1, height: 1, byteLength: 1, savedAt: 1 },
        entry("ok-1", { name: "重复 id 的第二条" }),
        entry("ok-2")
      ]
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.entries.map((item) => item.id)).toEqual(["ok-1", "ok-2"]);
  });
});

describe("最近文件的记录与预算", () => {
  it("最新在前，同一宿主 id 只保留一条并刷新", () => {
    let store = recordRecentFile(emptyRecentFileStore(), entry("a", { savedAt: 1 }));
    store = recordRecentFile(store, entry("b", { savedAt: 2 }));
    expect(store.entries.map((item) => item.id)).toEqual(["b", "a"]);
    store = recordRecentFile(store, entry("a", { savedAt: 3, width: 1024 }));
    expect(store.entries.map((item) => [item.id, item.savedAt, item.width])).toEqual([["a", 3, 1024], ["b", 2, 800]]);
  });

  it("非法条目被忽略，不产生半条记录", () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("a"));
    expect(recordRecentFile(store, entry("b", { byteLength: 0 }))).toBe(store);
    expect(recordRecentFile(store, entry("", {}))).toBe(store);
  });

  it("条数上限从最旧丢弃，新条目永远保留", () => {
    let store: RecentFileStore = emptyRecentFileStore();
    for (let index = 0; index < MAX_RECENT_FILES + 5; index += 1) {
      store = recordRecentFile(store, entry(`doc-${index}`, { savedAt: index }));
    }
    expect(store.entries).toHaveLength(MAX_RECENT_FILES);
    expect(store.entries[0]!.id).toBe(`doc-${MAX_RECENT_FILES + 4}`);
  });

  it("累计字节预算按最旧逐出，刚打开的那条不会被逐出", () => {
    // 每条都用满单项预算：累计预算只够 3 条，第 4 条起从最旧逐出。
    let store = emptyRecentFileStore();
    for (const id of ["a", "b", "c", "d", "e"]) {
      store = recordRecentFile(store, entry(id, { byteLength: MAX_RECENT_FILE_BYTES }));
    }
    const total = store.entries.reduce((sum, item) => sum + item.byteLength, 0);
    expect(total).toBeLessThanOrEqual(MAX_RECENT_TOTAL_BYTES);
    expect(store.entries[0]!.id).toBe("e");
    expect(store.entries.map((item) => item.id)).toEqual(["e", "d", "c"]);
  });

  it("移除不存在的条目返回同一快照（调用方可据此跳过重渲染）", () => {
    const store = recordRecentFile(emptyRecentFileStore(), entry("a"));
    expect(removeRecentFile(store, "missing")).toBe(store);
    expect(removeRecentFile(store, "a").entries).toEqual([]);
  });
});

describe("重开最近文件的前置判定", () => {
  const store = recordRecentFile(emptyRecentFileStore(), entry("a"));

  it("字节仍在且没有未结算草稿时才允许直接重开", () => {
    expect(planReopenRecent(store, "a", { hasBytes: true, busy: false })).toEqual({ ok: true });
  });

  it("字节已释放时要求重新选择文件，不假装能读磁盘", () => {
    const result = planReopenRecent(store, "a", { hasBytes: false, busy: false });
    expect(result).toMatchObject({ ok: false, code: "bytes-released" });
    if (result.ok) return;
    expect(result.reason).toContain("重新选择");
  });

  it("有未结算草稿时拒绝并说明，不替用户丢弃内容", () => {
    expect(planReopenRecent(store, "a", { hasBytes: true, busy: true })).toMatchObject({ ok: false, code: "document-busy" });
  });

  it("记录已不存在时明确失败", () => {
    expect(planReopenRecent(store, "gone", { hasBytes: true, busy: false })).toMatchObject({ ok: false, code: "not-found" });
  });
});

describe("重开按钮文案：字节不在与需要先结算是两件不同的事", () => {
  const store = recordRecentFile(emptyRecentFileStore(), entry("a"));

  it("可以直接重开时显示「重开」", () => {
    expect(reopenRecentLabel(planReopenRecent(store, "a", { hasBytes: true, busy: false }))).toBe("重开");
  });

  it("字节已释放时显示「需重新选择」", () => {
    expect(reopenRecentLabel(planReopenRecent(store, "a", { hasBytes: false, busy: false }))).toBe("需重新选择");
  });

  it("有未结算草稿时仍是「重开」（字节还在，下一步是先结算而不是重新选文件）", () => {
    const plan = planReopenRecent(store, "a", { hasBytes: true, busy: true });
    expect(plan).toMatchObject({ code: "document-busy" });
    expect(reopenRecentLabel(plan)).toBe("重开");
  });
});

describe("保存工程后的重开字节：不能让重开打开保存前的旧内容", () => {
  const project = new Uint8Array([7, 7, 7]);

  it("同一修订的冻结产物替换宿主字节", () => {
    // 打开时留下的是打开那一刻的字节；保存后磁盘内容已前进，记录仍指向旧内容。
    expect(heldBytesAfterSave({ currentRevision: 5, frozen: { revision: 5, project } })).toBe(project);
  });

  it("编辑过但未保存时不替换（冻结产物不对应当前画面）", () => {
    expect(heldBytesAfterSave({ currentRevision: 6, frozen: { revision: 5, project } })).toBeNull();
  });

  it("没有冻结产物或没有文档时保持原字节不动", () => {
    expect(heldBytesAfterSave({ currentRevision: 5, frozen: null })).toBeNull();
    expect(heldBytesAfterSave({ currentRevision: null, frozen: { revision: 1, project } })).toBeNull();
  });

  it("空字节不替换（否则重开会变成打不开）", () => {
    expect(heldBytesAfterSave({ currentRevision: 2, frozen: { revision: 2, project: new Uint8Array() } })).toBeNull();
  });
});
